// dbus.ts — ponte D-Bus com o daemon `dev.ediano.etherbit.Tiling`.
//
// O contrato trafega a configuração como JSON string (ver ADR de nomenclatura D-Bus): o schema
// evolui só no daemon (serde); aqui a extensão apenas faz JSON.parse/serializa de volta.

import Gio from 'gi://Gio';

// O contrato puro (tipos, defaults, parse) vive em config.ts — testável sem GJS.
// Re-exportado aqui para que extension.ts/indicator.ts sigam importando de './dbus.js'.
export { DEFAULT_CONFIG, parseConfig, type TilingConfig } from './config.js';

export const BUS_NAME = 'dev.ediano.etherbit.Tiling';
export const OBJECT_PATH = '/dev/ediano/etherbit/Tiling';

// Introspecção: fonte de verdade compartilhada com o `#[interface]` do daemon.
const IFACE_XML = `
<node>
  <interface name="dev.ediano.etherbit.Tiling">
    <method name="GetConfig">
      <arg type="s" direction="out" name="config_json"/>
    </method>
    <method name="SetGaps">
      <arg type="u" direction="in" name="inner"/>
      <arg type="u" direction="in" name="outer"/>
    </method>
    <method name="SetActiveBorder">
      <arg type="b" direction="in" name="enabled"/>
      <arg type="s" direction="in" name="color"/>
      <arg type="u" direction="in" name="width"/>
    </method>
    <method name="SetIgnoreList">
      <arg type="as" direction="in" name="app_ids"/>
    </method>
    <method name="SetAutostart">
      <arg type="b" direction="in" name="enabled"/>
    </method>
    <method name="SyncWindows">
      <arg type="s" direction="in" name="windows_json"/>
      <arg type="s" direction="in" name="monitors_json"/>
      <arg type="s" direction="in" name="state_json"/>
      <arg type="s" direction="out" name="layout_json"/>
    </method>
    <method name="ResolveDropZone">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="s" direction="in" name="monitors_json"/>
      <arg type="s" direction="in" name="target_json"/>
      <arg type="s" direction="out" name="preview_json"/>
    </method>
    <signal name="ConfigChanged">
      <arg type="s" name="config_json"/>
    </signal>
  </interface>
</node>`;

/// Forma do proxy gerado por makeProxyWrapper que efetivamente usamos.
export interface TilingProxy {
  GetConfigSync(): [string];
  SetGapsSync(inner: number, outer: number): void;
  SetActiveBorderSync(enabled: boolean, color: string, width: number): void;
  SetIgnoreListSync(appIds: string[]): void;
  SetAutostartSync(enabled: boolean): void;
  /// Envia janelas/monitores + estado (stacks/grupos desligados) e recebe o `layout_json`
  /// (`{ rects, tab_bars }`) do daemon.
  SyncWindowsSync(windowsJson: string, monitorsJson: string, stateJson: string): [string];
  /// Resolve o destino de drop sob `(x, y)`. `targetJson` é o retângulo da janela sob o cursor
  /// (ou `""`), usado para detectar empilhamento. Recebe o `preview_json`.
  ResolveDropZoneSync(
    x: number,
    y: number,
    monitorsJson: string,
    targetJson: string,
  ): [string];
  connectSignal(
    name: 'ConfigChanged',
    callback: (proxy: TilingProxy, sender: string, params: [string]) => void,
  ): number;
  disconnectSignal(id: number): void;
}

type TilingProxyCtor = (
  bus: Gio.DBusConnection,
  name: string,
  objectPath: string,
) => TilingProxy;

const TilingProxyWrapper = Gio.DBusProxy.makeProxyWrapper(
  IFACE_XML,
) as unknown as TilingProxyCtor;

/// Cria um proxy síncrono no barramento de sessão. Pode lançar se o daemon não estiver no bus.
export function createTilingProxy(): TilingProxy {
  return TilingProxyWrapper(Gio.DBus.session, BUS_NAME, OBJECT_PATH);
}
