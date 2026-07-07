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
// Abas VISUAIS no KDE (ADR 0039, reverte o "sem abas" do 0028): o centro de uma janela AGRUPA as duas
// em aba (drag-to-group); as bordas dividem o slot do alvo. A matemática vive 100% no Rust; o DESENHO
// das barras e a captura de cliques vivem no helper `etherbit-tiling-preview` (wlr-layer-shell), pois um
// KWin Script não pinta nem captura ponteiro. O script só publica geometria/títulos e aplica as ações.

import { DEFAULT_CONFIG, parseConfig, type TilingConfig } from './config.js';
import {
  serializeWindows,
  serializeMonitors,
  serializeState,
  parseLayout,
  parseTabBars,
  parseLayoutTrees,
  shouldSuppressSpawnMaximize,
  resolveHotZone,
  serializeScope,
  resizeDeltaFrom,
  orderKey,
  appendToOrder,
  removeFromOrder,
  sortByOrder,
  parseOrderKey,
  toggleGroupDisabled,
  removeIdFromStacks,
  isStackMember,
  addToStack,
  setActiveMember,
  toggleStackGroup,
  buildTabBarViews,
  serializeTabBars,
  parseTabActions,
  type Stack,
  type TreeNode,
  type Rect,
  type TabBarView,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';

const BUS_NAME = 'dev.ediano.etherbit.Tiling';
const OBJECT_PATH = '/dev/ediano/etherbit/Tiling';
const IFACE = 'dev.ediano.etherbit.Tiling';

// Helper de preview TRANSLÚCIDO (processo separado, wlr-layer-shell + SHM). Um KWin Script só desenha
// `showOutline` (contorno opaco); a máscara translúcida (alpha 0.3–0.4) vem deste helper, acionado por
// D-Bus durante o drag. Se o helper não estiver no barramento, a chamada é no-op e o outline nativo
// (fallback) segue valendo. Ver ADR 0029 (emenda) e 0013.
const PREVIEW_BUS = 'dev.ediano.etherbit.Preview';
const PREVIEW_PATH = '/dev/ediano/etherbit/Preview';
const PREVIEW_IFACE = 'dev.ediano.etherbit.Preview';

// Barras de abas VISUAIS no MESMO helper (ADR 0039): outra interface no mesmo processo/objeto. O KWin
// Script publica a geometria+títulos (`ShowTabs`), esconde (`HideTabs`) e drena os cliques resolvidos
// pelo helper (`DrainTabActions`). O helper acorda o script via `invokeShortcut` (kglobalaccel) — o
// nome do atalho oculto abaixo DEVE casar com `kglobalaccel::ACTION` do helper.
const TABS_IFACE = 'dev.ediano.etherbit.Tabs';
const TAB_ACTION_SHORTCUT = 'etherbit-tiling-tab-action';

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
    ignore_list: readConfig('ignoreList', DEFAULT_CONFIG.ignore_list),
    autostart: DEFAULT_CONFIG.autostart,
    rounded_corners: readConfig('roundedCorners', DEFAULT_CONFIG.rounded_corners),
    corner_radius: readConfig('cornerRadius', DEFAULT_CONFIG.corner_radius),
    // Não é chave do kwinrc: os grupos desligados vivem no daemon (ADR 0057) e são hidratados via
    // GetConfig na carga (ver `hydrateDisabledGroups`). Aqui fica só o default do contrato.
    disabled_groups: DEFAULT_CONFIG.disabled_groups,
  };
}

/// Empurra a config lida do kwinrc para o daemon: ele persiste no TOML. NÃO mexe em autostart (o KDE
/// não gerencia mais isso). Os cantos arredondados são propagados por consistência da config; no KDE o
/// arredondamento em si depende do efeito NATIVO de cantos do KWin (um Script não instancia shaders —
/// ver ADR 0019).
function pushConfigToDaemon(cfg: TilingConfig): void {
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetEnabled', cfg.enabled);
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetGap', cfg.gap);
  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'SetRoundedCorners',
    cfg.rounded_corners,
    cfg.corner_radius,
  );
  // Blacklist de apps: enviada como JSON string (não como array `as`) — o `callDBus` do KWin não
  // empacota array de strings de forma confiável no QJSEngine. O daemon expõe `SetIgnoreListJson`
  // exatamente para esta ponte (ver ADR 0009/0055). O core passa a flutuar essas classes (is_tileable).
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetIgnoreListJson', JSON.stringify(cfg.ignore_list));
}

const config = loadConfig();
pushConfigToDaemon(config);

/// Persiste o set `disabled` (grupos com tiling desligado, chaveados pelo NOME do output — ADR 0056) no
/// daemon (ADR 0057), para sobreviver ao reinício do KWin. Chamado a cada toggle Meta+Y. Best-effort: se
/// o daemon estiver fora do barramento, é no-op (o set em memória segue valendo até o próximo start).
function persistDisabledGroups(): void {
  const groups = [...disabled].map((key) => {
    const [monitor, workspace] = parseOrderKey(key);
    return { monitor, workspace };
  });
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'SetDisabledGroups', JSON.stringify(groups));
}

/// Hidrata o set `disabled` a partir da config PERSISTIDA do daemon (GetConfig) na carga do script — o
/// toggle Meta+Y (por monitor/workspace) passa a sobreviver ao reinício do KWin (ADR 0057). Best-effort:
/// se o daemon não responder, o set fica vazio (comportamento anterior). Re-tila ao final para aplicar.
function hydrateDisabledGroups(): void {
  callDBus(BUS_NAME, OBJECT_PATH, IFACE, 'GetConfig', (json: string) => {
    const cfg = parseConfig(json);
    for (const g of cfg.disabled_groups) {
      if (g && typeof g.monitor === 'string') {
        disabled.add(orderKey(g.monitor, g.workspace));
      }
    }
    retile();
  });
}

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

// Hidrata os grupos com tiling desligado a partir da config persistida do daemon (ADR 0057): o toggle
// Meta+Y por monitor/workspace sobrevive ao reinício do KWin. Best-effort (no-op se o daemon não responder).
hydrateDisabledGroups();

// ---- Estado leve da ponte (ver ADR 0016/0017: o daemon permanece sem estado) ----

/// Ordem estável das janelas por `(monitor, desktop)`, chaveada pelo `internalId` (string).
const order = new Map<string, string[]>();
/// Grupos `(monitor, desktop)` com tiling desligado (Meta+Y).
const disabled = new Set<string>();
/// internalIds que o core JÁ tilou ao menos uma vez. Uma janela maximizada que NUNCA foi tilada
/// "nasceu maximizada" → spawn-unmaximize (entra na Distribuição Cíclica). Já uma janela tilada que o
/// usuário maximiza é PRESERVADA (volta ao slot ao desmaximizar — Unmaximize Recovery).
const everTiled = new Set<string>();
/// Instante (ms, `Date.now`) do nascimento de cada janela — base da janela de graça de spawn-unmaximize
/// (ADR 0043). Dentro dela, QUALQUER maximização é tratada como spawn e desmaximizada, mesmo já tilada:
/// apps de restore lento auto-maximizam depois do `windowAdded`. Limpo no `windowRemoved`.
const spawnAt = new Map<string, number>();
/// Duração (ms) da janela de graça de spawn-unmaximize. Espelha `SPAWN_MAXIMIZE_GRACE_US` do GNOME.
const SPAWN_MAXIMIZE_GRACE_MS = 1500;
/// Árvores BSP persistentes por `(monitor, desktop)`, com folhas em internalId (forma canônica).
/// O core reconcilia e devolve a versão atualizada a cada SyncWindows/MoveWindow.
let trees = new Map<string, TreeNode | null>();
/// Abas (stacks) por `(monitor, desktop)`, com membros em internalId. Criadas só MANUALMENTE
/// (drag-to-group na zona `center`; Meta+S); enviadas a cada SyncWindows para o core materializar.
const stacks = new Map<string, Stack[]>();
/// Membros de stack OCULTOS (minimizados) por nós — para reexibir ao saírem do stack/aba inativa.
const stackHidden = new Set<string>();
/// Mapas de transporte do ÚLTIMO retile (internalId ↔ id opaco), reusados no drop (sem retile no meio
/// do arrasto, eles seguem válidos para as janelas pré-existentes).
let lastTransportOf = new Map<string, number>();
let lastTransportToStable = new Map<number, string>();
/// Tradução nome-do-output ↔ índice numérico do ÚLTIMO retile (ADR 0056). O estado da ponte é chaveado
/// por nome; o contrato do daemon/core usa o índice atual. Reusados no drop (serializeState/parse) sem
/// um retile no meio do arrasto.
let lastNameToIndex = new Map<string, number>();
let lastIndexToName = new Map<number, string>();

/// `internalId` da janela em arrasto (null fora de um move).
let draggedId: string | null = null;
/// Último cursor amostrado (throttle por posição) e guarda de reentrância.
let lastCursor: QPoint | null = null;
let resolving = false;
/// Resize manual em curso: internalId + frame inicial (para derivar borda/delta ao soltar).
let resizeStart: {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
} | null = null;
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

/// `true` se a janela `id` ainda está na janela de graça de spawn (`SPAWN_MAXIMIZE_GRACE_MS` desde o
/// nascimento, ADR 0043). Dentro dela, uma maximização é sempre "de spawn" (mesmo já tilada) e é
/// suprimida — cobre o app de restore lento que auto-maximiza depois do `windowAdded`. Sem registro de
/// nascimento (janela desconhecida), retorna `false` (fora da graça: comportamento manual).
function withinSpawnGrace(id: string): boolean {
  const born = spawnAt.get(id);
  if (born === undefined) {
    return false;
  }
  return Date.now() - born < SPAWN_MAXIMIZE_GRACE_MS;
}

/// Spawn-unmaximize: com o Tiling ATIVO, uma janela maximizada que o core ainda NÃO tilou "nasceu
/// maximizada" — desmaximiza para entrar na Distribuição Cíclica. Uma janela já tilada que o usuário
/// maximiza FORA da janela de graça é PRESERVADA (volta ao slot ao desmaximizar — Unmaximize Recovery).
/// A decisão vive no predicado puro `shouldSuppressSpawnMaximize` (ADR 0043); ver `withinSpawnGrace`.
/// Defensivo: `setMaximize` é opcional e a referência pode estar morta — nunca derruba o retile.
function spawnUnmaximizeIfBorn(win: KWinWindow): void {
  try {
    if (!isLiveWindow(win)) {
      return;
    }
    const id = windowId(win);
    if (
      !shouldSuppressSpawnMaximize({
        enabled: tilingEnabled,
        isMaximized: isMaximized(win),
        everTiled: everTiled.has(id),
        withinSpawnGrace: withinSpawnGrace(id),
      })
    ) {
      return;
    }
    win.setMaximize?.(false, false);
  } catch (e) {
    // referência morta / API ausente — ignora (a janela segue como está; o retile cuida do resto)
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

/// Token de identidade ESTÁVEL de um monitor (ADR 0056): o NOME do conector (`output.name`, ex. "DP-1").
/// É a chave do estado persistente por monitor — o índice posicional muda com hotplug/reordenação e
/// remaparia árvores/stacks/disabled para o monitor físico errado. Fallback defensivo: se o KWin não
/// expuser `name`, cai no índice posicional (`#idx`, comportamento legado) — pior isolamento, nunca crash.
function outputNameOf(output: KWinOutput): string {
  const raw = output && typeof output === 'object' ? output.name : undefined;
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  const idx = collectOutputs().indexOf(output);
  return `#${idx < 0 ? 0 : idx}`;
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
  if (aw && isLiveWindow(aw)) {
    return orderKey(outputNameOf(aw.output), desktopIndexOf(aw));
  }
  const cur = (workspace.desktops ?? []).indexOf(workspace.currentDesktop);
  // Sem janela ativa: usa o primeiro monitor conhecido (nome), ou o token sintético do índice 0.
  const firstOutput = collectOutputs()[0];
  const name = firstOutput ? outputNameOf(firstOutput) : '#0';
  return orderKey(name, cur < 0 ? 0 : cur);
}

/// Janela NORMAL cujo frame contém `(x, y)`, excluindo `excludeId` (a arrastada).
///
/// Blindagem de hardware real (ADR 0058 — Sintoma A): a `windowList()` do KWin inclui janelas mortas,
/// abas inativas MINIMIZADAS (frame fantasma sobre o slot) e janelas de OUTRO desktop virtual, todas com
/// coordenadas que podem conter `(x, y)`. Se qualquer uma "vencer" o lookup, o alvo fica errado; se o
/// alvo real for descartado, `resolveHotZone` cai no ramo GLOBAL (edge-tiling) e o agrupamento por aba
/// nunca é acionado no arraste. Filtramos as três antes do teste geométrico. Tocar `internalId`/
/// `frameGeometry` de uma janela morta lança TypeError e abortaria o lookup inteiro — por isso o
/// `isLiveWindow` vem PRIMEIRO.
function windowUnderPointObj(x: number, y: number, excludeId: string): KWinWindow | null {
  // Desktop virtual da janela arrastada: o alvo válido está no MESMO desktop (a lista mistura desktops).
  let draggedDesktop = -1;
  for (const win of workspace.windowList()) {
    if (isLiveWindow(win) && windowId(win) === excludeId) {
      draggedDesktop = desktopIndexOf(win);
      break;
    }
  }
  for (const win of workspace.windowList()) {
    if (!isLiveWindow(win) || !win.normalWindow || win.minimized) {
      continue;
    }
    if (windowId(win) === excludeId) {
      continue;
    }
    if (draggedDesktop >= 0 && desktopIndexOf(win) !== draggedDesktop) {
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
/// reexibe as abas inativas que NÓS ocultamos. Envolto em `applying` para não disparar retile
/// reentrante. O estado leve (ordem/árvores/stacks) é PRESERVADO — religar reorganiza tudo de volta.
/// Idempotente.
function releaseToFloating(): void {
  if (stackHidden.size === 0) {
    return;
  }
  applying = true;
  try {
    for (const win of workspace.windowList()) {
      if (!isLiveWindow(win)) {
        continue;
      }
      // Reexibe as abas inativas que NÓS ocultamos: a chave geral deve liberar tudo (o estado de
      // stacks é preservado para o religar reorganizar de volta).
      if (stackHidden.has(windowId(win)) && win.minimized) {
        win.minimized = false;
      }
    }
  } finally {
    applying = false;
  }
  stackHidden.clear();
  // Tiling desligado: nenhuma barra de abas deve permanecer no overlay.
  pushTabs([]);
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
    log(
      'AVISO: SyncWindows anterior sem resposta (',
      syncAckSeq,
      '/',
      syncSeq,
      ') — daemon provavelmente fora do barramento',
    );
  }

  const outputs = collectOutputs();
  const monitorIndexOf = (output: KWinOutput): number => outputs.indexOf(output);
  // Tradução estável nome↔índice deste ciclo (ADR 0056): o estado da ponte (order/trees/stacks/disabled)
  // é chaveado pelo NOME do output; o contrato do daemon/core usa o índice numérico atual. Guardados em
  // módulo para o caminho de arrasto (onMoveFinish) reusar sem um retile no meio.
  const indexToName = new Map<number, string>();
  const nameToIndex = new Map<string, number>();
  outputs.forEach((output, index) => {
    const name = outputNameOf(output);
    indexToName.set(index, name);
    nameToIndex.set(name, index);
  });
  lastNameToIndex = nameToIndex;
  lastIndexToName = indexToName;

  interface Entry {
    win: KWinWindow;
    stableId: string;
    monitor: number;
    monitorName: string;
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
    const monitor = monitorIndexOf(win.output);
    const entry: Entry = {
      win,
      stableId: windowId(win),
      monitor,
      monitorName: indexToName.get(monitor) ?? outputNameOf(win.output),
      desktop: desktopIndexOf(win),
    };
    const key = orderKey(entry.monitorName, entry.desktop);
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
      // Min-size REAL (ADR 0033, inverte o "força frame, ignora hints" do 0021/0026): no Wayland o
      // cliente RECUSA encolher abaixo do seu min_size — zerar o hint só o faz transbordar/ser ejetado.
      // Enviamos o mínimo real e o core o respeita via esmagamento impositivo (ADR 0040): a janela
      // rígida recebe ≥ seu mínimo e os vizinhos comprimem. Espelha a ponte GNOME.
      const min = entry.win.minSize;
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
    serializeState(stacks, disabled, transportOf, trees, focusedStable, nameToIndex),
    (layoutJson: string) => {
      syncAckSeq = mySeq;
      // Persiste as árvores reconciliadas (traduzidas de volta para internalId e para a chave por nome).
      trees = parseLayoutTrees(layoutJson, transportToStable, indexToName);
      const commands = parseLayout(layoutJson);
      const tabBars = parseTabBars(layoutJson);
      debug('SyncWindows OK (seq', mySeq, ') — retângulos:', commands.length);

      // Abas inativas a ocultar (minimizar): todo membro de stack que não é o ativo (ids de transporte).
      const shouldHide = new Set<string>();
      for (const bar of tabBars) {
        for (const member of bar.members) {
          if (member !== bar.active) {
            const sid = transportToStable.get(member);
            if (sid !== undefined) {
              shouldHide.add(sid);
            }
          }
        }
      }

      applying = true;
      // Alguma janela do snapshot morreu entre o envio do SyncWindows e esta resposta? Ao detectar,
      // pulamos a referência inválida (sem abortar o apply) e re-tilamos uma vez no fim para o daemon
      // recalcular a árvore BSP com o conjunto atual — preenchendo o quadrante da janela fechada.
      let sawDead = false;
      try {
        // Reexibe membros que deixaram de estar ocultos (viraram a aba ativa, ou o stack se desfez).
        for (const sid of stackHidden) {
          if (!shouldHide.has(sid)) {
            const w = stableToWin.get(sid);
            if (w && isLiveWindow(w) && w.minimized) {
              w.minimized = false;
            }
          }
        }
        // Oculta (minimiza) as abas inativas dos stacks — o core não as inclui em `commands`.
        for (const sid of shouldHide) {
          const w = stableToWin.get(sid);
          if (w && isLiveWindow(w) && !w.minimized) {
            w.minimized = true;
          }
        }
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
          // O core deu um slot a esta janela → ela já foi tilada. A partir daqui, maximizá-la é ação
          // MANUAL do usuário (preservada); só "nasceu maximizada" quem nunca apareceu aqui (spawn).
          everTiled.add(windowId(win));
          if (!isMaximized(win)) {
            win.frameGeometry = {
              x: command.x,
              y: command.y,
              width: command.width,
              height: command.height,
            };
          }
        }
      } finally {
        applying = false;
      }
      stackHidden.clear();
      for (const sid of shouldHide) {
        stackHidden.add(sid);
      }

      // ADR 0039: publica as barras de abas no helper de overlay (desenho + cliques). O título sai
      // daqui (`win.caption`) — o contrato do daemon não carrega títulos (ADR 0029).
      pushTabs(
        buildTabBarViews(tabBars, transportToStable, (sid) => {
          const w = stableToWin.get(sid);
          return w && isLiveWindow(w) ? w.caption : '';
        }),
      );

      // Janela morreu durante o apply (snapshot velho): re-tila uma vez (o `applying` já é false) para
      // encaixar o quadrante. Converge na próxima passada.
      if (sawDead) {
        retile();
      }
    },
  );
}

// ---- Barras de abas: publicação + drenagem de ações (ADR 0039) ----

/// Assinatura do último `ShowTabs` enviado — evita reemitir D-Bus quando nada mudou.
let lastTabsKey = '';

/// Publica (ou esconde) as barras de abas no helper de overlay. Dedup por JSON: só chama o D-Bus quando
/// o conjunto/geometria muda. Best-effort: se o helper não estiver no barramento, é no-op.
function pushTabs(views: TabBarView[]): void {
  if (views.length === 0) {
    if (lastTabsKey !== '') {
      lastTabsKey = '';
      callDBus(PREVIEW_BUS, PREVIEW_PATH, TABS_IFACE, 'HideTabs');
    }
    return;
  }
  const json = serializeTabBars(views);
  if (json !== lastTabsKey) {
    lastTabsKey = json;
    callDBus(PREVIEW_BUS, PREVIEW_PATH, TABS_IFACE, 'ShowTabs', json);
  }
}

/// Janela viva cujo `internalId` == `id` (sem mapa persistente — robusto a janelas mortas).
function winByStableId(id: string): KWinWindow | null {
  for (const win of workspace.windowList()) {
    if (isLiveWindow(win) && windowId(win) === id) {
      return win;
    }
  }
  return null;
}

/// internalIds (na ordem estável) das janelas NORMAIS do grupo `(monitor, desktop)` == `key`. Base do
/// Meta+S (agrupar/desagrupar todo o grupo).
function groupWindowIds(key: string): string[] {
  const ids: string[] = [];
  for (const win of workspace.windowList()) {
    if (!isLiveWindow(win) || !win.normalWindow) {
      continue;
    }
    const k = orderKey(outputNameOf(win.output), desktopIndexOf(win));
    if (k === key) {
      ids.push(windowId(win));
    }
  }
  return sortByOrder(order, key, ids);
}

/// Drena do helper as ações de clique acumuladas (ativar/fechar/desagrupar) e as aplica. Disparado pelo
/// atalho oculto que o helper invoca via kglobalaccel após cada clique (o KWin Script não assina sinais).
function drainTabActions(): void {
  callDBus(PREVIEW_BUS, PREVIEW_PATH, TABS_IFACE, 'DrainTabActions', (json: string) => {
    applyTabActions(json);
  });
}

/// Aplica as ações resolvidas pelo helper. `activate` muda a aba ativa e foca a janela; `close` fecha a
/// janela (→ `windowRemoved` → retile); `ungroup` tira a janela do stack (o core a reinsere no grid
/// cíclico via `insert_cyclic` no próximo sync). Re-tila quando o estado leve muda.
function applyTabActions(json: string): void {
  const actions = parseTabActions(json);
  if (actions.length === 0) {
    return;
  }
  let needRetile = false;
  for (const action of actions) {
    if (action.kind === 'activate') {
      if (setActiveMember(stacks, action.member_id)) {
        needRetile = true;
      }
      const win = winByStableId(action.member_id);
      if (win) {
        try {
          workspace.activeWindow = win;
        } catch (e) {
          // referência morta — ignora
        }
      }
    } else if (action.kind === 'close') {
      const win = winByStableId(action.member_id);
      if (win) {
        try {
          win.closeWindow();
        } catch (e) {
          // referência morta — ignora (o retile encaixa o quadrante)
        }
      }
    } else if (action.kind === 'ungroup_drag') {
      // Ejeta por arraste E reposiciona no ponto de soltura ("cai onde foi solta", ADR 0042). Traduz o
      // id ANTES de mexer no stack (o mapa de transporte é do último retile). Se conseguir resolver uma
      // zona de drop, delega ao core via MoveWindow (que destaca a aba do stack na árvore e a reinsere no
      // alvo); sem zona útil, ejeta reancorando o grupo NO LUGAR (zona `eject`, ADR 0045) em vez de cair
      // no reconcile que teleportava; sem transporte conhecido, reinsere no grid cíclico no sync.
      const draggedT = lastTransportOf.get(action.member_id);
      const ejected = removeIdFromStacks(stacks, action.member_id);
      const placed =
        draggedT !== undefined && dropEjectedAt(action.member_id, draggedT, action.x, action.y);
      if (!placed && ejected) {
        if (draggedT !== undefined) {
          ejectFromStack(action.member_id, draggedT);
        } else {
          needRetile = true;
        }
      }
    } else {
      // ungroup (menu "Desagrupar") → ejeta reancorando o grupo NO LUGAR via core (zona `eject`, ADR
      // 0045); o reconcile reinsere a ejetada ciclicamente. Sem o teleporte que reabsorvia a 1ª ejetada
      // e capturava uma janela externa. Traduz o id ANTES de mexer no stack (o transporte é do último
      // retile). Sem transporte conhecido, cai no reencaixe cíclico do sync (fallback antigo).
      const draggedT = lastTransportOf.get(action.member_id);
      if (removeIdFromStacks(stacks, action.member_id)) {
        if (draggedT !== undefined) {
          ejectFromStack(action.member_id, draggedT);
        } else {
          needRetile = true;
        }
      }
    }
  }
  if (needRetile) {
    retile();
  }
}

/// Ejeta `draggedStable` (transporte `draggedT`) do stack SEM alvo — menu "Desagrupar" e fallback do
/// drag-to-ungroup solto no vazio (ADR 0045). O core (zona `eject`) faz `detach_window`: o grupo
/// remanescente REancora NO LUGAR (slot preservado) e o `reconcile` seguinte reinsere a ejetada pela
/// distribuição cíclica — sem o teleporte que capturava janelas externas (o "efeito ímã"). O chamador já
/// fez `removeIdFromStacks`; aqui só materializa no core e re-tila na resposta.
function ejectFromStack(draggedStable: string, draggedT: number): void {
  callDBus(
    BUS_NAME,
    OBJECT_PATH,
    IFACE,
    'MoveWindow',
    serializeState(stacks, disabled, lastTransportOf, trees, draggedStable, lastNameToIndex),
    String(draggedT),
    '0',
    'eject',
    serializeScope('local'),
    (treesJson: string) => {
      trees = parseLayoutTrees(treesJson, lastTransportToStable, lastIndexToName);
      retile();
    },
  );
}

/// Reposiciona a janela recém-ejetada `draggedStable` (transporte `draggedT`) na zona de drop resolvida
/// em `(x, y)` — coordenadas GLOBAIS de tela (ADR 0042, "cai onde foi solta"). Espelha `onMoveFinish`:
/// escopo global (gap vazio) = bloco de 50% / maximizar; escopo local (sobre uma janela) = split do slot
/// do alvo. Emite `MoveWindow` (o core usa `detach_window` para tirar a aba do stack e reinseri-la) e
/// re-tila na resposta. Devolve `true` se disparou o MoveWindow; `false` se não havia zona útil (o
/// chamador cai no `ejectFromStack`, ADR 0045).
function dropEjectedAt(draggedStable: string, draggedT: number, x: number, y: number): boolean {
  const target = windowUnderPointObj(x, y, draggedStable);
  const targetRect = target
    ? {
        x: target.frameGeometry.x,
        y: target.frameGeometry.y,
        width: target.frameGeometry.width,
        height: target.frameGeometry.height,
      }
    : null;
  const monitor = monitorRectUnder(x, y);
  const hot = resolveHotZone({ x, y }, targetRect, monitor, draggedMinSize(draggedStable));
  if (hot.dropZone === 'none') {
    return false;
  }
  const emit = (targetT: number, zoneStr: string, scope: 'local' | 'global'): void => {
    callDBus(
      BUS_NAME,
      OBJECT_PATH,
      IFACE,
      'MoveWindow',
      serializeState(stacks, disabled, lastTransportOf, trees, draggedStable, lastNameToIndex),
      String(draggedT),
      String(targetT),
      zoneStr,
      serializeScope(scope),
      (treesJson: string) => {
        trees = parseLayoutTrees(treesJson, lastTransportToStable, lastIndexToName);
        retile();
      },
    );
  };
  if (hot.scope === 'global') {
    emit(0, hot.dropZone, 'global');
    return true;
  }
  if (target) {
    const targetT = lastTransportOf.get(windowId(target));
    if (targetT !== undefined) {
      emit(targetT, hot.dropZone, 'local');
      return true;
    }
  }
  return false;
}

// ---- Atalhos globais (Meta+Shift+Y geral / Meta+Y por workspace / Meta+S abas) ----

// Atalho OCULTO (sem tecla): o helper de abas o invoca via kglobalaccel após um clique para que o script
// DRENE e aplique a ação (ADR 0039). O nome casa com `kglobalaccel::ACTION` do helper.
registerShortcut(TAB_ACTION_SHORTCUT, 'Etherbit: aplicar ação de aba (interno)', '', () =>
  drainTabActions(),
);
registerShortcut(
  'EtherbitToggleTabbing',
  'Etherbit: agrupa/desagrupa as janelas em abas (workspace atual)',
  'Meta+S',
  () => {
    const key = activeGroupKey();
    const ids = groupWindowIds(key);
    const aw = workspace.activeWindow;
    const activeId = aw && isLiveWindow(aw) ? windowId(aw) : (ids[0] ?? '');
    if (toggleStackGroup(stacks, key, ids, activeId)) {
      retile();
    }
  },
);

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
    // Persiste no daemon (ADR 0057): o grupo desligado sobrevive ao reinício do KWin.
    persistDisabledGroups();
    retile();
  },
);

// ---- Arrasto + indicador de drop zone (outline nativo) ----

/// Assinatura do último retângulo enviado ao preview translúcido — evita reemitir D-Bus por pixel
/// (o helper só precisa do estado quando a ZONA muda).
let lastPreviewKey = '';

/// Mostra/posiciona o preview para o retângulo resultante; esconde se `null`/zerado. Duas camadas:
///  1) outline NATIVO (`workspace.showOutline`) — sempre disponível, mas contorno OPACO (fallback);
///  2) máscara TRANSLÚCIDA (alpha 0.3–0.4) via o helper `etherbit-tiling-preview` por D-Bus — o KWin
///     Script não pinta superfícies próprias (só `showOutline`); a translucidez vem do helper.
/// Se o helper não estiver no barramento, a chamada é no-op e o outline cobre o caso. Para a zona
/// `center` (merge/swap), o retângulo é a própria janela-alvo.
function updateOutline(rect: Rect | null): void {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    workspace.hideOutline();
    if (lastPreviewKey !== '') {
      lastPreviewKey = '';
      callDBus(PREVIEW_BUS, PREVIEW_PATH, PREVIEW_IFACE, 'HidePreview');
    }
    return;
  }
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  workspace.showOutline({ x, y, width, height });
  const key = `${x},${y},${width},${height}`;
  if (key !== lastPreviewKey) {
    lastPreviewKey = key;
    callDBus(PREVIEW_BUS, PREVIEW_PATH, PREVIEW_IFACE, 'ShowPreview', x, y, width, height);
  }
}

/// Área útil do monitor que contém `(x, y)` (fallback: o primeiro monitor, ou um retângulo zerado).
function monitorRectUnder(x: number, y: number): Rect {
  const monitors = monitorsFrom(collectOutputs());
  const hit = monitors.find((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
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
      return {
        width: Math.max(0, Math.round(min.width)),
        height: Math.max(0, Math.round(min.height)),
      };
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
  const hot = resolveHotZone(
    { x: cursor.x, y: cursor.y },
    targetRect,
    monitor,
    draggedMinSize(draggedId),
  );
  // Trace de diagnóstico do arraste (gated por `debug`): rastro de repro em hardware real p/ o Sintoma A
  // (coordenadas do cursor/alvo/monitor + zona resolvida). Sem custo com a chave desligada.
  debug(
    'drag step: cursor',
    cursor.x,
    cursor.y,
    '| target',
    target ? windowId(target) : 'null',
    targetRect ? `${targetRect.x},${targetRect.y} ${targetRect.width}x${targetRect.height}` : '-',
    '| monitor',
    `${monitor.x},${monitor.y} ${monitor.width}x${monitor.height}`,
    '| hot',
    hot.scope,
    hot.dropZone,
  );
  // Preview via outline NATIVO do KWin (o daemon não desenha nada — é geometria pura). Contorno do
  // retângulo-destino da zona quente; `none` esconde.
  updateOutline(hot.dropZone === 'none' ? null : hot.outline);
  resolving = false;
}

/// Fim do arrasto: esconde o outline e consolida o drop (ADR 0028). Centro de uma janela → SWAP (o core
/// troca as duas); borda sobre uma janela → split do slot do alvo; gap vazio → inserção global de 50% /
/// maximizar. Tudo via MoveWindow (move na árvore persistente, traduzindo ids via os mapas do retile).
function onMoveFinish(win: KWinWindow): void {
  updateOutline(null); // esconde outline nativo + preview translúcido (helper)
  const dragged = draggedId;
  draggedId = null;
  lastCursor = null;
  resolving = false;

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

  // Recalcula a zona quente a partir do cursor FINAL (ADR 0058 — Sintoma A): o `lastHot` vem do último
  // `onMoveStep`, que é throttled por posição; se o cursor deu o salto final sem gerar um step, o
  // `lastHot` ficaria defasado do ponto real de drop e o alvo (recomputado aqui) discordaria da zona.
  // Recalcular no ponto real elimina a divergência (e casa com o outline que o usuário viu por último).
  const targetRect = target
    ? {
        x: target.frameGeometry.x,
        y: target.frameGeometry.y,
        width: target.frameGeometry.width,
        height: target.frameGeometry.height,
      }
    : null;
  const hot = resolveHotZone(
    { x: cursor.x, y: cursor.y },
    targetRect,
    monitorRectUnder(cursor.x, cursor.y),
    draggedMinSize(dragged),
  );
  debug(
    'drag finish: cursor',
    cursor.x,
    cursor.y,
    '| target',
    target ? windowId(target) : 'null',
    '| hot',
    hot.scope,
    hot.dropZone,
  );

  // Desagrupar pela BARRA DE TÍTULO NATIVA (ADR 0047): se a janela arrastada é membro de um stack,
  // arrastá-la pela decoração do KWin ejeta SÓ ela e a reposiciona onde foi solta — igual ao arraste
  // da aba no overlay. Reusa o MESMO caminho do `ungroup_drag` (traduz `draggedT` ANTES de mutar,
  // `dropEjectedAt` resolve a zona pelo cursor global, com fallback `ejectFromStack` — zona `eject`,
  // reancora no lugar, ADR 0045). Sem isso o `stacks` Map re-materializava o grupo no próximo `retile`
  // ("agrupamento travado"). Exceção `reGroupCenter`: center sobre OUTRA janela segue reagrupando
  // (`addToStack`, abaixo). Janela SOLTA (não é membro) cai no fluxo normal de move/tile intocado.
  if (isStackMember(stacks, dragged)) {
    const reGroupCenter =
      hot !== null &&
      hot.scope === 'local' &&
      hot.dropZone === 'center' &&
      target !== null &&
      windowId(target) !== dragged;
    if (!reGroupCenter) {
      const ejected = removeIdFromStacks(stacks, dragged);
      // `dropEjectedAt` recomputa a zona pelo cursor e devolve `false` se não houver zona útil
      // ('none') — fonte única da verdade, igual ao ramo `ungroup_drag` do overlay.
      const placed = draggedT !== undefined && dropEjectedAt(dragged, draggedT, cursor.x, cursor.y);
      if (!placed && ejected) {
        if (draggedT !== undefined) {
          ejectFromStack(dragged, draggedT);
        } else {
          retile();
        }
      }
      return;
    }
  }

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
      serializeState(stacks, disabled, lastTransportOf, trees, dragged, lastNameToIndex),
      String(draggedT),
      String(targetT),
      zoneStr,
      serializeScope(scope),
      (treesJson: string) => {
        trees = parseLayoutTrees(treesJson, lastTransportToStable, lastIndexToName);
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
  const targetStable = windowId(target);
  // DRAG-TO-GROUP (ADR 0039): centro de uma janela AGRUPA as duas em aba (não faz swap) — espelha o
  // GNOME, que intercepta o centro NA PONTE e nunca manda `center` ao core. O retile materializa o stack
  // (via `serializeState`), o core devolve a `tab_bar`, e o helper desenha a barra.
  if (hot && hot.scope === 'local' && hot.dropZone === 'center') {
    const key = orderKey(outputNameOf(target.output), desktopIndexOf(target));
    addToStack(stacks, key, targetStable, dragged);
    retile();
    return;
  }
  // Escopo local sobre uma janela-alvo: `left/right/top/bottom` = split 50/50 do slot do alvo. Traduz
  // targetId → transporte e delega ao core.
  const targetT = lastTransportOf.get(targetStable);
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
      serializeState(stacks, disabled, lastTransportOf, trees, start.id, lastNameToIndex),
      // ID como string decimal (o `callDBus` não empacota uint64; daemon faz `parse::<u64>()`). ADR 0009.
      String(idT),
      d.edge,
      d.deltaPx,
      (treesJson: string) => {
        trees = parseLayoutTrees(treesJson, lastTransportToStable, lastIndexToName);
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
  // caso a re-tilagem ocorre no próximo evento de foco/janela). Spawn-unmaximize: se a janela é
  // maximizada e NUNCA foi tilada (nasceu maximizada), desmaximiza para ela entrar na Distribuição
  // Cíclica; uma janela já tilada que o usuário maximiza é preservada (só re-tila).
  if (win.maximizedChanged) {
    win.maximizedChanged.connect(() => {
      if (!applying) {
        spawnUnmaximizeIfBorn(win);
        retile();
      }
    });
  }
}

workspace.windowAdded.connect((win) => {
  trackWindow(win);
  // Marca o instante de nascimento (base da janela de graça, ADR 0043) ANTES do spawn-unmaximize.
  try {
    spawnAt.set(windowId(win), Date.now());
  } catch (e) {
    // referência morta ao ler o id — segue; sem registro a janela cai no ramo "manual" (guard everTiled)
  }
  // Nascimento: com o Tiling ativo, nenhuma janela inicia maximizada (mesmo que o app peça).
  spawnUnmaximizeIfBorn(win);
  retile();
});
workspace.windowRemoved.connect((win) => {
  // A janela já pode estar parcialmente destruída: ler `internalId` pode lançar. Se conseguirmos,
  // limpamos o estado leve por id; de qualquer forma re-tilamos para encaixar o quadrante vazio
  // (ids órfãos em `order` são inertes — o próximo retile só considera janelas vivas).
  try {
    const id = windowId(win);
    removeFromOrder(order, id);
    removeIdFromStacks(stacks, id);
    stackHidden.delete(id);
    everTiled.delete(id);
    spawnAt.delete(id);
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
