// extension.ts — ponte GNOME Shell ↔ daemon (GNOME 45+ ESM, Wayland).
//
// Responsabilidades desta fundação:
//  - criar/destruir o indicador da barra (motor = extensão habilitada);
//  - falar com o daemon via D-Bus (ler config no enable, refletir ConfigChanged, gravar mudanças);
//  - escutar `window-created` do Mutter e aplicar o FILTRO CIRÚRGICO antes de rotear ao daemon.
// O cálculo do tiling (Ether Flow) será plugado em etapa futura, no ponto marcado abaixo.

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
import { EtherbitIndicator } from './indicator.js';

export default class EtherbitTilingExtension extends Extension {
  private _indicator: EtherbitIndicator | null = null;
  private _proxy: TilingProxy | null = null;
  private _config: TilingConfig = { ...DEFAULT_CONFIG };
  private _windowCreatedId = 0;
  private _configChangedId = 0;

  override enable(): void {
    // 1) Proxy D-Bus. Se o daemon ainda não estiver no bus, seguimos com o indicador
    //    em estado padrão — ele voltará a sincronizar quando o daemon publicar config.
    try {
      this._proxy = createTilingProxy();
    } catch (error) {
      console.error(`Etherbit Tiling: falha ao conectar no daemon: ${error}`);
      this._proxy = null;
    }

    // 2) Indicador na barra. Cada controle escreve no daemon via D-Bus.
    this._indicator = new EtherbitIndicator({
      onGaps: (inner, outer) => this._proxy?.SetGapsSync(inner, outer),
      onActiveBorder: (enabled) =>
        this._proxy?.SetActiveBorderSync(
          enabled,
          this._config.border_color,
          this._config.border_width,
        ),
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
        },
      );
    }

    // 4) Eventos de janela do Mutter.
    this._windowCreatedId = global.display.connect('window-created', (_display, window) => {
      this._onWindowCreated(window);
    });
  }

  override disable(): void {
    if (this._windowCreatedId) {
      global.display.disconnect(this._windowCreatedId);
      this._windowCreatedId = 0;
    }

    if (this._proxy && this._configChangedId) {
      this._proxy.disconnectSignal(this._configChangedId);
      this._configChangedId = 0;
    }
    this._proxy = null;

    this._indicator?.destroy();
    this._indicator = null;

    this._config = { ...DEFAULT_CONFIG };
  }

  private _onWindowCreated(window: Meta.Window): void {
    if (this._shouldIgnore(window)) return;

    // TODO(Ether Flow): rotear a janela ao daemon para cálculo/aplicação do tiling.
  }

  /// Filtro cirúrgico: decide se a janela deve ser ignorada pelo motor de tiling.
  private _shouldIgnore(window: Meta.Window): boolean {
    // 1) Lista de exclusão por classe/app-id (case-insensitive).
    const wmClass = window.get_wm_class() ?? window.get_wm_class_instance() ?? '';
    const id = wmClass.toLowerCase();
    if (this._config.ignore_list.some((entry) => entry.toLowerCase() === id)) {
      return true;
    }

    // 2) Diálogos / pop-ups rígidos: propriedades nativas de redimensionar e maximizar falsas.
    if (!window.resizeable || !window.can_maximize()) {
      return true;
    }

    // 3) Apenas janelas normais participam do tiling.
    if (window.get_window_type() !== Meta.WindowType.NORMAL) {
      return true;
    }

    return false;
  }
}
