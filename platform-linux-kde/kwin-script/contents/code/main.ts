// main.ts — ponte KWin (Wayland) ↔ daemon. Análogo KDE da extension.ts do GNOME.
//
// PONTE BURRA (ver ADR rules/0016): o script NÃO desenha nada e NÃO decide layout. Responsabilidades:
//  - ler a config nativa do script (kwinrc) e propagá-la ao daemon (mantém TOML/autostart);
//  - escutar windowAdded/windowRemoved/windowActivated e, a cada evento, coletar os metadados
//    brutos das janelas + áreas úteis e pedir o layout ao daemon (`SyncWindows`);
//  - APLICAR os retângulos devolvidos via `window.frameGeometry` (geométrico e instantâneo).
//
// Modelo PULL: o KWin script só CHAMA métodos D-Bus (não assina sinais), então usa o RETORNO de
// `SyncWindows` — o mesmo método request/response que a extensão GNOME usa. Toda a matemática
// (Ether Flow) e a resiliência gráfica vivem no Rust (core/daemon).

import { DEFAULT_CONFIG, type TilingConfig } from './config.js';
import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';

const BUS_NAME = 'dev.ediano.etherbit.Tiling';
const OBJECT_PATH = '/dev/ediano/etherbit/Tiling';
const IFACE = 'dev.ediano.etherbit.Tiling';

/// Lê a config do kwinrc (entradas de contents/config/main.xml), com fallback nos padrões.
function loadConfig(): TilingConfig {
  return {
    inner_gap: readConfig('innerGap', DEFAULT_CONFIG.inner_gap),
    outer_gap: readConfig('outerGap', DEFAULT_CONFIG.outer_gap),
    active_border: readConfig('activeBorder', DEFAULT_CONFIG.active_border),
    border_color: readConfig('borderColor', DEFAULT_CONFIG.border_color),
    border_width: readConfig('borderWidth', DEFAULT_CONFIG.border_width),
    ignore_list: DEFAULT_CONFIG.ignore_list,
    autostart: readConfig('autostart', DEFAULT_CONFIG.autostart),
  };
}

/// Empurra a config lida do kwinrc para o daemon: ele persiste no TOML e gerencia o autostart.
/// (Os campos de borda são inertes — recurso removido; ver ADR rules/0016 — e não são enviados.)
function pushConfigToDaemon(cfg: TilingConfig): void {
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetGaps', cfg.inner_gap, cfg.outer_gap);
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetAutostart', cfg.autostart);
}

const config = loadConfig();
pushConfigToDaemon(config);

/// Coleta janelas + monitores, pede o layout ao daemon e aplica os retângulos (pull).
function retile(): void {
  const windows = workspace.windows;

  // Indexação de saídas (monitores) consistente entre windows_json e monitors_json nesta chamada.
  const outputs: KWinOutput[] = [];
  const monitorIndex = (output: KWinOutput): number => {
    let index = outputs.indexOf(output);
    if (index === -1) {
      index = outputs.length;
      outputs.push(output);
    }
    return index;
  };

  // `id` é um handle OPACO válido só nesta chamada — o daemon apenas o ecoa de volta.
  const byId = new Map<number, KWinWindow>();
  const snapshots: WindowSnapshot[] = windows.map((win, i): WindowSnapshot => {
    const id = i + 1;
    byId.set(id, win);
    const g = win.frameGeometry;
    return {
      id,
      app_id: win.resourceClass || win.resourceName || '',
      x: g.x,
      y: g.y,
      width: g.width,
      height: g.height,
      normal: win.normalWindow,
      resizable: win.resizeable,
      maximizable: win.maximizable,
      monitor: monitorIndex(win.output),
      workspace: 0,
    };
  });

  const monitors: MonitorSnapshot[] = outputs.map((output, index): MonitorSnapshot => {
    const area = workspace.clientArea(KWin.MaximizeArea, output, workspace.currentDesktop);
    return { index, x: area.x, y: area.y, width: area.width, height: area.height };
  });

  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'SyncWindows',
    serializeWindows(snapshots),
    serializeMonitors(monitors),
    (layoutJson: string) => {
      for (const command of parseLayout(layoutJson)) {
        const win = byId.get(command.id);
        if (win) {
          win.frameGeometry = {
            x: command.x,
            y: command.y,
            width: command.width,
            height: command.height,
          };
        }
      }
    },
  );
}

workspace.windowAdded.connect(() => retile());
workspace.windowRemoved.connect(() => retile());
workspace.windowActivated.connect(() => retile());

// Layout inicial para as janelas já abertas no momento do carregamento.
retile();

print('Etherbit Tiling (KWin): ponte carregada, servindo via', BUS_NAME);
