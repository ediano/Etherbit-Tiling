// main.ts — ponte KWin (Wayland) ↔ daemon. Análogo KDE da extension.ts do GNOME.
//
// PONTE BURRA (ver ADR rules/0016 e rules/0017): o script NÃO decide layout. Responsabilidades:
//  - ler a config nativa do script (kwinrc) e propagá-la ao daemon;
//  - manter o ESTADO LEVE na ponte (o daemon é sem estado): a ORDEM estável das janelas, os STACKS
//    (abas) e os grupos com tiling desligado — enviados a cada `SyncWindows` via `state_json`;
//  - escutar windowAdded/windowRemoved/windowActivated e pedir o layout ao daemon (`SyncWindows`),
//    aplicando os retângulos via `window.frameGeometry`;
//  - registrar os atalhos globais (Meta+Y = tiling por desktop; Meta+S = agrupar em abas);
//  - durante um ARRASTO, resolver a zona no daemon (`ResolveDropZone`, com o retângulo da janela sob
//    o cursor) e desenhar o indicador nativo (`workspace.showOutline`). Ao soltar: empilha (zona
//    `stack`) ou troca de posição (swap), conforme a zona resolvida.
//
// Abas no KDE (paridade FUNCIONAL com o GNOME, ver rules/0017): a aba ativa fica visível; as demais
// são MINIMIZADAS (afordância nativa: aparecem na barra de tarefas/alt-tab). ATIVAR uma janela do
// stack (taskbar/alt-tab) a traz à frente — a troca de aba é dirigida por ativação. Não há barra QML
// desenhada pelo script (um KWin *Script*, ao contrário do St.Widget do GNOME, não instancia overlay
// QML posicionado de forma confiável — isso seria um KWin *Effect*). A matemática vive 100% no Rust.

import { DEFAULT_CONFIG, type TilingConfig } from './config.js';
import {
  serializeWindows,
  serializeMonitors,
  serializeState,
  serializeTarget,
  parseLayout,
  parseTabBars,
  parseFloating,
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
  type TreeNode,
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
    gap: readConfig('gap', DEFAULT_CONFIG.gap),
    active_border: readConfig('activeBorder', DEFAULT_CONFIG.active_border),
    border_color: readConfig('borderColor', DEFAULT_CONFIG.border_color),
    border_width: readConfig('borderWidth', DEFAULT_CONFIG.border_width),
    ignore_list: DEFAULT_CONFIG.ignore_list,
    autostart: readConfig('autostart', DEFAULT_CONFIG.autostart),
    rounded_corners: readConfig('roundedCorners', DEFAULT_CONFIG.rounded_corners),
    corner_radius: readConfig('cornerRadius', DEFAULT_CONFIG.corner_radius),
  };
}

/// Empurra a config lida do kwinrc para o daemon: ele persiste no TOML e gerencia o autostart. Os
/// cantos arredondados são propagados por consistência da config; no KDE o arredondamento em si
/// depende do efeito NATIVO de cantos do KWin (um Script não instancia shaders — ver ADR 0019).
function pushConfigToDaemon(cfg: TilingConfig): void {
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetGap', cfg.gap);
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetAutostart', cfg.autostart);
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetRoundedCorners', cfg.rounded_corners, cfg.corner_radius);
}

const config = loadConfig();
pushConfigToDaemon(config);

// ---- Estado leve da ponte (ver ADR 0016/0017: o daemon permanece sem estado) ----

/// Ordem estável das janelas por `(monitor, desktop)`, chaveada pelo `internalId` (string).
const order = new Map<string, string[]>();
/// Stacks (abas) por `(monitor, desktop)`. Membros são `internalId` (string).
const stacks = new Map<string, Stack[]>();
/// Grupos `(monitor, desktop)` com tiling desligado (Meta+Y).
const disabled = new Set<string>();
/// Ids tiláveis (internalId) por grupo no último layout — base do Meta+S.
const groupTiled = new Map<string, string[]>();
/// internalIds que NÓS minimizamos como abas inativas (para restaurar depois).
const stackHidden = new Set<string>();
/// internalIds que NÓS elevamos (keepAbove) por auto-floating — para baixar ao voltarem ao grid.
const floatingAbove = new Set<string>();
/// Árvores BSP persistentes por `(monitor, desktop)`, com folhas em internalId (forma canônica).
/// O core reconcilia e devolve a versão atualizada a cada SyncWindows/MoveWindow.
let trees = new Map<string, TreeNode | null>();
/// Mapas de transporte do ÚLTIMO retile (internalId ↔ id opaco), reusados no drop (sem retile no meio
/// do arrasto, eles seguem válidos para as janelas pré-existentes).
let lastTransportOf = new Map<string, number>();
let lastTransportToStable = new Map<number, string>();

/// `internalId` da janela em arrasto (null fora de um move).
let draggedId: string | null = null;
/// Último cursor amostrado (throttle por posição) e guarda de chamada D-Bus em voo.
let lastCursor: QPoint | null = null;
let resolving = false;
/// Zona resolvida no último passo do arrasto (define stack vs swap ao soltar).
let lastZone = 'none';
/// Resize manual em curso: internalId + frame inicial (para derivar borda/delta ao soltar).
let resizeStart: { id: string; rect: { x: number; y: number; width: number; height: number } } | null =
  null;
/// Suprime retile reentrante enquanto aplicamos geometria/minimização.
let applying = false;

/// Id estável de sessão da janela (QUuid → string). Coagido para servir de chave de mapa.
function windowId(win: KWinWindow): string {
  return String(win.internalId);
}

/// `true` se a janela está maximizada (o quadro cobre toda a MaximizeArea do seu monitor). O KWin
/// script não expõe o estado de maximização de forma estável, então comparamos a geometria com a área
/// de maximização (API estável). Os gaps do tiling fazem uma janela TILADA medir menos que essa área,
/// evitando falso-positivo no caso comum. Base do Unmaximize Recovery (a maximizada fica fora do grid).
function isMaximized(win: KWinWindow): boolean {
  const max = workspace.clientArea(KWin.MaximizeArea, win);
  const g = win.frameGeometry;
  return (
    Math.abs(g.x - max.x) <= 1 &&
    Math.abs(g.y - max.y) <= 1 &&
    Math.abs(g.width - max.width) <= 1 &&
    Math.abs(g.height - max.height) <= 1
  );
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

/// Índice estável do desktop virtual da janela (para isolar o tiling por workspace). Janela em todos
/// os desktops (ou desconhecida) → desktop atual.
function desktopIndexOf(win: KWinWindow): number {
  const all = workspace.desktops ?? [];
  const wd = win.desktops ?? [];
  if (wd.length > 0) {
    const idx = all.indexOf(wd[0] as KWinVirtualDesktop);
    return idx >= 0 ? idx : 0;
  }
  const cur = all.indexOf(workspace.currentDesktop);
  return cur >= 0 ? cur : 0;
}

/// Chave `(monitor, desktop)` do grupo "ativo": monitor + desktop da janela ativa (ou desktop atual).
function activeGroupKey(): string {
  const aw = workspace.activeWindow;
  if (aw) {
    const monitor = collectOutputs().indexOf(aw.output);
    return orderKey(monitor < 0 ? 0 : monitor, desktopIndexOf(aw));
  }
  const cur = (workspace.desktops ?? []).indexOf(workspace.currentDesktop);
  return orderKey(0, cur < 0 ? 0 : cur);
}

/// Janela NORMAL cujo frame contém `(x, y)`, excluindo `excludeId` (a arrastada).
function windowUnderPointObj(x: number, y: number, excludeId: string): KWinWindow | null {
  for (const win of workspace.windows) {
    if (windowId(win) === excludeId || !win.normalWindow) {
      continue;
    }
    const g = win.frameGeometry;
    if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height) {
      return win;
    }
  }
  return null;
}

/// Coleta janelas + monitores na ORDEM estável, pede o layout ao daemon (com o estado de stacks/
/// grupos desligados) e aplica os retângulos (pull). Não faz nada durante um arrasto nem reentrante.
function retile(): void {
  if (draggedId !== null || applying) {
    return;
  }

  const outputs = collectOutputs();
  const monitorIndexOf = (output: KWinOutput): number => outputs.indexOf(output);

  interface Entry {
    win: KWinWindow;
    stableId: string;
    monitor: number;
    desktop: number;
  }
  const groups = new Map<string, Entry[]>();
  for (const win of workspace.windows) {
    const entry: Entry = {
      win,
      stableId: windowId(win),
      monitor: monitorIndexOf(win.output),
      desktop: desktopIndexOf(win),
    };
    const key = orderKey(entry.monitor, entry.desktop);
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
  const stableToWin = new Map<string, KWinWindow>();
  const transportOf = new Map<string, number>();
  const transportToStable = new Map<number, string>();
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
      stableToWin.set(entry.stableId, entry.win);
      transportOf.set(entry.stableId, id);
      transportToStable.set(id, entry.stableId);
      const g = entry.win.frameGeometry;
      const min = entry.win.minSize;
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
        workspace: entry.desktop,
        min_width: min ? Math.max(0, Math.round(min.width)) : 0,
        min_height: min ? Math.max(0, Math.round(min.height)) : 0,
        maximized: isMaximized(entry.win),
      });
    }
  }

  // Guarda os mapas de transporte para o drop (MoveWindow) reusar durante o arrasto.
  lastTransportOf = transportOf;
  lastTransportToStable = transportToStable;
  const aw = workspace.activeWindow;
  const focusedStable = aw ? windowId(aw) : '';

  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'SyncWindows',
    serializeWindows(snapshots),
    serializeMonitors(monitorsFrom(outputs)),
    serializeState(stacks, disabled, transportOf, trees, focusedStable),
    (layoutJson: string) => {
      // Persiste as árvores reconciliadas (traduzidas de volta para internalId).
      trees = parseLayoutTrees(layoutJson, transportToStable);
      const commands = parseLayout(layoutJson);
      const tabBars = parseTabBars(layoutJson);
      // Janelas isoladas por auto-floating (mínimo não cabe): aplicar e ELEVAR (keepAbove).
      const floating = parseFloating(layoutJson);
      const floatingHere = new Set<string>();

      // Abas inativas a ocultar (minimizar): todo membro de stack que não é o ativo (por internalId).
      const shouldHide = new Set<string>();
      for (const bar of tabBars) {
        for (const member of bar.members) {
          if (member !== bar.active) {
            const w = byId.get(member);
            if (w) {
              shouldHide.add(windowId(w));
            }
          }
        }
      }

      applying = true;
      try {
        // Restaura quem deixou de estar oculto (virou a aba ativa, ou o stack foi desfeito).
        for (const sid of stackHidden) {
          if (!shouldHide.has(sid)) {
            const w = stableToWin.get(sid);
            if (w) {
              w.minimized = false;
            }
          }
        }
        // Aplica a geometria das janelas visíveis (singles + aba ativa de cada stack). Pula janelas
        // MAXIMIZADAS — sobrescrever a geometria as desmaximizaria. O compositor as mantém maximizadas
        // por cima do slot reservado; ao desmaximizar, um novo relayout aplica o slot (Unmaximize
        // Recovery).
        for (const command of commands) {
          const win = byId.get(command.id);
          if (win && !isMaximized(win)) {
            win.frameGeometry = {
              x: command.x,
              y: command.y,
              width: command.width,
              height: command.height,
            };
          }
        }
        // Oculta as abas inativas recém-empilhadas.
        for (const sid of shouldHide) {
          if (!stackHidden.has(sid)) {
            const w = stableToWin.get(sid);
            if (w) {
              w.minimized = true;
            }
          }
        }
        // Aplica a geometria das flutuantes (centralizadas pelo core) e as eleva acima do grid.
        for (const command of floating) {
          const win = byId.get(command.id);
          if (win) {
            win.frameGeometry = {
              x: command.x,
              y: command.y,
              width: command.width,
              height: command.height,
            };
            win.keepAbove = true;
            floatingHere.add(windowId(win));
          }
        }
        // Baixa quem deixou de flutuar (voltou ao grid): remove o keepAbove que nós pusemos.
        for (const sid of floatingAbove) {
          if (!floatingHere.has(sid)) {
            const w = stableToWin.get(sid);
            if (w) {
              w.keepAbove = false;
            }
          }
        }
      } finally {
        applying = false;
      }
      floatingAbove.clear();
      for (const sid of floatingHere) {
        floatingAbove.add(sid);
      }
      stackHidden.clear();
      for (const sid of shouldHide) {
        stackHidden.add(sid);
      }

      // Ids tiláveis (internalId) por grupo — base do toggle de abas (Meta+S).
      collectGroupTiled(commands, tabBars, byId, outputs);
    },
  );
}

/// Recalcula `groupTiled` (ids tiláveis por grupo, ordem estável) a partir do último layout.
function collectGroupTiled(
  commands: ReturnType<typeof parseLayout>,
  tabBars: ReturnType<typeof parseTabBars>,
  byId: Map<number, KWinWindow>,
  outputs: KWinOutput[],
): void {
  const transportIds = new Set<number>();
  for (const c of commands) {
    transportIds.add(c.id);
  }
  for (const bar of tabBars) {
    for (const m of bar.members) {
      transportIds.add(m);
    }
  }
  groupTiled.clear();
  for (const tid of transportIds) {
    const win = byId.get(tid);
    if (!win) {
      continue;
    }
    const monitor = outputs.indexOf(win.output);
    const key = orderKey(monitor < 0 ? 0 : monitor, desktopIndexOf(win));
    const arr = groupTiled.get(key);
    if (arr) {
      arr.push(windowId(win));
    } else {
      groupTiled.set(key, [windowId(win)]);
    }
  }
  for (const [key, arr] of groupTiled) {
    groupTiled.set(key, sortByOrder(order, key, arr));
  }
}

// ---- Atalhos globais (Meta+Y / Meta+S) ----

registerShortcut(
  'EtherbitToggleTiling',
  'Etherbit: liga/desliga o tiling no workspace atual',
  'Meta+Y',
  () => {
    toggleGroupDisabled(disabled, activeGroupKey());
    retile();
  },
);
registerShortcut(
  'EtherbitToggleTabbing',
  'Etherbit: agrupa/desagrupa as janelas do quadrante em abas',
  'Meta+S',
  () => {
    const key = activeGroupKey();
    const ids = groupTiled.get(key) ?? [];
    const aw = workspace.activeWindow;
    const active = aw ? windowId(aw) : (ids[0] ?? '');
    toggleStackGroup(stacks, key, ids, active);
    retile();
  },
);

// ---- Arrasto + indicador de drop zone (outline nativo) ----

/// Mostra/posiciona o outline para a zona resolvida; esconde quando não há zona (`none`/zerado). Para
/// a zona `stack`, o retângulo é o da própria janela-alvo (indica "vai empilhar aqui").
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

/// Início de um move/resize interativo. MOVE → rastreia o cursor (drop zone). RESIZE → captura o
/// frame inicial para derivar borda/delta ao soltar.
function onMoveStart(win: KWinWindow): void {
  if (win.move) {
    resizeStart = null;
    draggedId = windowId(win);
    lastCursor = null;
    resolving = false;
    lastZone = 'none';
    return;
  }
  if (win.resize) {
    const g = win.frameGeometry;
    resizeStart = {
      id: windowId(win),
      rect: { x: g.x, y: g.y, width: g.width, height: g.height },
    };
  }
}

/// Um passo do arrasto: resolve a zona no daemon (com o retângulo da janela sob o cursor) e atualiza
/// o outline. Throttle por chamada em voo e por posição (pula se o cursor não moveu).
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
  const target = windowUnderPointObj(cursor.x, cursor.y, draggedId);
  const targetRect = target
    ? {
        x: target.frameGeometry.x,
        y: target.frameGeometry.y,
        width: target.frameGeometry.width,
        height: target.frameGeometry.height,
      }
    : null;
  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'ResolveDropZone',
    cursor.x,
    cursor.y,
    serializeMonitors(monitorsFrom(collectOutputs())),
    serializeTarget(targetRect),
    (previewJson: string) => {
      resolving = false;
      const preview = parsePreview(previewJson);
      lastZone = preview?.zone ?? 'none';
      updateOutline(preview);
    },
  );
}

/// Fim do arrasto: esconde o outline e consolida o drop. Zona `stack` → empilha em abas; zona de lado
/// → MoveWindow (move+split na árvore persistente, traduzindo ids via os mapas do último retile).
function onMoveFinish(win: KWinWindow): void {
  workspace.hideOutline();
  const dragged = draggedId;
  const zone = lastZone;
  draggedId = null;
  lastCursor = null;
  resolving = false;
  lastZone = 'none';

  if (dragged === null) {
    // Não era um move: pode ter sido um resize manual.
    if (resizeStart && win.frameGeometry) {
      applyResize(win);
    } else {
      retile();
    }
    return;
  }
  const cursor = workspace.cursorPos;
  const target = windowUnderPointObj(cursor.x, cursor.y, dragged);
  if (!target) {
    retile();
    return;
  }
  const targetId = windowId(target);
  if (zone === 'stack') {
    const monitor = collectOutputs().indexOf(win.output);
    const key = orderKey(monitor < 0 ? 0 : monitor, desktopIndexOf(win));
    addToStack(stacks, key, targetId, dragged);
    retile();
    return;
  }
  const draggedT = lastTransportOf.get(dragged);
  const targetT = lastTransportOf.get(targetId);
  if (zone !== 'none' && zone !== 'center' && draggedT !== undefined && targetT !== undefined) {
    callDBus(
      BUS_NAME,
      OBJECT_PATH,
      IFACE,
      'MoveWindow',
      serializeState(stacks, disabled, lastTransportOf, trees, dragged),
      draggedT,
      targetT,
      zone,
      (treesJson: string) => {
        trees = parseLayoutTrees(treesJson, lastTransportToStable);
        retile();
      },
    );
    return;
  }
  retile();
}

/// Fim de um resize manual: deriva a(s) borda(s) e o delta do frame inicial→final e aplica o resize
/// elástico na árvore via `ResizeWindow` (uma chamada por eixo, encadeadas). Depois re-tila.
function applyResize(win: KWinWindow): void {
  const start = resizeStart;
  resizeStart = null;
  if (!start) {
    retile();
    return;
  }
  const g = win.frameGeometry;
  const deltas = resizeDeltaFrom(start.rect, {
    x: g.x,
    y: g.y,
    width: g.width,
    height: g.height,
  });
  const idT = lastTransportOf.get(start.id);
  if (idT === undefined || deltas.length === 0) {
    retile();
    return;
  }
  const monitorsJson = serializeMonitors(monitorsFrom(collectOutputs()));
  let i = 0;
  const applyNext = (): void => {
    if (i >= deltas.length) {
      retile();
      return;
    }
    const d = deltas[i] as { edge: string; deltaPx: number };
    i += 1;
    callDBus(
      BUS_NAME,
      OBJECT_PATH,
      IFACE,
      'ResizeWindow',
      monitorsJson,
      serializeState(stacks, disabled, lastTransportOf, trees, start.id),
      idT,
      d.edge,
      d.deltaPx,
      (treesJson: string) => {
        trees = parseLayoutTrees(treesJson, lastTransportToStable);
        applyNext();
      },
    );
  };
  applyNext();
}

/// Conecta os sinais de move interativo de uma janela (start/step/finish).
function trackWindow(win: KWinWindow): void {
  win.interactiveMoveResizeStarted.connect(() => onMoveStart(win));
  win.interactiveMoveResizeStepped.connect(() => onMoveStep());
  win.interactiveMoveResizeFinished.connect(() => onMoveFinish(win));
  // (Des)maximizar muda quais janelas entram no grid (Unmaximize Recovery). O sinal de maximização
  // não existe em toda versão do KWin script — conecta defensivamente (degrada sem quebrar; nesse
  // caso a re-tilagem ocorre no próximo evento de foco/janela).
  if (win.maximizedChanged) {
    win.maximizedChanged.connect(() => {
      if (!applying) {
        retile();
      }
    });
  }
}

workspace.windowAdded.connect((win) => {
  trackWindow(win);
  retile();
});
workspace.windowRemoved.connect((win) => {
  const id = windowId(win);
  removeFromOrder(order, id);
  removeIdFromStacks(stacks, id);
  stackHidden.delete(id);
  retile();
});
// Ativar uma janela do stack (taskbar/alt-tab) a torna a aba ativa (troca de aba dirigida por
// ativação — paridade funcional com o clique na barra do GNOME). Ignora durante a aplicação.
workspace.windowActivated.connect((win) => {
  if (applying) {
    return;
  }
  if (win) {
    setActiveMember(stacks, windowId(win));
  }
  retile();
});

// Rastreia as janelas já abertas e faz o layout inicial.
for (const win of workspace.windows) {
  trackWindow(win);
}
retile();

print('Etherbit Tiling (KWin): ponte carregada, servindo via', BUS_NAME);
