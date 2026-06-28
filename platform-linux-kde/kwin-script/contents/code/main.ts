// main.ts — ponte KWin (Wayland) ↔ daemon. Análogo KDE da extension.ts do GNOME.
//
// PONTE BURRA (ver ADR rules/0016): o script NÃO decide layout. Responsabilidades:
//  - ler a config nativa do script (kwinrc) e propagá-la ao daemon (mantém TOML/autostart);
//  - manter uma ORDEM estável das janelas por (monitor, workspace) — o BSP do core é função dessa
//    ordem; isso evita reshuffle no foco e torna o rearranjo do drop persistente SEM estado no daemon;
//  - escutar windowAdded/windowRemoved/windowActivated e pedir o layout ao daemon (`SyncWindows`),
//    aplicando os retângulos via `window.frameGeometry` (geométrico e instantâneo);
//  - durante um ARRASTO, amostrar o cursor (eventos `interactiveMoveResize*`, sem polling), resolver
//    a zona no daemon (`ResolveDropZone`) e desenhar o indicador com o primitivo NATIVO do KWin
//    (`workspace.showOutline`). Ao soltar, consolida o rearranjo (swap) e re-tila.
//
// Diferença de apresentação vs. GNOME (ADR 0016): o GNOME desenha uma caixa preenchida (St.Widget);
// o KWin usa o outline nativo (o mesmo do quick-tile) — não há equivalente preenchido sem QML.
//
// Modelo PULL: o script só CHAMA métodos D-Bus (não assina sinais). Toda a matemática (Ether Flow) e
// a resiliência gráfica vivem no Rust (core/daemon).

import { DEFAULT_CONFIG, type TilingConfig } from './config.js';
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
  type DropPreview,
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

// ---- Estado leve da ponte (ver ADR 0016: o daemon permanece sem estado) ----

/// Ordem estável das janelas por `(monitor, workspace)`, chaveada pelo `internalId` (string).
const order = new Map<string, string[]>();
/// `internalId` da janela em arrasto (null fora de um move).
let draggedId: string | null = null;
/// Último cursor amostrado (throttle por posição) e guarda de chamada D-Bus em voo.
let lastCursor: QPoint | null = null;
let resolving = false;

/// Id estável de sessão da janela (QUuid → string). Coagido para servir de chave de mapa.
function windowId(win: KWinWindow): string {
  return String(win.internalId);
}

/// Saídas (monitores) presentes, na ordem de descoberta pelas janelas atuais.
function collectOutputs(): KWinOutput[] {
  const outputs: KWinOutput[] = [];
  for (const win of workspace.windows) {
    if (outputs.indexOf(win.output) === -1) {
      outputs.push(win.output);
    }
  }
  return outputs;
}

/// Áreas úteis dos monitores (descontando painéis), indexadas conforme `outputs`.
function monitorsFrom(outputs: KWinOutput[]): MonitorSnapshot[] {
  return outputs.map((output, index): MonitorSnapshot => {
    const area = workspace.clientArea(KWin.MaximizeArea, output, workspace.currentDesktop);
    return { index, x: area.x, y: area.y, width: area.width, height: area.height };
  });
}

/// Coleta janelas + monitores na ORDEM estável, pede o layout ao daemon e aplica os retângulos (pull).
/// Não faz nada durante um arrasto: o daemon snapparia a janela arrastada de volta (deixa pro drop).
function retile(): void {
  if (draggedId !== null) {
    return;
  }

  const outputs = collectOutputs();
  const monitorIndexOf = (output: KWinOutput): number => outputs.indexOf(output);

  // Dados por janela com id estável + agrupamento por (monitor, workspace=0) registrando a ordem.
  interface Entry {
    win: KWinWindow;
    stableId: string;
    monitor: number;
  }
  const groups = new Map<string, Entry[]>();
  for (const win of workspace.windows) {
    const entry: Entry = { win, stableId: windowId(win), monitor: monitorIndexOf(win.output) };
    const key = orderKey(entry.monitor, 0);
    appendToOrder(order, key, entry.stableId);
    const arr = groups.get(key);
    if (arr) {
      arr.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  // Ordena cada grupo pela ordem estável e atribui ids opacos de transporte na sequência ordenada.
  const byId = new Map<number, KWinWindow>();
  const snapshots: WindowSnapshot[] = [];
  for (const [key, arr] of groups) {
    const sortedIds = sortByOrder(
      order,
      key,
      arr.map((e) => e.stableId),
    );
    const byStable = new Map(arr.map((e) => [e.stableId, e]));
    for (const sid of sortedIds) {
      const entry = byStable.get(sid);
      if (!entry) {
        continue;
      }
      const id = snapshots.length + 1;
      byId.set(id, entry.win);
      const g = entry.win.frameGeometry;
      snapshots.push({
        id,
        app_id: entry.win.resourceClass || entry.win.resourceName || '',
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
        normal: entry.win.normalWindow,
        resizable: entry.win.resizeable,
        maximizable: entry.win.maximizable,
        monitor: entry.monitor,
        workspace: 0,
      });
    }
  }

  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'SyncWindows',
    serializeWindows(snapshots),
    serializeMonitors(monitorsFrom(outputs)),
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

// ---- Arrasto + indicador de drop zone (outline nativo) ----

/// Mostra/posiciona o outline para a zona resolvida; esconde quando não há zona (`none`/zerado).
function updateOutline(preview: DropPreview | null): void {
  if (!preview || preview.zone === 'none' || preview.width <= 0 || preview.height <= 0) {
    workspace.hideOutline();
    return;
  }
  workspace.showOutline({
    x: preview.x,
    y: preview.y,
    width: preview.width,
    height: preview.height,
  });
}

/// Id estável da janela NORMAL cujo frame contém `(x, y)`, excluindo `excludeId` (a arrastada).
function windowUnderPoint(x: number, y: number, excludeId: string): string | null {
  for (const win of workspace.windows) {
    const id = windowId(win);
    if (id === excludeId || !win.normalWindow) {
      continue;
    }
    const g = win.frameGeometry;
    if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height) {
      return id;
    }
  }
  return null;
}

/// Início de um move interativo: passa a rastrear o cursor. Ignora resize (`!win.move`).
function onMoveStart(win: KWinWindow): void {
  if (!win.move) {
    return;
  }
  draggedId = windowId(win);
  lastCursor = null;
  resolving = false;
}

/// Um passo do arrasto: resolve a zona no daemon e atualiza o outline. Throttle por chamada em voo
/// e por posição (pula se o cursor não moveu).
function onMoveStep(): void {
  if (draggedId === null || resolving) {
    return;
  }
  const cursor = workspace.cursorPos;
  if (lastCursor && lastCursor.x === cursor.x && lastCursor.y === cursor.y) {
    return;
  }
  lastCursor = { x: cursor.x, y: cursor.y };
  resolving = true;
  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'ResolveDropZone',
    cursor.x,
    cursor.y,
    serializeMonitors(monitorsFrom(collectOutputs())),
    (previewJson: string) => {
      resolving = false;
      updateOutline(parsePreview(previewJson));
    },
  );
}

/// Fim do arrasto: esconde o outline, consolida o rearranjo (swap do arrastado com a janela sob o
/// cursor) e re-tila — o BSP recalcula todas as janelas a partir da nova ordem.
function onMoveFinish(win: KWinWindow): void {
  workspace.hideOutline();
  if (draggedId !== null) {
    const cursor = workspace.cursorPos;
    const targetId = windowUnderPoint(cursor.x, cursor.y, draggedId);
    if (targetId !== null) {
      const key = orderKey(collectOutputs().indexOf(win.output), 0);
      reorderForDrop(order, key, draggedId, targetId);
    }
  }
  draggedId = null;
  lastCursor = null;
  resolving = false;
  retile();
}

/// Conecta os sinais de move interativo de uma janela (start/step/finish).
function trackWindow(win: KWinWindow): void {
  win.interactiveMoveResizeStarted.connect(() => onMoveStart(win));
  win.interactiveMoveResizeStepped.connect(() => onMoveStep());
  win.interactiveMoveResizeFinished.connect(() => onMoveFinish(win));
}

workspace.windowAdded.connect((win) => {
  trackWindow(win);
  retile();
});
workspace.windowRemoved.connect((win) => {
  removeFromOrder(order, windowId(win));
  retile();
});
workspace.windowActivated.connect(() => retile());

// Rastreia as janelas já abertas e faz o layout inicial.
for (const win of workspace.windows) {
  trackWindow(win);
}
retile();

print('Etherbit Tiling (KWin): ponte carregada, servindo via', BUS_NAME);
