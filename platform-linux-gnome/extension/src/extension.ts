// extension.ts — ponte GNOME Shell ↔ daemon (GNOME 45+ ESM, Wayland).
//
// PONTE BURRA (ver ADR rules/0016): a extensão NÃO desenha nada e NÃO decide layout. Ela apenas
//  - cria/destrói o indicador da barra (controle leve de gaps/autostart) e fala config via D-Bus;
//  - escuta eventos nativos do Mutter (janela criada/fechada, foco, monitores, workspace);
//  - coleta os metadados brutos das janelas + áreas úteis, envia ao daemon (`SyncWindows`) e
//    APLICA os retângulos-alvo devolvidos via `move_resize_frame` (geométrico e instantâneo).
// Toda a matemática (Ether Flow) e a resiliência gráfica vivem no Rust (core/daemon).

import type Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
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
  serializeState,
  serializeTarget,
  parseLayout,
  parseTabBars,
  parseLayoutTrees,
  parsePreview,
  resizeDeltaFrom,
  orderKey,
  appendToOrder,
  removeFromOrder,
  removeIdFromStacks,
  sortByOrder,
  toggleStackGroup,
  toggleGroupDisabled,
  addToStack,
  setActiveMember,
  type Stack,
  type TabBar,
  type TreeNode,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';
import { EtherbitIndicator } from './indicator.js';
import { applyRoundedCorners, clearRoundedCorners } from './effects.js';

/// Nomes das chaves de atalho no gschema (schemas/org.gnome.shell.extensions.etherbit-tiling.gschema.xml).
const KEY_TOGGLE_TILING = 'toggle-tiling';
const KEY_TOGGLE_TABBING = 'toggle-tabbing';

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

  // Ordem estável das janelas por `(monitor, workspace)` — determina a ordem de inserção de janelas
  // NOVAS na árvore (e o bootstrap balanceado). A topologia/proporções persistem em `_trees`.
  private _order = new Map<string, number[]>();

  // Árvores BSP persistentes por `(monitor, workspace)` — estado da ponte; o daemon segue sem estado.
  // Atualizadas a cada SyncWindows/MoveWindow (o core reconcilia e devolve a versão nova).
  private _trees = new Map<string, TreeNode | null>();

  // Estado leve novo (também vive na ponte; o daemon segue sem estado):
  //  - `_stacks`: janelas empilhadas em abas, por `(monitor, workspace)`;
  //  - `_disabledGroups`: grupos com tiling desligado (Super+Y);
  //  - `_groupTiled`: ids tiláveis por grupo no último layout (base do Super+S);
  //  - `_stackHidden`: ids que NÓS minimizamos (abas inativas), para restaurar depois.
  private _stacks = new Map<string, Stack[]>();
  private _disabledGroups = new Set<string>();
  private _groupTiled = new Map<string, number[]>();
  private _stackHidden = new Set<number>();
  // Barras de abas desenhadas (recriadas a cada relayout). Settings do gschema (atalhos).
  private _tabBars: St.Widget[] = [];
  private _settings: Gio.Settings | null = null;

  // Estado do arrasto + overlay de preview da drop zone.
  private _dragSource = 0;
  private _draggedId = 0;
  private _previewActor: St.Widget | null = null;
  private _lastPointer: [number, number] | null = null;
  // Zona resolvida no último tick do arrasto (define stack vs swap ao soltar).
  private _lastPreviewZone = 'none';
  // Em voo: evita empilhar chamadas D-Bus síncronas mais rápido que a resposta.
  private _resolving = false;
  // Resize manual em curso: id + frame inicial (para derivar borda/delta ao soltar).
  private _resizeStart: {
    id: number;
    rect: { x: number; y: number; width: number; height: number };
  } | null = null;

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
      onGap: (gap) => this._proxy?.SetGapSync(gap),
      onAutostart: (enabled) => this._proxy?.SetAutostartSync(enabled),
      onRoundedCorners: (enabled) =>
        this._proxy?.SetRoundedCornersSync(enabled, this._config.corner_radius),
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

    // 5) Atalhos globais (Super+Y = tiling por workspace; Super+S = agrupar em abas). As teclas
    // vivem no gschema; aqui só ligamos o disparo aos handlers que mutam o estado e re-tilam.
    try {
      this._settings = this.getSettings();
      Main.wm.addKeybinding(
        KEY_TOGGLE_TILING,
        this._settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        () => this._toggleTilingShortcut(),
      );
      Main.wm.addKeybinding(
        KEY_TOGGLE_TABBING,
        this._settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        () => this._toggleTabbingShortcut(),
      );
    } catch (error) {
      console.error(`Etherbit Tiling: falha ao registrar atalhos: ${error}`);
    }

    // 6) Layout inicial para as janelas já abertas.
    this._scheduleRelayout();
  }

  override disable(): void {
    if (this._relayoutSource) {
      GLib.source_remove(this._relayoutSource);
      this._relayoutSource = 0;
    }

    // Remove os atalhos globais.
    if (this._settings) {
      Main.wm.removeKeybinding(KEY_TOGGLE_TILING);
      Main.wm.removeKeybinding(KEY_TOGGLE_TABBING);
      this._settings = null;
    }

    // Restaura janelas que minimizamos como abas inativas e descarta as barras de abas.
    this._restoreHiddenWindows();
    this._destroyTabBars();

    // Encerra um arrasto em andamento (ex.: troca de extensão durante o drag) sem deixar lixo.
    this._stopDrag();
    this._order.clear();
    this._stacks.clear();
    this._disabledGroups.clear();
    this._groupTiled.clear();

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
      // Remove o efeito de cantos arredondados para deixar as janelas no estado original.
      const actor = window.get_compositor_private() as Clutter.Actor | null;
      if (actor) {
        clearRoundedCorners(actor);
      }
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
        removeIdFromStacks(this._stacks, id);
        this._stackHidden.delete(id);
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

    const focus = global.display.focus_window;
    const focusedId = focus ? focus.get_stable_sequence() : 0;

    let layoutJson: string;
    try {
      [layoutJson] = this._proxy.SyncWindowsSync(
        serializeWindows(snapshots),
        serializeMonitors(this._collectMonitors()),
        serializeState(this._stacks, this._disabledGroups, this._trees, focusedId),
      );
    } catch (error) {
      console.error(`Etherbit Tiling: SyncWindows falhou: ${error}`);
      return;
    }

    // Persiste as árvores reconciliadas pelo core para reenviar no próximo sync (estabilidade).
    this._trees = parseLayoutTrees(layoutJson);

    const commands = parseLayout(layoutJson);
    const tabBars = parseTabBars(layoutJson);

    // Abas inativas a ocultar (minimizar): todo membro de stack que não é o ativo.
    const shouldHide = new Set<number>();
    for (const bar of tabBars) {
      for (const member of bar.members) {
        if (member !== bar.active) {
          shouldHide.add(member);
        }
      }
    }

    this._applying = true;
    try {
      // Restaura quem deixou de estar oculto (ex.: virou a aba ativa, ou o stack foi desfeito).
      for (const id of this._stackHidden) {
        if (!shouldHide.has(id)) {
          byId.get(id)?.unminimize();
        }
      }
      // Aplica a geometria das janelas visíveis (singles + aba ativa de cada stack).
      for (const command of commands) {
        const window = byId.get(command.id);
        // user_op=false: reposicionamento programático, instantâneo e puramente geométrico.
        window?.move_resize_frame(false, command.x, command.y, command.width, command.height);
        // Cantos arredondados (efeito no ator) conforme a config — best-effort, nunca quebra.
        const actor = window?.get_compositor_private() as Clutter.Actor | null;
        if (actor) {
          if (this._config.rounded_corners) {
            applyRoundedCorners(actor, this._config.corner_radius);
          } else {
            clearRoundedCorners(actor);
          }
        }
      }
      // Oculta as abas inativas recém-empilhadas.
      for (const id of shouldHide) {
        if (!this._stackHidden.has(id)) {
          byId.get(id)?.minimize();
        }
      }
    } finally {
      this._applying = false;
    }
    this._stackHidden = shouldHide;

    // Ids tiláveis por grupo (singles + membros de stacks) — base do toggle de abas (Super+S).
    this._groupTiled = this._collectGroupTiled(commands, tabBars, byId);

    // Desenha as barras de abas a partir da geometria devolvida pelo core.
    this._rebuildTabBars(tabBars, byId);
  }

  /// Mapeia, por grupo `(monitor, workspace)`, os ids tiláveis no último layout (singles + membros
  /// de stacks), na ordem estável. É a base do `toggleStackGroup` no atalho Super+S.
  private _collectGroupTiled(
    commands: ReturnType<typeof parseLayout>,
    tabBars: TabBar[],
    byId: Map<number, Meta.Window>,
  ): Map<string, number[]> {
    const ids = new Set<number>();
    for (const c of commands) {
      ids.add(c.id);
    }
    for (const bar of tabBars) {
      for (const m of bar.members) {
        ids.add(m);
      }
    }
    const groups = new Map<string, number[]>();
    for (const id of ids) {
      const window = byId.get(id);
      if (!window) {
        continue;
      }
      const workspace = window.get_workspace();
      const key = orderKey(window.get_monitor(), workspace ? workspace.index() : 0);
      const arr = groups.get(key);
      if (arr) {
        arr.push(id);
      } else {
        groups.set(key, [id]);
      }
    }
    for (const [key, arr] of groups) {
      groups.set(key, sortByOrder(this._order, key, arr));
    }
    return groups;
  }

  // ---- Arrasto + overlay de preview da drop zone ----

  /// Início de um grab: MOVIMENTO → amostra o cursor (~60 FPS) e desenha a drop zone; RESIZE →
  /// captura o frame inicial para derivar borda/delta ao soltar. Sem daemon: degradação suave.
  private _onGrabBegin(window: Meta.Window | null, op: Meta.GrabOp): void {
    if (!window || !this._proxy) {
      return;
    }
    if (op === Meta.GrabOp.MOVING) {
      this._stopDrag(); // encerra qualquer arrasto pendente antes de iniciar outro
      this._resizeStart = null;
      this._draggedId = window.get_stable_sequence();
      this._lastPointer = null;
      this._resolving = false;
      this._dragSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_TICK_MS, () => {
        this._onDragTick();
        return GLib.SOURCE_CONTINUE;
      });
      return;
    }
    // Qualquer outro grab numa janela = resize manual: guarda a geometria inicial.
    const r = window.get_frame_rect();
    this._resizeStart = {
      id: window.get_stable_sequence(),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
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
      // Retângulo da janela sob o cursor (excluindo a arrastada) → o core decide se é empilhar.
      const target = this._windowUnderPointObj(x, y, this._draggedId);
      const targetRect = target ? this._frameRectOf(target) : null;
      const [previewJson] = this._proxy.ResolveDropZoneSync(
        x,
        y,
        serializeMonitors(this._collectMonitors()),
        serializeTarget(targetRect),
      );
      const preview = parsePreview(previewJson);
      this._lastPreviewZone = preview?.zone ?? 'none';
      this._updatePreview(preview);
    } catch (error) {
      console.error(`Etherbit Tiling: ResolveDropZone falhou: ${error}`);
    } finally {
      this._resolving = false;
    }
  }

  /// Retângulo de frame de uma janela no formato do contrato (`{x,y,width,height}`).
  private _frameRectOf(window: Meta.Window): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const r = window.get_frame_rect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
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

  /// Fim do arrasto: consolida o drop. Zona `stack` → empilha em abas; zona de lado → MoveWindow
  /// (move+split na árvore: o arrastado racha a folha do alvo no lado sobrevoado). O
  /// `_scheduleRelayout()` (chamado pelo handler) re-tila a partir das árvores atualizadas.
  private _onGrabEnd(window: Meta.Window | null): void {
    if (this._draggedId && window && this._proxy) {
      const [x, y] = global.get_pointer();
      const target = this._windowUnderPointObj(x, y, this._draggedId);
      if (target) {
        const targetId = target.get_stable_sequence();
        const workspace = window.get_workspace();
        const key = orderKey(window.get_monitor(), workspace ? workspace.index() : 0);
        if (this._lastPreviewZone === 'stack') {
          // Solto na faixa superior da janela-alvo → empilha em abas (estado de stacks).
          addToStack(this._stacks, key, targetId, this._draggedId);
        } else if (this._lastPreviewZone !== 'none' && this._lastPreviewZone !== 'center') {
          // Solto sobre um lado da janela → move+split na árvore (persistente).
          try {
            const [treesJson] = this._proxy.MoveWindowSync(
              serializeState(this._stacks, this._disabledGroups, this._trees, this._draggedId),
              this._draggedId,
              targetId,
              this._lastPreviewZone,
            );
            this._trees = parseLayoutTrees(treesJson);
          } catch (error) {
            console.error(`Etherbit Tiling: MoveWindow falhou: ${error}`);
          }
        }
      }
    } else if (
      this._resizeStart &&
      window &&
      this._proxy &&
      window.get_stable_sequence() === this._resizeStart.id
    ) {
      this._applyResize(window);
    }
    this._resizeStart = null;
    this._stopDrag();
  }

  /// Fim de um resize manual: deriva a(s) borda(s) e o delta do frame inicial→final e aplica o resize
  /// elástico na árvore via `ResizeWindow` (uma chamada por eixo). O `_scheduleRelayout()` re-tila.
  private _applyResize(window: Meta.Window): void {
    const start = this._resizeStart;
    if (!start || !this._proxy) {
      return;
    }
    const r = window.get_frame_rect();
    const deltas = resizeDeltaFrom(start.rect, {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    });
    const focus = global.display.focus_window;
    const focusedId = focus ? focus.get_stable_sequence() : 0;
    const monitorsJson = serializeMonitors(this._collectMonitors());
    for (const d of deltas) {
      try {
        const [treesJson] = this._proxy.ResizeWindowSync(
          monitorsJson,
          serializeState(this._stacks, this._disabledGroups, this._trees, focusedId),
          start.id,
          d.edge,
          d.deltaPx,
        );
        this._trees = parseLayoutTrees(treesJson);
      } catch (error) {
        console.error(`Etherbit Tiling: ResizeWindow falhou: ${error}`);
      }
    }
  }

  /// Janela NORMAL cujo frame contém `(x, y)`, excluindo `excludeId` (a própria arrastada).
  private _windowUnderPointObj(x: number, y: number, excludeId: number): Meta.Window | null {
    const workspace = global.workspace_manager.get_active_workspace();
    const windows = workspace ? workspace.list_windows() : [];
    for (const window of windows) {
      const id = window.get_stable_sequence();
      if (id === excludeId || window.get_window_type() !== Meta.WindowType.NORMAL) {
        continue;
      }
      const r = window.get_frame_rect();
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        return window;
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
    this._lastPreviewZone = 'none';
    this._resolving = false;
  }

  // ---- Atalhos globais (Super+Y / Super+S) ----

  /// Chave `(monitor, workspace)` do grupo "ativo": monitor da janela focada (ou 0) + workspace atual.
  private _activeGroupKey(): string {
    const workspace = global.workspace_manager.get_active_workspace();
    const wsIndex = workspace ? workspace.index() : 0;
    const focus = global.display.focus_window;
    const monitor = focus ? focus.get_monitor() : 0;
    return orderKey(monitor, wsIndex);
  }

  /// Super+Y: liga/desliga o tiling APENAS no grupo ativo. Os demais seguem intocados (isolados por
  /// grupo no core). Ao desligar, as janelas voltam a flutuar (o core pula o grupo).
  private _toggleTilingShortcut(): void {
    toggleGroupDisabled(this._disabledGroups, this._activeGroupKey());
    this._scheduleRelayout();
  }

  /// Super+S: empilha as janelas do grupo ativo em abas; se já houver stack, desfaz (ungroup).
  private _toggleTabbingShortcut(): void {
    const key = this._activeGroupKey();
    const ids = this._groupTiled.get(key) ?? [];
    const focus = global.display.focus_window;
    const activeId = focus ? focus.get_stable_sequence() : (ids[0] ?? 0);
    toggleStackGroup(this._stacks, key, ids, activeId);
    this._scheduleRelayout();
  }

  // ---- Barra de abas (desenhada pela ponte; geometria vem do core) ----

  /// Recria as barras de abas a partir das `TabBar` devolvidas pelo core. Recriar a cada relayout é
  /// simples e barato (só existem quando há stacks). Cada aba mostra ícone + título nativos.
  private _rebuildTabBars(tabBars: TabBar[], byId: Map<number, Meta.Window>): void {
    this._destroyTabBars();
    for (const bar of tabBars) {
      const box = new St.BoxLayout({
        style_class: 'etherbit-tab-bar',
        reactive: true,
        can_focus: false,
      });
      box.set_style(
        'background-color: rgba(46, 52, 64, 0.92);' +
          'border-radius: 8px; padding: 2px; spacing: 2px;',
      );
      for (const memberId of bar.members) {
        box.add_child(this._makeTabButton(byId.get(memberId), memberId, memberId === bar.active));
      }
      box.set_position(bar.x, bar.y);
      box.set_size(bar.width, bar.height);
      Main.layoutManager.uiGroup.add_child(box);
      this._tabBars.push(box);
    }
  }

  /// Botão de uma aba: ícone (via Shell.WindowTracker) + título da janela. Clique → ativa a aba.
  private _makeTabButton(
    window: Meta.Window | undefined,
    memberId: number,
    isActive: boolean,
  ): St.Button {
    const content = new St.BoxLayout({ style_class: 'etherbit-tab-content' });
    content.set_style('spacing: 6px; padding: 0 8px;');
    const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
    if (app) {
      content.add_child(app.create_icon_texture(16));
    }
    content.add_child(new St.Label({ text: window?.get_title() ?? '' }));

    const button = new St.Button({
      style_class: isActive ? 'etherbit-tab etherbit-tab-active' : 'etherbit-tab',
      x_expand: true,
      child: content,
    });
    button.set_style(
      isActive
        ? 'background-color: rgba(94, 129, 172, 0.95); border-radius: 6px; color: #eceff4;'
        : 'background-color: transparent; border-radius: 6px; color: #d8dee9;',
    );
    button.connect('clicked', () => {
      if (setActiveMember(this._stacks, memberId)) {
        this._scheduleRelayout();
      }
    });
    return button;
  }

  private _destroyTabBars(): void {
    for (const box of this._tabBars) {
      box.destroy();
    }
    this._tabBars = [];
  }

  /// Restaura (desminiminiza) todas as janelas que ocultamos como abas inativas.
  private _restoreHiddenWindows(): void {
    if (this._stackHidden.size === 0) {
      return;
    }
    const byId = new Map<number, Meta.Window>();
    for (const actor of global.get_window_actors()) {
      const w = actor.get_meta_window();
      if (w) {
        byId.set(w.get_stable_sequence(), w);
      }
    }
    for (const id of this._stackHidden) {
      byId.get(id)?.unminimize();
    }
    this._stackHidden.clear();
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
