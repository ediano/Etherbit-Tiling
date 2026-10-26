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
// Os IDs de janela de MoveWindow/ResizeWindow trafegam como string decimal (`s`), não `t`/uint64:
// o `callDBus` do KWin não empacota uint64 e ambos os frontends precisam falar o mesmo contrato.
// O daemon faz `parse::<u64>()`. Ver ADR 0009.
const IFACE_XML = `
<node>
  <interface name="dev.ediano.etherbit.Tiling">
    <method name="Ping">
      <arg type="s" direction="out" name="status"/>
    </method>
    <method name="GetConfig">
      <arg type="s" direction="out" name="config_json"/>
    </method>
    <method name="SetEnabled">
      <arg type="b" direction="in" name="enabled"/>
    </method>
    <method name="SetGap">
      <arg type="u" direction="in" name="gap"/>
    </method>
    <method name="SetOuterGap">
      <arg type="u" direction="in" name="gap"/>
    </method>
    <method name="SetSmartGaps">
      <arg type="b" direction="in" name="enabled"/>
    </method>
    <method name="SetInsertMode">
      <arg type="s" direction="in" name="mode"/>
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
    <method name="SetRoundedCorners">
      <arg type="b" direction="in" name="enabled"/>
      <arg type="u" direction="in" name="radius"/>
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
    <method name="MoveWindow">
      <arg type="s" direction="in" name="state_json"/>
      <arg type="s" direction="in" name="dragged_id"/>
      <arg type="s" direction="in" name="target_id"/>
      <arg type="s" direction="in" name="zone"/>
      <arg type="s" direction="in" name="scope"/>
      <arg type="s" direction="out" name="trees_json"/>
    </method>
    <method name="ResizeWindow">
      <arg type="s" direction="in" name="monitors_json"/>
      <arg type="s" direction="in" name="state_json"/>
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="edge"/>
      <arg type="i" direction="in" name="delta_px"/>
      <arg type="s" direction="out" name="trees_json"/>
    </method>
    <method name="ToggleOrientation">
      <arg type="s" direction="in" name="state_json"/>
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="out" name="trees_json"/>
    </method>
    <signal name="ConfigChanged">
      <arg type="s" name="config_json"/>
    </signal>
  </interface>
</node>`;

/// Forma do proxy gerado por makeProxyWrapper que efetivamente usamos.
export interface TilingProxy {
  /// Handshake/health-check: devolve `["ok"]` se o daemon está vivo.
  PingSync(): [string];
  GetConfigSync(): [string];
  /// Chave geral do tiling: `false` libera as janelas (a ponte pausa o laço); `true` re-tila.
  SetEnabledSync(enabled: boolean): void;
  SetGapSync(gap: number): void;
  SetOuterGapSync(gap: number): void;
  /// Smart gaps (COSMIC): sem gaps com uma única janela no workspace (ADR 0068).
  SetSmartGapsSync(enabled: boolean): void;
  /// `focus` (nova janela racha a focada, COSMIC) ou `cyclic` (ADR 0030).
  SetInsertModeSync(mode: string): void;
  SetActiveBorderSync(enabled: boolean, color: string, width: number): void;
  SetIgnoreListSync(appIds: string[]): void;
  SetAutostartSync(enabled: boolean): void;
  SetRoundedCornersSync(enabled: boolean, radius: number): void;
  /// Envia janelas/monitores + estado (stacks/grupos desligados) e recebe o `layout_json`
  /// (`{ rects, tab_bars }`) do daemon.
  SyncWindowsSync(windowsJson: string, monitorsJson: string, stateJson: string): [string];
  /// Resolve o destino de drop sob `(x, y)`. `targetJson` é o retângulo da janela sob o cursor
  /// (ou `""`), usado para detectar empilhamento. Recebe o `preview_json`.
  ResolveDropZoneSync(x: number, y: number, monitorsJson: string, targetJson: string): [string];
  /// Drag-to-tile do jogo da velha (ADR 0026): move `draggedId` para junto de `targetId` no lado
  /// `zone`, com `scope` (`local` = faixa de 1/3 na submatriz do alvo; `global` = bloco de 50%).
  /// Recebe o `stateJson` (com as árvores) e devolve `{"trees":[...]}`; a geometria vem do `SyncWindows`.
  MoveWindowSync(
    stateJson: string,
    draggedId: string,
    targetId: string,
    zone: string,
    scope: string,
  ): [string];
  /// Resize elástico: arrasta a borda `edge` da janela `id` em `deltaPx` (positivo = cresceu).
  /// Recebe monitores + `stateJson` (árvores) e devolve `{"trees":[...]}` para a ponte persistir.
  ResizeWindowSync(
    monitorsJson: string,
    stateJson: string,
    id: string,
    edge: string,
    deltaPx: number,
  ): [string];
  /// Super+O (ADR 0068): alterna a orientação do split que contém `id`. Devolve `{"trees":[...]}`.
  ToggleOrientationSync(stateJson: string, id: string): [string];
  connectSignal(
    name: 'ConfigChanged',
    callback: (proxy: TilingProxy, sender: string, params: [string]) => void,
  ): number;
  disconnectSignal(id: number): void;
}

type TilingProxyCtor = (bus: Gio.DBusConnection, name: string, objectPath: string) => TilingProxy;

const TilingProxyWrapper = Gio.DBusProxy.makeProxyWrapper(IFACE_XML) as unknown as TilingProxyCtor;

/// Teto de bloqueio de cada chamada síncrona (ADR 0067). As chamadas rodam na thread principal do
/// gnome-shell; o default do GDBus (~25 s) congelaria o compositor inteiro com o daemon travado ou
/// parado (SIGSTOP). O daemon é puro e responde em µs–ms, então 1 s é folga ampla.
const CALL_TIMEOUT_MS = 1000;

/// Cria um proxy síncrono no barramento de sessão. Pode lançar se o daemon não estiver no bus.
export function createTilingProxy(): TilingProxy {
  const proxy = TilingProxyWrapper(Gio.DBus.session, BUS_NAME, OBJECT_PATH);
  (proxy as unknown as Gio.DBusProxy).set_default_timeout(CALL_TIMEOUT_MS);
  return proxy;
}
