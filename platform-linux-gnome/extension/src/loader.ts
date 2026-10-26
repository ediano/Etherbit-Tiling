// loader.ts — ponto de entrada ESTÁVEL da extensão (vira `extension.js`). ADR 0071.
//
// O GNOME Shell cacheia módulos ES por URL e, no Wayland, não há como reiniciar o Shell sem logout.
// Por isso o código real NÃO mora aqui: fica em `impl/<versão>/main.js`, importado dinamicamente.
// O instalador grava uma versão nova num diretório novo e reescreve `impl/current`; este loader
// observa o arquivo e troca a implementação ao vivo (disable da antiga → import da nova → enable).
// Como o caminho muda a cada versão, o cache de módulos nunca serve código velho.
//
// Este arquivo deve mudar raramente: só uma mudança AQUI (ou no metadata.json) ainda exige logout.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/// Contrato da implementação versionada (`impl/<versão>/main.js`, export default).
interface Impl {
  enable(): void;
  disable(): void;
}
type ImplCtor = new (ext: Extension) => Impl;

/// Debounce (ms) do monitor de arquivo: o instalador escreve `current` em mais de um evento.
const RELOAD_DEBOUNCE_MS = 300;

export default class EtherbitTilingLoader extends Extension {
  private _impl: Impl | null = null;
  private _loadedVersion = '';
  private _monitor: Gio.FileMonitor | null = null;
  private _monitorId = 0;
  private _debounceId = 0;
  // Incrementado a cada reload/disable: descarta um `import()` que terminou depois de ser superado.
  private _generation = 0;

  override enable(): void {
    const current = Gio.File.new_for_path(`${this.path}/impl/current`);
    this._monitor = current.monitor_file(Gio.FileMonitorFlags.NONE, null);
    this._monitorId = this._monitor.connect('changed', () => this._scheduleReload());
    void this._reload();
  }

  override disable(): void {
    this._generation++;
    if (this._debounceId) {
      GLib.source_remove(this._debounceId);
      this._debounceId = 0;
    }
    if (this._monitor) {
      if (this._monitorId) this._monitor.disconnect(this._monitorId);
      this._monitor.cancel();
      this._monitor = null;
      this._monitorId = 0;
    }
    this._disableImpl();
  }

  private _scheduleReload(): void {
    if (this._debounceId) GLib.source_remove(this._debounceId);
    this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DEBOUNCE_MS, () => {
      this._debounceId = 0;
      void this._reload();
      return GLib.SOURCE_REMOVE;
    });
  }

  private _readCurrentVersion(): string {
    try {
      const [ok, bytes] = GLib.file_get_contents(`${this.path}/impl/current`);
      return ok ? new TextDecoder().decode(bytes).trim() : '';
    } catch {
      return '';
    }
  }

  private async _reload(): Promise<void> {
    const generation = ++this._generation;
    const version = this._readCurrentVersion();
    // Só aceita um nome de diretório simples (sem `/` nem `..`).
    if (!version || version === this._loadedVersion || !/^[\w.+-]+$/.test(version)) return;

    const uri = GLib.filename_to_uri(`${this.path}/impl/${version}/main.js`, null);
    let Ctor: ImplCtor;
    try {
      Ctor = ((await import(uri)) as { default: ImplCtor }).default;
    } catch (e) {
      console.error(
        `[etherbit] falha ao carregar impl ${version}; mantendo ${this._loadedVersion || 'nenhuma'}`,
        e,
      );
      return;
    }
    if (generation !== this._generation) return;

    this._disableImpl();
    try {
      const impl = new Ctor(this);
      impl.enable();
      this._impl = impl;
      this._loadedVersion = version;
      console.log(`[etherbit] impl ${version} ativa`);
    } catch (e) {
      console.error(`[etherbit] falha ao ativar impl ${version}`, e);
    }
  }

  private _disableImpl(): void {
    if (!this._impl) return;
    try {
      this._impl.disable();
    } catch (e) {
      console.error('[etherbit] erro no disable da impl', e);
    }
    this._impl = null;
    this._loadedVersion = '';
  }
}
