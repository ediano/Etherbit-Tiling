// extension.ts — ponte GNOME Shell ↔ daemon (GNOME 45+ ESM, Wayland).
//
// PONTE BURRA (ver ADR rules/0016): a extensão NÃO desenha nada e NÃO decide layout. Ela apenas
//  - cria/destrói o indicador da barra (controle leve de gaps/autostart) e fala config via D-Bus;
//  - escuta eventos nativos do Mutter (janela criada/fechada, foco, monitores, workspace);
//  - coleta os metadados brutos das janelas + áreas úteis, envia ao daemon (`SyncWindows`) e
//    APLICA os retângulos-alvo devolvidos via `move_resize_frame` (geométrico e instantâneo).
// Toda a matemática (Ether Flow) e a resiliência gráfica vivem no Rust (core/daemon).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
  createTilingProxy,
  parseConfig,
  DEFAULT_CONFIG,
  type TilingConfig,
  type TilingProxy,
} from './dbus.js';
import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parsePreview,
  orderKey,
  appendToOrder,
  removeFromOrder,
  sortByOrder,
  reorderForDrop,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';
import { EtherbitIndicator } from './indicator.js';

/// Período do loop que amostra o cursor durante o arrasto (~60 FPS).
const DRAG_TICK_MS = 16;

/// Janela rastreada: guardamos o id do handler `unmanaged` para desconectar no fechamento.
interface Tracked {
  window: Meta.Window;
  unmanagedId: number;
}

export default class EtherbitTilingExtension extends Extension {
  private _indicator: EtherbitIndicator | null = null;
  private _proxy: TilingProxy | null = null;
  private _config: TilingConfig = { ...DEFAULT_CONFIG };
  private _configChangedId = 0;

  // Sinais do compositor que disparam um novo cálculo de layout.
  private _displayIds: number[] = [];
  private _workspaceId = 0;
  private _monitorsId = 0;

  // Janelas rastreadas (para reagir ao fechamento) e debounce do relayout.
  private _tracked = new Map<number, Tracked>();
  private _relayoutSource = 0;
  // Suprime reentrância enquanto aplicamos geometria (evita laço de feedback).
  private _applying = false;

  // Ordem estável das janelas por `(monitor, workspace)` — torna o BSP determinístico e o
  // rearranjo do drop persistente sem estado no daemon.
  private _order = new Map<string, number[]>();

  // Estado do arrasto + overlay de preview da drop zone.
  private _dragSource = 0;
  private _draggedId = 0;
  private _previewActor: St.Widget | null = null;
  private _lastPointer: [number, number] | null = null;
  // Em voo: evita empilhar chamadas D-Bus síncronas mais rápido que a resposta.
  private _resolving = false;

  override enable(): void {
    // 1) Proxy D-Bus. Sem daemon no bus, o indicador fica em estado padrão e a ponte não roteia.
    try {
      this._proxy = createTilingProxy();
    } catch (error) {
      console.error(`Etherbit Tiling: falha ao conectar no daemon: ${error}`);
      this._proxy = null;
    }

    // 2) Indicador na barra (gaps + autostart). Sem controle de borda — recurso removido.
    this._indicator = new EtherbitIndicator({
      onGaps: (inner, outer) => this._proxy?.SetGapsSync(inner, outer),
      onAutostart: (enabled) => this._proxy?.SetAutostartSync(enabled),
    });
    Main.panel.addToStatusArea(this.uuid, this._indicator);

    // 3) Config inicial + sincronização contínua via sinal ConfigChanged.
    if (this._proxy) {
      try {
        const [json] = this._proxy.GetConfigSync();
        this._config = parseConfig(json);
        this._indicator.sync(this._config);
      } catch (error) {
        console.error(`Etherbit Tiling: GetConfig falhou: ${error}`);
      }

      this._configChangedId = this._proxy.connectSignal(
        'ConfigChanged',
        (_proxy, _sender, [json]) => {
          this._config = parseConfig(json);
          this._indicator?.sync(this._config);
          // Gaps/ignore_list podem ter mudado → recalcula o layout.
          this._scheduleRelayout();
        },
      );
    }

    // 4) Eventos nativos do Mutter que motivam um novo layout.
    this._displayIds.push(
      global.display.connect('window-created', (_display, window) =>
        this._onWindowCreated(window),
      ),
    );
    this._displayIds.push(
      global.display.connect('notify::focus-window', () => this._scheduleRelayout()),
    );
    // Início do arrasto de uma janela: começa a rastrear o cursor e desenhar a drop zone.
    this._displayIds.push(
      global.display.connect('grab-op-begin', (_display, window, op) =>
        this._onGrabBegin(window, op),
      ),
    );
    // Fim de um arrasto/redimensionamento manual: consolida o drop e reorganiza ao soltar.
    this._displayIds.push(
      global.display.connect('grab-op-end', (_display, window) => {
        this._onGrabEnd(window);
        this._scheduleRelayout();
      }),
    );

    this._workspaceId = global.workspace_manager.connect('active-workspace-changed', () =>
      this._scheduleRelayout(),
    );
    this._monitorsId = Main.layoutManager.connect('monitors-changed', () =>
      this._scheduleRelayout(),
    );

    // 5) Layout inicial para as janelas já abertas.
    this._scheduleRelayout();
  }

  override disable(): void {
    if (this._relayoutSource) {
      GLib.source_remove(this._relayoutSource);
      this._relayoutSource = 0;
    }

    // Encerra um arrasto em andamento (ex.: troca de extensão durante o drag) sem deixar lixo.
    this._stopDrag();
    this._order.clear();

    for (const id of this._displayIds) {
      global.display.disconnect(id);
    }
    this._displayIds = [];

    if (this._workspaceId) {
      global.workspace_manager.disconnect(this._workspaceId);
      this._workspaceId = 0;
    }
    if (this._monitorsId) {
      Main.layoutManager.disconnect(this._monitorsId);
      this._monitorsId = 0;
    }

    for (const { window, unmanagedId } of this._tracked.values()) {
      window.disconnect(unmanagedId);
    }
    this._tracked.clear();

    if (this._proxy && this._configChangedId) {
      this._proxy.disconnectSignal(this._configChangedId);
      this._configChangedId = 0;
    }
    this._proxy = null;

    this._indicator?.destroy();
    this._indicator = null;

    this._config = { ...DEFAULT_CONFIG };
  }

  /// Rastreia a janela para reagir ao seu fechamento e agenda um relayout.
  private _onWindowCreated(window: Meta.Window): void {
    const id = window.get_stable_sequence();
    if (!this._tracked.has(id)) {
      const unmanagedId = window.connect('unmanaged', () => {
        const tracked = this._tracked.get(id);
        if (tracked) {
          tracked.window.disconnect(tracked.unmanagedId);
          this._tracked.delete(id);
        }
        removeFromOrder(this._order, id);
        this._scheduleRelayout();
      });
      this._tracked.set(id, { window, unmanagedId });
    }
    this._scheduleRelayout();
  }

  /// Coalesce rajadas de eventos (ex.: vários `window-created` no login) num único relayout.
  private _scheduleRelayout(): void {
    if (this._applying || this._relayoutSource) {
      return;
    }
    this._relayoutSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
      this._relayoutSource = 0;
      this._relayout();
      return GLib.SOURCE_REMOVE;
    });
  }

  /// Coleta janelas+monitores, pede o layout ao daemon e aplica os retângulos.
  private _relayout(): void {
    if (!this._proxy) {
      return;
    }

    const workspace = global.workspace_manager.get_active_workspace();
    const windows = workspace ? workspace.list_windows() : [];

    const byId = new Map<number, Meta.Window>();
    // Agrupa por `(monitor, workspace)` e registra a ordem estável de cada grupo.
    const groups = new Map<string, WindowSnapshot[]>();
    for (const window of windows) {
      const snapshot = this._snapshot(window);
      byId.set(snapshot.id, window);
      const key = orderKey(snapshot.monitor, snapshot.workspace);
      appendToOrder(this._order, key, snapshot.id);
      const arr = groups.get(key);
      if (arr) {
        arr.push(snapshot);
      } else {
        groups.set(key, [snapshot]);
      }
    }

    // Reordena cada grupo pela ordem estável; o BSP do core é função dessa ordem.
    const snapshots: WindowSnapshot[] = [];
    for (const [key, arr] of groups) {
      const sortedIds = sortByOrder(
        this._order,
        key,
        arr.map((s) => s.id),
      );
      const inGroup = new Map(arr.map((s) => [s.id, s]));
      for (const sid of sortedIds) {
        const snap = inGroup.get(sid);
        if (snap) {
          snapshots.push(snap);
        }
      }
    }

    let layoutJson: string;
    try {
      [layoutJson] = this._proxy.SyncWindowsSync(
        serializeWindows(snapshots),
        serializeMonitors(this._collectMonitors()),
      );
    } catch (error) {
      console.error(`Etherbit Tiling: SyncWindows falhou: ${error}`);
      return;
    }

    const commands = parseLayout(layoutJson);
    this._applying = true;
    try {
      for (const command of commands) {
        const window = byId.get(command.id);
        // user_op=false: reposicionamento programático, instantâneo e puramente geométrico.
        window?.move_resize_frame(false, command.x, command.y, command.width, command.height);
      }
    } finally {
      this._applying = false;
    }
  }

  // ---- Arrasto + overlay de preview da drop zone ----

  /// Início de um arrasto de MOVIMENTO de janela: passa a amostrar o cursor (~60 FPS) e a desenhar
  /// a drop zone. Ignora resize e ambientes sem daemon (degradação suave).
  private _onGrabBegin(window: Meta.Window | null, op: Meta.GrabOp): void {
    if (!window || !this._proxy || op !== Meta.GrabOp.MOVING) {
      return;
    }
    this._stopDrag(); // encerra qualquer arrasto pendente antes de iniciar outro
    this._draggedId = window.get_stable_sequence();
    this._lastPointer = null;
    this._resolving = false;
    this._dragSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_TICK_MS, () => {
      this._onDragTick();
      return GLib.SOURCE_CONTINUE;
    });
  }

  /// Um tick do arrasto: lê o cursor, resolve a zona no daemon e atualiza o overlay. Faz throttle
  /// por posição (pula se o cursor não moveu) e por chamada em voo (não empilha D-Bus síncrono).
  private _onDragTick(): void {
    if (!this._proxy || this._resolving) {
      return;
    }
    const [x, y] = global.get_pointer();
    if (this._lastPointer && this._lastPointer[0] === x && this._lastPointer[1] === y) {
      return;
    }
    this._lastPointer = [x, y];
    this._resolving = true;
    try {
      const [previewJson] = this._proxy.ResolveDropZoneSync(
        x,
        y,
        serializeMonitors(this._collectMonitors()),
      );
      this._updatePreview(parsePreview(previewJson));
    } catch (error) {
      console.error(`Etherbit Tiling: ResolveDropZone falhou: ${error}`);
    } finally {
      this._resolving = false;
    }
  }

  /// Mostra/posiciona o overlay para a zona resolvida; esconde quando não há zona (`none`/zerado).
  private _updatePreview(preview: ReturnType<typeof parsePreview>): void {
    const actor = this._ensurePreviewActor();
    if (!preview || preview.zone === 'none' || preview.width <= 0 || preview.height <= 0) {
      actor.hide();
      return;
    }
    actor.set_position(preview.x, preview.y);
    actor.set_size(preview.width, preview.height);
    actor.show();
  }

  /// Cria (uma vez) o ator do overlay: ESTÁTICO, semi-transparente, cantos arredondados, não
  /// reativo (não rouba o ponteiro durante o grab). Em `uiGroup` (coords absolutas de stage, que
  /// casam com `global.get_pointer()` e com o daemon) — não em `addChrome`, que mexeria nas áreas
  /// úteis. Sem animação (ver ADR 0016): um único ator reposicionado, custo desprezível.
  private _ensurePreviewActor(): St.Widget {
    if (!this._previewActor) {
      this._previewActor = new St.Widget({
        style_class: 'etherbit-drop-preview',
        reactive: false,
        can_focus: false,
        track_hover: false,
      });
      this._previewActor.set_style(
        'background-color: rgba(94, 129, 172, 0.28);' +
          'border: 2px solid rgba(94, 129, 172, 0.9);' +
          'border-radius: 12px;',
      );
      Main.layoutManager.uiGroup.add_child(this._previewActor);
    }
    return this._previewActor;
  }

  private _destroyPreview(): void {
    if (this._previewActor) {
      this._previewActor.destroy();
      this._previewActor = null;
    }
  }

  /// Fim do arrasto: consolida o rearranjo (swap do arrastado com a janela sob o ponteiro) e
  /// encerra o overlay. O `_scheduleRelayout()` (chamado pelo handler) re-tila todo o BSP a partir
  /// da nova ordem — recálculo instantâneo de todas as janelas.
  private _onGrabEnd(window: Meta.Window | null): void {
    if (this._draggedId && window) {
      const [x, y] = global.get_pointer();
      const targetId = this._windowUnderPoint(x, y, this._draggedId);
      if (targetId !== null) {
        const workspace = window.get_workspace();
        const key = orderKey(window.get_monitor(), workspace ? workspace.index() : 0);
        reorderForDrop(this._order, key, this._draggedId, targetId);
      }
    }
    this._stopDrag();
  }

  /// Id da janela NORMAL cujo frame contém `(x, y)`, excluindo `excludeId` (a própria arrastada).
  private _windowUnderPoint(x: number, y: number, excludeId: number): number | null {
    const workspace = global.workspace_manager.get_active_workspace();
    const windows = workspace ? workspace.list_windows() : [];
    for (const window of windows) {
      const id = window.get_stable_sequence();
      if (id === excludeId || window.get_window_type() !== Meta.WindowType.NORMAL) {
        continue;
      }
      const r = window.get_frame_rect();
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        return id;
      }
    }
    return null;
  }

  /// Para o loop de amostragem, destrói o overlay e zera o estado de arrasto.
  private _stopDrag(): void {
    if (this._dragSource) {
      GLib.source_remove(this._dragSource);
      this._dragSource = 0;
    }
    this._destroyPreview();
    this._draggedId = 0;
    this._lastPointer = null;
    this._resolving = false;
  }

  /// Metadados brutos de uma janela (espelham o WindowDto do daemon). A filtragem é do core.
  private _snapshot(window: Meta.Window): WindowSnapshot {
    const frame = window.get_frame_rect();
    const wmClass = window.get_wm_class() ?? window.get_wm_class_instance() ?? '';
    const workspace = window.get_workspace();
    return {
      id: window.get_stable_sequence(),
      app_id: wmClass,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      normal: window.get_window_type() === Meta.WindowType.NORMAL,
      resizable: window.resizeable,
      maximizable: window.can_maximize(),
      monitor: window.get_monitor(),
      workspace: workspace ? workspace.index() : 0,
    };
  }

  /// Áreas úteis de cada monitor (já descontadas barras/docks do Shell).
  private _collectMonitors(): MonitorSnapshot[] {
    const monitors: MonitorSnapshot[] = [];
    const count = global.display.get_n_monitors();
    for (let index = 0; index < count; index += 1) {
      const area = Main.layoutManager.getWorkAreaForMonitor(index);
      monitors.push({ index, x: area.x, y: area.y, width: area.width, height: area.height });
    }
    return monitors;
  }
}
