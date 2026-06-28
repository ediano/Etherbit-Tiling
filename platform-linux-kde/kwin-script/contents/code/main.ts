// main.ts — ponte KWin (Wayland) ↔ daemon. Análogo KDE da extension.ts do GNOME.
//
// Um KWin Script roda no contexto do compositor: o corpo executa ao ser carregado e o motor é
// destruído ao desabilitar (não há enable/disable explícito). Responsabilidades:
//  - ler a config nativa do script (kwinrc) e propagá-la ao daemon (mantém o TOML/autostart);
//  - escutar windowAdded/windowRemoved e reaplicar o layout, após o FILTRO CIRÚRGICO;
//  - aplicar geometria via `window.frameGeometry`.
// O cálculo definitivo (Ether Flow) será plugado no ponto marcado — hoje usamos um placeholder.

import { DEFAULT_CONFIG, type TilingConfig } from './config.js';
import { shouldTile, tileColumns, type WindowLike, type Rect } from './tiling.js';

const BUS_NAME = 'org.etherbit.Tiling';
const OBJECT_PATH = '/org/etherbit/Tiling';
const IFACE = 'org.etherbit.Tiling';

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
/// (callDBus só CHAMA métodos; não dá para assinar ConfigChanged aqui — kwinrc é a entrada.)
function pushConfigToDaemon(cfg: TilingConfig): void {
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetGaps', cfg.inner_gap, cfg.outer_gap);
  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'SetActiveBorder',
    cfg.active_border,
    cfg.border_color,
    cfg.border_width,
  );
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetAutostart', cfg.autostart);
}

let config = loadConfig();
pushConfigToDaemon(config);

/// Reaplica o layout a todas as janelas tileáveis, agrupando por monitor.
function retile(): void {
  const tiled = workspace.windows.filter((w) =>
    shouldTile(w as unknown as WindowLike, config.ignore_list),
  );
  if (tiled.length === 0) {
    return;
  }

  // Agrupa por output (monitor) preservando a ordem de descoberta.
  const outputs: KWinWindow['output'][] = [];
  for (const w of tiled) {
    if (!outputs.includes(w.output)) {
      outputs.push(w.output);
    }
  }

  for (const output of outputs) {
    const group = tiled.filter((w) => w.output === output);
    const area = workspace.clientArea(KWin.MaximizeArea, output, workspace.currentDesktop);

    // TODO(Ether Flow): substituir `tileColumns` por uma decisão do core via daemon
    // (enviar janelas/monitores e receber os retângulos-alvo). Placeholder por ora.
    const rects: Rect[] = tileColumns(area, group.length, config.inner_gap, config.outer_gap);

    group.forEach((win, i) => {
      const rect = rects[i];
      if (rect) {
        win.frameGeometry = rect;
      }
    });
  }
}

workspace.windowAdded.connect((win) => {
  if (shouldTile(win as unknown as WindowLike, config.ignore_list)) {
    retile();
  }
});

workspace.windowRemoved.connect(() => {
  retile();
});

// Layout inicial para as janelas já abertas no momento do carregamento.
retile();

print('Etherbit Tiling (KWin): script carregado, servindo via', BUS_NAME);
