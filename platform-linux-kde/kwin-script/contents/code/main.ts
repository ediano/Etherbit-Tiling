// main.ts — ponte KWin (Wayland) ↔ daemon. Análogo KDE da extension.ts do GNOME.
//
// PONTE BURRA (ver ADR rules/0016 e rules/0017): o script NÃO decide layout. Responsabilidades:
//  - ler a config nativa do script (kwinrc) e propagá-la ao daemon;
//  - manter o ESTADO LEVE na ponte (o daemon é sem estado): a ORDEM estável das janelas, as ÁRVORES
//    BSP persistentes e os grupos com tiling desligado — enviados a cada `SyncWindows` via `state_json`;
//  - escutar windowAdded/windowRemoved/windowActivated e pedir o layout ao daemon (`SyncWindows`),
//    aplicando os retângulos via `window.frameGeometry`;
//  - registrar os atalhos globais (Meta+Y = tiling por desktop; Meta+Shift+Y = chave geral);
//  - durante um ARRASTO, resolver a zona LOCALMENTE (eixos limpos, ADR 0028) e desenhar o indicador
//    nativo (`workspace.showOutline`). Ao soltar: SWAP (centro de uma janela) ou split 50/50 do slot
//    do alvo / inserção global de 50%, conforme a zona resolvida.
//
// Tiling PURO no KDE (ADR 0028): SEM abas/stacks. O drop nunca empilha — o centro de uma janela faz
// SWAP (troca as duas) e as bordas dividem o slot do alvo. A matemática vive 100% no Rust.

import { DEFAULT_CONFIG, type TilingConfig } from './config.js';
import {
  serializeWindows,
  serializeMonitors,
  serializeState,
  parseLayout,
  parseFloating,
  parseLayoutTrees,
  resolveHotZone,
  serializeScope,
  resizeDeltaFrom,
  orderKey,
  appendToOrder,
  removeFromOrder,
  sortByOrder,
  toggleGroupDisabled,
  type TreeNode,
  type HotZone,
  type Rect,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';

const BUS_NAME = 'dev.ediano.etherbit.Tiling';
const OBJECT_PATH = '/dev/ediano/etherbit/Tiling';
const IFACE = 'dev.ediano.etherbit.Tiling';

/// Prefixo estável de log. A ÚNICA saída do QJSEngine é `print` (sem `console`/`setTimeout`); o prefixo
/// permite `journalctl --user -f QT_CATEGORY=kwin_scripting | grep etherbit`. O handshake `Ping` e o
/// aviso de "sem resposta" são SEMPRE logados (são o diagnóstico essencial da falha silenciosa).
const LOG = '[etherbit]';
function log(...args: unknown[]): void {
  print(LOG, ...args);
}
/// Detalhamento POR EVENTO (contagem de janelas/retângulos), ligado pela chave `debug` do kwinrc
/// (Configurações do Sistema → KWin Scripts → Etherbit, ou `kwriteconfig6`). Default desligado.
const DEBUG = readConfig('debug', false) as boolean;
function debug(...args: unknown[]): void {
  if (DEBUG) {
    print(LOG, ...args);
  }
}

/// Lê a config do kwinrc (entradas de contents/config/main.xml), com fallback nos padrões. O
/// `autostart` deixou de ser controlado pelo KDE (o daemon já sobe via serviço/ativação D-Bus —
/// ADR 0024); fica no padrão só para o contrato espelhado seguir completo.
function loadConfig(): TilingConfig {
  return {
    enabled: readConfig('enabled', DEFAULT_CONFIG.enabled),
    gap: readConfig('gap', DEFAULT_CONFIG.gap),
    active_border: readConfig('activeBorder', DEFAULT_CONFIG.active_border),
    border_color: readConfig('borderColor', DEFAULT_CONFIG.border_color),
    border_width: readConfig('borderWidth', DEFAULT_CONFIG.border_width),
    ignore_list: DEFAULT_CONFIG.ignore_list,
    autostart: DEFAULT_CONFIG.autostart,
    rounded_corners: readConfig('roundedCorners', DEFAULT_CONFIG.rounded_corners),
    corner_radius: readConfig('cornerRadius', DEFAULT_CONFIG.corner_radius),
  };
}

/// Empurra a config lida do kwinrc para o daemon: ele persiste no TOML. NÃO mexe em autostart (o KDE
/// não gerencia mais isso). Os cantos arredondados são propagados por consistência da config; no KDE o
/// arredondamento em si depende do efeito NATIVO de cantos do KWin (um Script não instancia shaders —
/// ver ADR 0019).
function pushConfigToDaemon(cfg: TilingConfig): void {
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetEnabled', cfg.enabled);
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetGap', cfg.gap);
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetRoundedCorners', cfg.rounded_corners, cfg.corner_radius);
}

const config = loadConfig();
pushConfigToDaemon(config);

/// Chave geral do tiling (runtime). Inicia do default do KCM (`enabled`) e é alternada em tempo real
/// pelo atalho Meta+Shift+Y. Desligada, o `retile()` libera as janelas e NÃO chama `SyncWindows`.
let tilingEnabled = config.enabled;

// Handshake na carga: prova que o daemon está alcançável. REGRA DE DIAGNÓSTICO — ver `[etherbit]
// ponte carregando` SEM o `Ping OK` seguinte no journal significa daemon fora/inacessível (a causa
// da inércia silenciosa: o `callDBus` do KWin engole `ServiceUnknown` e o callback nunca dispara).
log('ponte carregando; testando daemon em', BUS_NAME);
callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'Ping', (status: string) => {
  log('Ping OK — daemon respondeu:', status);
});

// ---- Estado leve da ponte (ver ADR 0016/0017: o daemon permanece sem estado) ----

/// Ordem estável das janelas por `(monitor, desktop)`, chaveada pelo `internalId` (string).
const order = new Map<string, string[]>();
/// Grupos `(monitor, desktop)` com tiling desligado (Meta+Y).
const disabled = new Set<string>();
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
/// Último cursor amostrado (throttle por posição) e guarda de reentrância.
let lastCursor: QPoint | null = null;
let resolving = false;
/// Zona quente resolvida no último passo do arrasto (define o drop: stack/split + escopo).
let lastHot: HotZone | null = null;
/// Resize manual em curso: internalId + frame inicial (para derivar borda/delta ao soltar).
let resizeStart: { id: string; rect: { x: number; y: number; width: number; height: number } } | null =
  null;
/// Suprime retile reentrante enquanto aplicamos geometria/minimização.
let applying = false;
/// Sequência de SyncWindows enviados/confirmados. Sem `setTimeout` no sandbox, é assim que
/// detectamos "o daemon não respondeu ao sync anterior" — avisamos no próximo evento de janela.
let syncSeq = 0;
let syncAckSeq = 0;

/// Id estável de sessão da janela (QUuid → string). Coagido para servir de chave de mapa.
function windowId(win: KWinWindow): string {
  return String(win.internalId);
}

/// `true` se a referência ainda aponta para uma janela viva do KWin. O script não expõe flag de
/// destruição: uma janela removida entre o `SyncWindows` e a resposta vira um wrapper órfão, e
/// QUALQUER acesso a propriedade lança `TypeError` ("Could not convert argument 1 ... to const
/// KWin::Window*"). Sondamos `frameGeometry` e tratamos o throw como "janela morta" — assim o
/// relayout pula a referência inválida em vez de abortar inteiro.
function isLiveWindow(win: KWinWindow): boolean {
  try {
    void win.frameGeometry;
    return true;
  } catch (e) {
    return false;
  }
}

/// `true` se a janela está maximizada (o quadro cobre toda a MaximizeArea do seu monitor). O KWin
/// script não expõe o estado de maximização de forma estável, então comparamos a geometria com a área
/// de maximização (API estável). Os gaps do tiling fazem uma janela TILADA medir menos que essa área,
/// evitando falso-positivo no caso comum. Base do Unmaximize Recovery (a maximizada fica fora do grid).
function isMaximized(win: KWinWindow): boolean {
  // Guarda estrita: uma janela destruída faz o binding C++ lançar TypeError. Lemos PRIMEIRO uma
  // propriedade da PRÓPRIA janela (`frameGeometry`, um GET): um wrapper órfão lança já aqui, antes de
  // passar a referência morta para `workspace.clientArea(..., win)` — que logaria "Could not convert
  // argument 1 ... to const KWin::Window*" no binding (ruído não-capturável pelo try). Só com a
  // janela comprovadamente viva chamamos `clientArea`. Tratamos o throw como "não maximizada".
  try {
    const g = win.frameGeometry;
    const max = workspace.clientArea(KWin.MaximizeArea, win);
    return (
      Math.abs(g.x - max.x) <= 1 &&
      Math.abs(g.y - max.y) <= 1 &&
      Math.abs(g.width - max.width) <= 1 &&
      Math.abs(g.height - max.height) <= 1
    );
  } catch (e) {
    return false;
  }
}

/// Saídas (monitores) presentes, na ordem de descoberta pelas janelas atuais.
function collectOutputs(): KWinOutput[] {
  const outputs: KWinOutput[] = [];
  for (const win of workspace.windowList()) {
    // Um wrapper órfão em `windowList()` faz `win.output` lançar TypeError e abortaria todo o
    // `retile()` (este é o PRIMEIRO acesso a janela no ciclo). Pula a referência morta.
    if (!isLiveWindow(win)) {
      continue;
    }
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
  for (const win of workspace.windowList()) {
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

/// Libera as janelas do grid para o comportamento flutuante do sistema (chave geral desligada):
/// baixa (remove keepAbove) as que elevamos por auto-floating. Envolto em `applying` para não disparar
/// retile reentrante via `keepAboveChanged`. O estado leve (ordem/árvores) é PRESERVADO — religar
/// reorganiza tudo de volta. Idempotente.
function releaseToFloating(): void {
  if (floatingAbove.size === 0) {
    return;
  }
  applying = true;
  try {
    for (const win of workspace.windowList()) {
      if (!isLiveWindow(win)) {
        continue;
      }
      const id = windowId(win);
      if (floatingAbove.has(id) && win.keepAbove) {
        win.keepAbove = false;
      }
    }
  } finally {
    applying = false;
  }
  floatingAbove.clear();
}

/// Coleta janelas + monitores na ORDEM estável, pede o layout ao daemon (com o estado de árvores +
/// grupos desligados) e aplica os retângulos (pull). Não faz nada durante um arrasto nem reentrante.
function retile(): void {
  if (draggedId !== null || applying) {
    return;
  }

  // Chave geral DESLIGADA: pausa o laço (não envia `SyncWindows`) e libera as janelas para flutuar.
  // O daemon segue vivo; o estado leve é preservado para o religar reorganizar tudo no grid.
  if (!tilingEnabled) {
    releaseToFloating();
    return;
  }

  // Detector de daemon-ausente (sem timer no sandbox): se havia janelas e o sync anterior nunca
  // foi confirmado, o canal está mudo. Sempre logado — é o sinal que faltava na falha silenciosa.
  if (workspace.windowList().length > 0 && syncAckSeq < syncSeq) {
    log('AVISO: SyncWindows anterior sem resposta (', syncAckSeq, '/', syncSeq,
      ') — daemon provavelmente fora do barramento');
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
  for (const win of workspace.windowList()) {
    // Janela morta entre dois `retile()` ainda aparece aqui; tocar `internalId`/`output`/`desktops`
    // lançaria TypeError e abortaria o relayout inteiro (a fila do D-Bus nunca seria drenada). Pula
    // a referência inválida — espelha a blindagem já aplicada no caminho de apply pós-resposta.
    if (!isLiveWindow(win)) {
      continue;
    }
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
      const normal = entry.win.normalWindow;
      const resizable = entry.win.resizeable;
      const maximizable = entry.win.maximizable;
      // "Forçar frame, ignorar hints" (ADR 0021/0026): janelas que SERÃO tiladas (normal + resizable
      // + maximizable) NÃO enviam geometry hints. Apps com travas rígidas (incrementos de célula de
      // texto) seriam AUTO-FLUTUADOS/"perdidos" pelo core quando o mínimo não cabe na célula 3×3.
      // Zerando o mínimo, o app é FIXADO na célula em vez de fugir do grid. Espelha a ponte GNOME.
      const min = normal && resizable && maximizable ? null : entry.win.minSize;
      snapshots.push({
        id,
        app_id: entry.win.resourceClass || entry.win.resourceName || '',
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
        normal,
        resizable,
        maximizable,
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
  const focusedStable = aw && isLiveWindow(aw) ? windowId(aw) : '';

  syncSeq += 1;
  const mySeq = syncSeq;
  debug('retile: enviando SyncWindows com', snapshots.length, 'janelas (seq', mySeq, ')');

  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'SyncWindows',
    serializeWindows(snapshots),
    serializeMonitors(monitorsFrom(outputs)),
    serializeState(disabled, transportOf, trees, focusedStable),
    (layoutJson: string) => {
      syncAckSeq = mySeq;
      // Persiste as árvores reconciliadas (traduzidas de volta para internalId).
      trees = parseLayoutTrees(layoutJson, transportToStable);
      const commands = parseLayout(layoutJson);
      debug('SyncWindows OK (seq', mySeq, ') — retângulos:', commands.length);
      // Janelas isoladas por auto-floating (mínimo não cabe): aplicar e ELEVAR (keepAbove).
      const floating = parseFloating(layoutJson);
      const floatingHere = new Set<string>();

      applying = true;
      // Alguma janela do snapshot morreu entre o envio do SyncWindows e esta resposta? Ao detectar,
      // pulamos a referência inválida (sem abortar o apply) e re-tilamos uma vez no fim para o daemon
      // recalcular a árvore BSP com o conjunto atual — preenchendo o quadrante da janela fechada.
      let sawDead = false;
      try {
        // Aplica a geometria das janelas tiladas. Pula janelas MAXIMIZADAS — sobrescrever a geometria
        // as desmaximizaria. O compositor as mantém maximizadas por cima do slot reservado; ao
        // desmaximizar, um novo relayout aplica o slot (Unmaximize Recovery).
        for (const command of commands) {
          const win = byId.get(command.id);
          if (!win) {
            continue;
          }
          if (!isLiveWindow(win)) {
            sawDead = true;
            continue;
          }
          if (!isMaximized(win)) {
            win.frameGeometry = {
              x: command.x,
              y: command.y,
              width: command.width,
              height: command.height,
            };
          }
        }
        // Aplica a geometria das flutuantes (centralizadas pelo core) e as eleva acima do grid.
        for (const command of floating) {
          const win = byId.get(command.id);
          if (!win) {
            continue;
          }
          if (!isLiveWindow(win)) {
            sawDead = true;
            continue;
          }
          win.frameGeometry = {
            x: command.x,
            y: command.y,
            width: command.width,
            height: command.height,
          };
          // Só escreve quando MUDA: reescrever `keepAbove = true` a cada relayout reemite
          // `keepAboveChanged` e RE-EMPILHA a janela, podendo roubar o raise/foco de quem o usuário
          // está usando (a "perda de foco errática"). Com a cascata da Frente C o floating já é raro;
          // este guarda elimina o churn residual de quem permanece flutuante entre ciclos.
          if (!win.keepAbove) {
            win.keepAbove = true;
          }
          floatingHere.add(windowId(win));
        }
        // Baixa quem deixou de flutuar (voltou ao grid): remove o keepAbove que nós pusemos.
        for (const sid of floatingAbove) {
          if (!floatingHere.has(sid)) {
            const w = stableToWin.get(sid);
            if (w && isLiveWindow(w)) {
              w.keepAbove = false;
            } else if (w) {
              sawDead = true;
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

      // Janela morreu durante o apply (snapshot velho): re-tila uma vez (o `applying` já é false) para
      // encaixar o quadrante. Converge na próxima passada.
      if (sawDead) {
        retile();
      }
    },
  );
}

// ---- Atalhos globais (Meta+Shift+Y geral / Meta+Y por workspace) ----

registerShortcut(
  'EtherbitToggleEnabled',
  'Etherbit: ativa/desativa o tiling (chave geral)',
  'Meta+Shift+Y',
  () => {
    tilingEnabled = !tilingEnabled;
    // Persiste/propaga no daemon (config compartilhada). Não reescreve o kwinrc — o estado de runtime
    // volta ao default do KCM se o script recarregar (limitação aceita: ver ADR 0027).
    callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetEnabled', tilingEnabled);
    log('tiling', tilingEnabled ? 'ATIVADO' : 'DESATIVADO', '(chave geral)');
    // Desligado: `retile` libera as janelas. Ligado: reorganiza tudo de volta no grid.
    retile();
  },
);
registerShortcut(
  'EtherbitToggleTiling',
  'Etherbit: liga/desliga o tiling no workspace atual',
  'Meta+Y',
  () => {
    toggleGroupDisabled(disabled, activeGroupKey());
    retile();
  },
);

// ---- Arrasto + indicador de drop zone (outline nativo) ----

/// Mostra/posiciona o outline NATIVO para o retângulo resultante; esconde se `null`/zerado. O KWin
/// Script só desenha 1 outline (não as 9 células — limitação do KWin Script, ver ADR 0026). Para a
/// zona `center` (merge), o retângulo é a própria janela-alvo.
function updateOutline(rect: Rect | null): void {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    workspace.hideOutline();
    return;
  }
  workspace.showOutline({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
}

/// Área útil do monitor que contém `(x, y)` (fallback: o primeiro monitor, ou um retângulo zerado).
function monitorRectUnder(x: number, y: number): Rect {
  const monitors = monitorsFrom(collectOutputs());
  const hit = monitors.find(
    (m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height,
  );
  const m = hit ?? monitors[0];
  return m
    ? { x: m.x, y: m.y, width: m.width, height: m.height }
    : { x: 0, y: 0, width: 0, height: 0 };
}

/// Início de um move/resize interativo. MOVE → rastreia o cursor (drop zone). RESIZE → captura o
/// frame inicial para derivar borda/delta ao soltar.
function onMoveStart(win: KWinWindow): void {
  if (win.move) {
    resizeStart = null;
    draggedId = windowId(win);
    lastCursor = null;
    resolving = false;
    lastHot = null;
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

/// Tamanho mínimo (px) da janela com `internalId == id`, ou `(0,0)` se ausente/morta. Alimenta o
/// esticão da metade local do preview (ADR 0028).
function draggedMinSize(id: string): { width: number; height: number } {
  for (const win of workspace.windowList()) {
    if (windowId(win) !== id || !isLiveWindow(win)) {
      continue;
    }
    const min = win.minSize;
    if (min) {
      return { width: Math.max(0, Math.round(min.width)), height: Math.max(0, Math.round(min.height)) };
    }
    return { width: 0, height: 0 };
  }
  return { width: 0, height: 0 };
}

/// Um passo do arrasto: calcula a zona quente LOCALMENTE (ADR 0028 — sem D-Bus por passo) e atualiza o
/// outline nativo com o retângulo resultante. Throttle por posição (pula se o cursor não moveu).
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
  const monitor = monitorRectUnder(cursor.x, cursor.y);
  // Min da janela em arrasto: estica a metade local do preview se o min-size exigir (ADR 0028).
  const hot = resolveHotZone({ x: cursor.x, y: cursor.y }, targetRect, monitor, draggedMinSize(draggedId));
  lastHot = hot;
  // Preview via outline NATIVO do KWin (o daemon não desenha nada — é geometria pura). Contorno do
  // retângulo-destino da zona quente; `none` esconde.
  updateOutline(hot.dropZone === 'none' ? null : hot.outline);
  resolving = false;
}

/// Fim do arrasto: esconde o outline e consolida o drop (ADR 0028). Centro de uma janela → SWAP (o core
/// troca as duas); borda sobre uma janela → split do slot do alvo; gap vazio → inserção global de 50% /
/// maximizar. Tudo via MoveWindow (move na árvore persistente, traduzindo ids via os mapas do retile).
function onMoveFinish(win: KWinWindow): void {
  workspace.hideOutline();
  const dragged = draggedId;
  const hot = lastHot;
  draggedId = null;
  lastCursor = null;
  resolving = false;
  lastHot = null;

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
  const draggedT = lastTransportOf.get(dragged);

  // MoveWindow (ADR 0028): IDs como string decimal (o `callDBus` do KWin não empacota uint64 — ADR
  // 0009); `scope` define local (split do slot do alvo / swap no centro) vs global (50% / maximizar).
  const moveWindow = (targetT: number, zoneStr: string, scope: 'local' | 'global'): void => {
    if (draggedT === undefined) {
      retile();
      return;
    }
    callDBus(
      BUS_NAME,
      OBJECT_PATH,
      IFACE,
      'MoveWindow',
      serializeState(disabled, lastTransportOf, trees, dragged),
      String(draggedT),
      String(targetT),
      zoneStr,
      serializeScope(scope),
      (treesJson: string) => {
        trees = parseLayoutTrees(treesJson, lastTransportToStable);
        retile();
      },
    );
  };

  // Escopo global (gap vazio): insere como nó principal do workspace (50%) ou maximiza no centro — não
  // exige janela-alvo.
  if (hot && hot.scope === 'global' && hot.dropZone !== 'none') {
    moveWindow(0, hot.dropZone, 'global');
    return;
  }
  if (!target) {
    retile();
    return;
  }
  // Escopo local sobre uma janela-alvo: o core trata QUALQUER zona — `center` = swap (troca as duas);
  // `left/right/top/bottom` = split 50/50 do slot do alvo. Traduz targetId → transporte e delega.
  const targetT = lastTransportOf.get(windowId(target));
  if (hot && hot.scope === 'local' && hot.dropZone !== 'none' && targetT !== undefined) {
    moveWindow(targetT, hot.dropZone, 'local');
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
      serializeState(disabled, lastTransportOf, trees, start.id),
      // ID como string decimal (o `callDBus` não empacota uint64; daemon faz `parse::<u64>()`). ADR 0009.
      String(idT),
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
  // A janela já pode estar parcialmente destruída: ler `internalId` pode lançar. Se conseguirmos,
  // limpamos o estado leve por id; de qualquer forma re-tilamos para encaixar o quadrante vazio
  // (ids órfãos em `order` são inertes — o próximo retile só considera janelas vivas).
  try {
    const id = windowId(win);
    removeFromOrder(order, id);
  } catch (e) {
    // referência morta — segue direto para o retile
  }
  retile();
});
// O foco mudar pode reorganizar o grid (ordem estável por grupo). Ignora durante a aplicação.
workspace.windowActivated.connect(() => {
  if (applying) {
    return;
  }
  retile();
});

// Rastreia as janelas já abertas e faz o layout inicial.
for (const win of workspace.windowList()) {
  trackWindow(win);
}
retile();

log('ponte carregada, servindo via', BUS_NAME);
