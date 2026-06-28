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
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';
import { EtherbitIndicator } from './indicator.js';

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
    // Fim de um arrasto/redimensionamento manual: reorganiza ao soltar.
    this._displayIds.push(global.display.connect('grab-op-end', () => this._scheduleRelayout()));

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

    const snapshots: WindowSnapshot[] = [];
    const byId = new Map<number, Meta.Window>();
    for (const window of windows) {
      const snapshot = this._snapshot(window);
      byId.set(snapshot.id, window);
      snapshots.push(snapshot);
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
