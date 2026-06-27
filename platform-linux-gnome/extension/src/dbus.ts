// dbus.ts — ponte D-Bus com o daemon `org.etherbit.Tiling`.
//
// O contrato trafega a configuração como JSON string (ver ADR de nomenclatura D-Bus): o schema
// evolui só no daemon (serde); aqui a extensão apenas faz JSON.parse/serializa de volta.

import Gio from 'gi://Gio';

export const BUS_NAME = 'org.etherbit.Tiling';
export const OBJECT_PATH = '/org/etherbit/Tiling';

/// Espelha 1:1 a struct Config do daemon (etherbit-tiling-daemon).
export interface TilingConfig {
  inner_gap: number;
  outer_gap: number;
  active_border: boolean;
  border_color: string;
  border_width: number;
  ignore_list: string[];
  autostart: boolean;
}

export const DEFAULT_CONFIG: TilingConfig = {
  inner_gap: 8,
  outer_gap: 12,
  active_border: true,
  border_color: '#5e81ac',
  border_width: 2,
  ignore_list: [],
  autostart: false,
};

// Introspecção: fonte de verdade compartilhada com o `#[interface]` do daemon.
const IFACE_XML = `
<node>
  <interface name="org.etherbit.Tiling">
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

/// Faz parse defensivo do JSON do daemon, completando campos ausentes com o padrão.
export function parseConfig(json: string): TilingConfig {
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(json) as Partial<TilingConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
