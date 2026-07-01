// bridge.ts — contrato e helpers PUROS da ponte KWin ↔ daemon (sem globais do KWin).
//
// Espelho 1:1 do bridge.ts da extensão GNOME (como config.ts já é espelhado). O KWin script é uma
// "ponte burra": coleta metadados das janelas/monitores, chama `SyncWindows` e APLICA os retângulos
// devolvidos. Toda decisão de layout vive no core (Rust). Aqui só a montagem do JSON e o parse
// defensivo — isolados das globais do KWin para serem testáveis em Node/vitest (ver ADR rules/0016).

/// Espelha o `WindowDto` do daemon (etherbit-tiling-daemon/daemon/src/protocol.rs).
export interface WindowSnapshot {
  id: number;
  app_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  normal: boolean;
  resizable: boolean;
  maximizable: boolean;
  monitor: number;
  workspace: number;
  /// Tamanho mínimo imposto pelo app (geometry hint); 0 = sem restrição.
  min_width: number;
  min_height: number;
  /// Janela maximizada no momento (estado). Dispara o tratamento de unmaximize no core.
  maximized: boolean;
}

/// Espelha o `MonitorDto` do daemon (área útil de um monitor).
export interface MonitorSnapshot {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Comando geométrico devolvido pelo daemon: mover/redimensionar a janela `id`.
export interface LayoutCommand {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Espelha o `PreviewDto` do daemon: a zona resolvida + o retângulo do indicador de drop.
export interface DropPreview {
  zone: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Serializa as janelas para o `windows_json` do contrato D-Bus.
export function serializeWindows(windows: WindowSnapshot[]): string {
  return JSON.stringify(windows);
}

/// Serializa os monitores para o `monitors_json` do contrato D-Bus.
export function serializeMonitors(monitors: MonitorSnapshot[]): string {
  return JSON.stringify(monitors);
}

/// Parse defensivo do `layout_json` do daemon — devolve os retângulos a aplicar. Aceita o formato
/// novo (objeto `{ rects, tab_bars }`) e o LEGADO (array de rects). Descarta entradas malformadas.
export function parseLayout(json: string): LayoutCommand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rects = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown> | null)?.rects;
  if (!Array.isArray(rects)) {
    return [];
  }
  const commands: LayoutCommand[] = [];
  for (const entry of rects) {
    if (isLayoutCommand(entry)) {
      commands.push({
        id: entry.id,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
      });
    }
  }
  return commands;
}

/// Um grupo de janelas que COLIDEM na mesma célula (ADR 0041): o core sinaliza que `Σ mins rígidos >
/// avail` colapsou a célula; a ponte agrupa `members` em abas (cada aba recebe a célula inteira e
/// cabe). Os IDs são os de TRANSPORTE (uint do core) — a ponte os traduz para internalId estável.
export interface CollisionGroup {
  cellId: number;
  members: number[];
}

/// Parse defensivo das colisões (`collisions`) do `layout_json` (ADR 0041): conjuntos de janelas cujo
/// espaço físico colapsou, que a ponte agrupa em abas. Ausente (daemon antigo = comportamento 0040) ou
/// malformado → vazio. Filtra grupos com < 2 membros (nada a agrupar).
export function parseCollisions(json: string): CollisionGroup[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const raw = (parsed as Record<string, unknown>).collisions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CollisionGroup[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (!isFiniteNumber(rec.cell_id) || !Array.isArray(rec.members)) {
      continue;
    }
    const ids = rec.members.filter((m): m is number => isFiniteNumber(m));
    if (ids.length >= 2) {
      out.push({ cellId: rec.cell_id, members: ids });
    }
  }
  return out;
}

/// Chave estável (ordem-insensível) de um conjunto de membros — guard de idempotência do agrupamento
/// por colisão (ADR 0041): uma vez agrupado um conjunto, não re-agrupa enquanto ele persistir no sinal.
/// Opera sobre ids ESTÁVEIS (string) no KDE.
export function collisionKey(members: string[]): string {
  return [...members].sort().join(',');
}

/// Decide se a maximização (ou fullscreen) de uma janela deve ser SUPRIMIDA por ser "nascida
/// maximizada" no spawn (ADR 0043). Regra:
///   - `!enabled` ou `!isMaximized` → nunca suprime (nada a fazer / Tiling desligado);
///   - dentro da janela de graça pós-nascimento → suprime SEMPRE, mesmo já tilada (`everTiled`): apps
///     de restore lento auto-maximizam DEPOIS do `windowAdded`, e essa auto-maximização de spawn não
///     pode ser confundida com ato manual;
///   - após a graça → só suprime se a janela NUNCA foi tilada; do contrário é maximização MANUAL do
///     usuário e deve ser preservada (congela o grid). Pura e determinística. Espelha o GNOME.
export function shouldSuppressSpawnMaximize(p: {
  enabled: boolean;
  isMaximized: boolean;
  everTiled: boolean;
  withinSpawnGrace: boolean;
}): boolean {
  if (!p.enabled || !p.isMaximized) {
    return false;
  }
  return p.withinSpawnGrace || !p.everTiled;
}

function isLayoutCommand(value: unknown): value is LayoutCommand {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isFiniteNumber(v.id) &&
    isFiniteNumber(v.x) &&
    isFiniteNumber(v.y) &&
    isFiniteNumber(v.width) &&
    isFiniteNumber(v.height)
  );
}

/// Parse defensivo do `preview_json` do daemon. Retorna `null` se inválido (nunca lança) — uma
/// resposta malformada durante o arrasto nunca deve derrubar a ponte; o chamador só esconde o outline.
export function parsePreview(json: string): DropPreview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const v = parsed as Record<string, unknown>;
  if (
    typeof v.zone !== 'string' ||
    !isFiniteNumber(v.x) ||
    !isFiniteNumber(v.y) ||
    !isFiniteNumber(v.width) ||
    !isFiniteNumber(v.height)
  ) {
    return null;
  }
  return { zone: v.zone, x: v.x, y: v.y, width: v.width, height: v.height };
}

// ---- HUD de preview dos "eixos limpos" (cálculo LOCAL na ponte — ADR 0028) ----
//
// Tiling PURO, sem abas. Durante o arrasto, calcula a zona sob o cursor SEM chamar o Rust:
//  - Sobre uma janela, miolo central → `center` local (no drop vira SWAP: troca as duas janelas).
//  - Sobre uma janela, fora do centro → split 50/50 do CORPO do alvo pelo lado mais próximo
//    (escopo `local`): a zona local divide o slot do alvo, não o monitor.
//  - Gap vazio → bloco de 50% pela borda mais próxima, ou monitor inteiro no miolo (escopo `global`).
// O preview é desenhado pelo `workspace.showOutline` NATIVO do KWin (o daemon é geometria pura e não
// renderiza nada). O core só é acionado no DROP (MoveWindow). Puro/testável.

/// Retângulo simples em px absolutos de tela.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Resultado do cálculo de drop: a zona quente sob o cursor, seu escopo e o retângulo-destino
/// (`outline`) para o preview nativo.
export interface HotZone {
  scope: 'local' | 'global';
  dropZone: string;
  outline: Rect;
}

/// Calcula a zona quente do HUD sob o cursor, sem D-Bus. `target` = retângulo da janela sob o cursor
/// (`null` num gap vazio); `monitor` = área útil do monitor sob o cursor; `draggedMin` = tamanho mínimo
/// da janela em arrasto (estica a metade local do preview se necessário — ADR 0028; `(0,0)` = 50/50 puro).
///  - Miolo CENTRAL de uma janela → `center` local (no drop o core faz SWAP das duas janelas).
///  - Qualquer outra parte SOBRE uma janela → split 50/50 do CORPO do alvo pelo lado mais próximo (local).
///  - Gap vazio → 50% pela borda mais próxima, ou monitor inteiro no miolo central (escopo `global`).
export function resolveHotZone(
  pointer: { x: number; y: number },
  target: Rect | null,
  monitor: Rect,
  draggedMin: { width: number; height: number },
): HotZone {
  if (target && target.width > 0 && target.height > 0) {
    const tfx = (pointer.x - target.x) / target.width;
    const tfy = (pointer.y - target.y) / target.height;
    if (tfx > 1 / 3 && tfx < 2 / 3 && tfy > 1 / 3 && tfy < 2 / 3) {
      // Literal explícito (NÃO object spread): o QJSEngine do KWin rejeita `{ ...x }`. Ver ADR 0013.
      const whole = { x: target.x, y: target.y, width: target.width, height: target.height };
      return { scope: 'local', dropZone: 'center', outline: whole };
    }
    return localHotZone(pointer, target, draggedMin);
  }
  const mfx = monitor.width > 0 ? (pointer.x - monitor.x) / monitor.width : 0.5;
  const mfy = monitor.height > 0 ? (pointer.y - monitor.y) / monitor.height : 0.5;
  return globalHotZone(mfx, mfy, monitor);
}

/// Escopo LOCAL fora do centro: split 50/50 do CORPO do `target` pelo lado mais próximo do cursor.
/// Espelha o `globalHotZone`, mas sobre o retângulo do alvo (a zona local divide o slot do alvo). A
/// metade ENCOSTADA ao cursor é o destino; ela ESTICA no eixo do split se o min-size da janela arrastada
/// exigir: `extent = clamp(max(metade, min), 5%, 95%)` da dimensão do alvo naquele eixo (ADR 0028).
function localHotZone(
  pointer: { x: number; y: number },
  target: Rect,
  draggedMin: { width: number; height: number },
): HotZone {
  const fx = (pointer.x - target.x) / target.width;
  const fy = (pointer.y - target.y) / target.height;
  const dl = fx;
  const dr = 1 - fx;
  const dt = fy;
  const db = 1 - fy;
  const nearest = Math.min(dl, dr, dt, db);
  // Esticão do preview: largura/altura da metade respeitando o min da arrastada, em px, no eixo do split.
  const extentX = clampExtent(Math.max(target.width / 2, draggedMin.width), target.width);
  const extentY = clampExtent(Math.max(target.height / 2, draggedMin.height), target.height);
  let dropZone: string;
  let block: Rect;
  if (nearest === dl) {
    dropZone = 'left';
    block = { x: target.x, y: target.y, width: extentX, height: target.height };
  } else if (nearest === dr) {
    dropZone = 'right';
    block = {
      x: target.x + target.width - extentX,
      y: target.y,
      width: extentX,
      height: target.height,
    };
  } else if (nearest === dt) {
    dropZone = 'top';
    block = { x: target.x, y: target.y, width: target.width, height: extentY };
  } else {
    dropZone = 'bottom';
    block = {
      x: target.x,
      y: target.y + target.height - extentY,
      width: target.width,
      height: extentY,
    };
  }
  return { scope: 'local', dropZone, outline: block };
}

/// `clamp(value, 5%*disp, 95%*disp)`: limita a metade esticada por min-size aos extremos do alvo no eixo.
function clampExtent(value: number, disp: number): number {
  const lo = 0.05 * disp;
  const hi = 0.95 * disp;
  return Math.min(hi, Math.max(lo, value));
}

function globalHotZone(mfx: number, mfy: number, monitor: Rect): HotZone {
  // Miolo central da tela vazia → maximizar (bloco = monitor inteiro). Antes de escolher a borda.
  if (mfx > 1 / 3 && mfx < 2 / 3 && mfy > 1 / 3 && mfy < 2 / 3) {
    const whole = { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height };
    return { scope: 'global', dropZone: 'center', outline: whole };
  }
  const dl = mfx;
  const dr = 1 - mfx;
  const dt = mfy;
  const db = 1 - mfy;
  const nearest = Math.min(dl, dr, dt, db);
  const hw = monitor.width / 2;
  const hh = monitor.height / 2;
  let dropZone: string;
  let block: Rect;
  if (nearest === dl) {
    dropZone = 'left';
    block = { x: monitor.x, y: monitor.y, width: hw, height: monitor.height };
  } else if (nearest === dr) {
    dropZone = 'right';
    block = { x: monitor.x + hw, y: monitor.y, width: hw, height: monitor.height };
  } else if (nearest === dt) {
    dropZone = 'top';
    block = { x: monitor.x, y: monitor.y, width: monitor.width, height: hh };
  } else {
    dropZone = 'bottom';
    block = { x: monitor.x, y: monitor.y + hh, width: monitor.width, height: hh };
  }
  return { scope: 'global', dropZone, outline: block };
}

/// Serializa o escopo do drop para o `MoveWindow` (ADR 0028): `"global"` (50%/maximizar) ou `"local"`
/// (split do slot do alvo / swap no centro).
export function serializeScope(scope: 'local' | 'global'): string {
  if (scope === 'global') {
    return 'global';
  }
  return 'local';
}

// ---- Ordem estável das janelas (estado leve da ponte) ----
//
// Espelha os helpers do GNOME (bridge.ts da extensão); aqui o id estável é o `internalId` do KWin
// (QUuid → string), então os ids são STRINGS. O core é um BSP determinístico função da ORDEM de
// entrada; manter uma ordem estável por `(monitor, workspace)` evita reshuffle no foco e torna o
// rearranjo do drop persistente sem que o daemon guarde estado. Helpers puros (testáveis sem KWin).

/// Chave do grupo de ordenação.
export function orderKey(monitor: number, workspace: number): string {
  return `${monitor}:${workspace}`;
}

/// Acrescenta `id` ao fim do grupo `key` se ainda não estiver presente (mutação in-place do mapa).
export function appendToOrder(order: Map<string, string[]>, key: string, id: string): void {
  const list = order.get(key);
  if (!list) {
    order.set(key, [id]);
  } else if (!list.includes(id)) {
    list.push(id);
  }
}

/// Remove `id` de TODOS os grupos (a janela pode ter mudado de monitor/workspace antes de fechar).
export function removeFromOrder(order: Map<string, string[]>, id: string): void {
  for (const [key, list] of order) {
    const idx = list.indexOf(id);
    if (idx !== -1) {
      list.splice(idx, 1);
      if (list.length === 0) {
        order.delete(key);
      }
    }
  }
}

/// Ordena os `ids` presentes conforme a ordem registrada no grupo `key`. Ids ainda não vistos vão
/// para o fim, preservando a ordem de chegada (estável e determinístico).
export function sortByOrder(order: Map<string, string[]>, key: string, ids: string[]): string[] {
  const ranks = order.get(key) ?? [];
  const rankOf = (id: string): number => {
    const r = ranks.indexOf(id);
    return r === -1 ? Number.MAX_SAFE_INTEGER : r;
  };
  return ids
    .map((id, index) => ({ id, index }))
    .sort((a, b) => rankOf(a.id) - rankOf(b.id) || a.index - b.index)
    .map((e) => e.id);
}

// ---- Árvores BSP persistentes e tiling por grupo (estado leve da ponte) ----
//
// Tiling PURO (ADR 0028): SEM abas/stacks. O `state_json` do contrato usa ids de TRANSPORTE (números)
// — então `serializeState` recebe um `transportOf` (internalId → id opaco) para traduzir as folhas das
// árvores na hora de enviar. Helpers PUROS (testáveis sem KWin).

/// Célula de um `grid` com ids INTERNOS (espelha `etherbit_tiling_core::GridChild`).
export interface TreeGridCell {
  node: TreeNode;
  col: number;
  row: number;
  col_span: number;
  row_span: number;
}

/// Célula de um `grid` com ids de TRANSPORTE.
export interface TransportGridCell {
  node: TransportNode;
  col: number;
  row: number;
  col_span: number;
  row_span: number;
}

/// Árvore persistente com ids INTERNOS (internalId string) — a forma canônica guardada na ponte.
/// ADR 0033 (paridade com GNOME): a árvore pode conter `stack` (abas do Merge Fallback), preservado na
/// tradução (membros sem transporte são podados; stack que esvazia colapsa na folha sobrevivente).
export type TreeNode =
  | { win: string }
  | { stack: { members: string[]; active: string } }
  | { grid: { cols: number[]; rows: number[]; cells: TreeGridCell[] } };

/// Árvore com ids de TRANSPORTE (números), como trafega no contrato D-Bus (igual ao GNOME).
export type TransportNode =
  | { win: number }
  | { stack: { members: number[]; active: number } }
  | { grid: { cols: number[]; rows: number[]; cells: TransportGridCell[] } };

/// internalId-tree → transport-tree. Folha/célula sem transporte (janela fechada) é COLAPSADA (o
/// sobrevivente sobe), espelhando o `collapse_leaf` do core — nunca envia id intraduzível.
export function treeToTransport(
  node: TreeNode,
  transportOf: Map<string, number>,
): TransportNode | null {
  if ('win' in node) {
    const t = transportOf.get(node.win);
    return t === undefined ? null : { win: t };
  }
  if ('stack' in node) {
    // PRESERVA o stack (ADR 0033): traduz os membros, podando os sem transporte. 0 → colapsa (null);
    // 1 → achata na folha do sobrevivente; ≥2 → mantém o stack, com `active` válido (1º membro se o
    // ativo caiu).
    const members: number[] = [];
    for (const m of node.stack.members) {
      const t = transportOf.get(m);
      if (t !== undefined) {
        members.push(t);
      }
    }
    if (members.length === 0) {
      return null;
    }
    if (members.length === 1) {
      return { win: members[0] as number };
    }
    const at = transportOf.get(node.stack.active);
    const active = at !== undefined && members.includes(at) ? at : (members[0] as number);
    return { stack: { members, active } };
  }
  // grid: traduz cada célula; as intraduzíveis caem. 0 → null; 1 → achata no sobrevivente.
  const cells: TransportGridCell[] = [];
  for (const c of node.grid.cells) {
    const n = treeToTransport(c.node, transportOf);
    if (n) {
      cells.push({ node: n, col: c.col, row: c.row, col_span: c.col_span, row_span: c.row_span });
    }
  }
  if (cells.length === 0) {
    return null;
  }
  if (cells.length === 1) {
    return (cells[0] as TransportGridCell).node;
  }
  return { grid: { cols: node.grid.cols, rows: node.grid.rows, cells } };
}

/// transport-tree → internalId-tree. Folha/célula sem internalId conhecido é COLAPSADA (sobe).
export function treeFromTransport(
  node: TransportNode,
  toStable: Map<number, string>,
): TreeNode | null {
  if ('win' in node) {
    const s = toStable.get(node.win);
    return s === undefined ? null : { win: s };
  }
  if ('stack' in node) {
    // PRESERVA o stack (ADR 0033): traduz os membros de volta para internalId, podando os desconhecidos.
    const members: string[] = [];
    for (const m of node.stack.members) {
      const s = toStable.get(m);
      if (s !== undefined) {
        members.push(s);
      }
    }
    if (members.length === 0) {
      return null;
    }
    if (members.length === 1) {
      return { win: members[0] as string };
    }
    const as = toStable.get(node.stack.active);
    const active = as !== undefined && members.includes(as) ? as : (members[0] as string);
    return { stack: { members, active } };
  }
  const cells: TreeGridCell[] = [];
  for (const c of node.grid.cells) {
    const n = treeFromTransport(c.node, toStable);
    if (n) {
      cells.push({ node: n, col: c.col, row: c.row, col_span: c.col_span, row_span: c.row_span });
    }
  }
  if (cells.length === 0) {
    return null;
  }
  if (cells.length === 1) {
    return (cells[0] as TreeGridCell).node;
  }
  return { grid: { cols: node.grid.cols, rows: node.grid.rows, cells } };
}

/// Reverte `orderKey`: `"monitor:workspace"` → `[monitor, workspace]`.
export function parseOrderKey(key: string): [number, number] {
  const [m, w] = key.split(':');
  return [Number(m) || 0, Number(w) || 0];
}

/// Um stack: membros na ordem das abas + a aba ativa (visível). Estado leve da ponte (internalId string).
export interface Stack {
  members: string[];
  active: string;
}

/// Espelha o `TabBarDto` do daemon: a faixa da barra de abas de um stack + o conteúdo da aba ativa. No
/// KDE (ADR 0033, mínimo viável) a barra clicável ainda NÃO é desenhada — a ponte usa `members`/`active`
/// só para OCULTAR (minimizar) as abas inativas e manter a ativa no slot `content`.
export interface TabBar {
  stack_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  content: { x: number; y: number; width: number; height: number };
  members: number[];
  active: number;
}

/// Serializa o estado leve para o `state_json`, traduzindo as folhas das árvores e os membros dos stacks
/// (internalId) para ids de TRANSPORTE via `transportOf`. ADR 0033 (paridade com GNOME): os stacks reais
/// (≥ 2 membros traduzíveis) viajam para o core materializar `Node::Stack` e devolver as `tab_bars`.
export function serializeState(
  stacks: Map<string, Stack[]>,
  disabled: Set<string>,
  transportOf: Map<string, number>,
  trees: Map<string, TreeNode | null>,
  focusedStable: string,
): string {
  const stackDtos: Array<{
    monitor: number;
    workspace: number;
    members: number[];
    active: number;
  }> = [];
  for (const [key, list] of stacks) {
    const [monitor, workspace] = parseOrderKey(key);
    for (const s of list) {
      const members: number[] = [];
      for (const m of s.members) {
        const t = transportOf.get(m);
        if (t !== undefined) {
          members.push(t);
        }
      }
      if (members.length >= 2) {
        const at = transportOf.get(s.active);
        const active = at !== undefined && members.includes(at) ? at : (members[0] as number);
        stackDtos.push({ monitor, workspace, members, active });
      }
    }
  }
  const disabledDtos: Array<[number, number]> = [];
  for (const key of disabled) {
    disabledDtos.push(parseOrderKey(key));
  }
  // Árvores por grupo, traduzidas para ids de transporte (o core reconcilia e devolve a versão nova).
  const treeDtos: Array<{ monitor: number; workspace: number; root: TransportNode | null }> = [];
  for (const [key, root] of trees) {
    const [monitor, workspace] = parseOrderKey(key);
    treeDtos.push({ monitor, workspace, root: root ? treeToTransport(root, transportOf) : null });
  }
  const focused_id = transportOf.get(focusedStable) ?? 0;
  return JSON.stringify({
    stacks: stackDtos,
    disabled_groups: disabledDtos,
    trees: treeDtos,
    focused_id,
  });
}

/// Parse defensivo das barras de abas do `layout_json` (objeto `{ rects, tab_bars }`). Formato legado
/// (array) → sem barras. Descarta entradas malformadas. Espelha o `parseTabBars` da ponte GNOME.
export function parseTabBars(json: string): TabBar[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const raw = (parsed as Record<string, unknown>).tab_bars;
  if (!Array.isArray(raw)) {
    return [];
  }
  const bars: TabBar[] = [];
  for (const entry of raw) {
    const bar = toTabBar(entry);
    if (bar) {
      bars.push(bar);
    }
  }
  return bars;
}

function toTabBar(value: unknown): TabBar | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const c = v.content as Record<string, unknown> | undefined;
  if (
    !isFiniteNumber(v.stack_id) ||
    !isFiniteNumber(v.x) ||
    !isFiniteNumber(v.y) ||
    !isFiniteNumber(v.width) ||
    !isFiniteNumber(v.height) ||
    !isFiniteNumber(v.active) ||
    !Array.isArray(v.members) ||
    !v.members.every(isFiniteNumber) ||
    typeof c !== 'object' ||
    c === null ||
    !isFiniteNumber(c.x) ||
    !isFiniteNumber(c.y) ||
    !isFiniteNumber(c.width) ||
    !isFiniteNumber(c.height)
  ) {
    return null;
  }
  return {
    stack_id: v.stack_id,
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    content: { x: c.x, y: c.y, width: c.width, height: c.height },
    members: v.members as number[],
    active: v.active,
  };
}

// ---- Barras de abas VISUAIS no helper de overlay (ADR 0039) ----
//
// O KWin Script não pinta nem captura ponteiro; o helper `etherbit-tiling-preview` desenha as barras e
// resolve os cliques. Aqui traduzimos as `TabBar` do daemon (ids de TRANSPORTE) para `TabBarView` (ids
// ESTÁVEIS + título), enviadas por `ShowTabs`, e fazemos o parse das ações devolvidas por
// `DrainTabActions`. Helpers PUROS (testáveis sem KWin).

/// View de uma barra de abas para o helper: geometria + abas com TÍTULO e flag de ativa. Os ids são
/// ESTÁVEIS (internalId) — o helper só os ecoa de volta nas ações.
export interface TabBarView {
  stack_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tabs: Array<{ member_id: string; title: string; active: boolean }>;
}

/// Uma ação de aba devolvida pelo helper: clique resolvido em ativar/fechar/desagrupar. `ungroup_drag`
/// (ADR 0042) ejeta a janela E a reposiciona no ponto de soltura `(x, y)` em coordenadas GLOBAIS de tela.
export interface TabAction {
  stack_id: string;
  member_id: string;
  kind: 'activate' | 'close' | 'ungroup' | 'ungroup_drag';
  /// Só em `ungroup_drag`: coordenadas globais de soltura ("cai onde foi solta"). `0` nas demais.
  x: number;
  y: number;
}

/// Traduz as `TabBar` do daemon (ids de TRANSPORTE) para `TabBarView` (ids ESTÁVEIS + título), prontas
/// para o `ShowTabs`. `titleOf(stableId)` resolve o título (no KWin, `win.caption`) — INJETADO para
/// manter esta função pura (sem globais do KWin). Membros que não traduzem são pulados; barra sem
/// nenhuma aba traduzível é descartada.
export function buildTabBarViews(
  tabBars: TabBar[],
  toStable: Map<number, string>,
  titleOf: (stableId: string) => string,
): TabBarView[] {
  const views: TabBarView[] = [];
  for (const bar of tabBars) {
    const tabs: TabBarView['tabs'] = [];
    for (const member of bar.members) {
      const sid = toStable.get(member);
      if (sid === undefined) {
        continue;
      }
      tabs.push({ member_id: sid, title: titleOf(sid), active: member === bar.active });
    }
    const firstMember = tabs[0];
    if (firstMember === undefined) {
      continue;
    }
    const stackStable = toStable.get(bar.stack_id) ?? firstMember.member_id;
    views.push({ stack_id: stackStable, x: bar.x, y: bar.y, w: bar.width, h: bar.height, tabs });
  }
  return views;
}

/// Serializa as views para o argumento JSON do `ShowTabs`.
export function serializeTabBars(views: TabBarView[]): string {
  return JSON.stringify(views);
}

/// Parse defensivo do JSON de `DrainTabActions` (`[{stack_id,member_id,kind}]`). Descarta entradas
/// malformadas ou de `kind` desconhecido. Ids são ESTÁVEIS (internalId), como enviados em `ShowTabs`.
export function parseTabActions(json: string): TabAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: TabAction[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const kind = e.kind;
    if (
      typeof e.member_id !== 'string' ||
      (kind !== 'activate' && kind !== 'close' && kind !== 'ungroup' && kind !== 'ungroup_drag')
    ) {
      continue;
    }
    out.push({
      stack_id: typeof e.stack_id === 'string' ? e.stack_id : '',
      member_id: e.member_id,
      kind,
      x: typeof e.x === 'number' ? e.x : 0,
      y: typeof e.y === 'number' ? e.y : 0,
    });
  }
  return out;
}

/// Lê as árvores devolvidas pelo daemon (transporte) e as traduz para internalId para a ponte
/// PERSISTIR por grupo. Defensivo: entradas malformadas são puladas; folhas intraduzíveis colapsam.
export function parseLayoutTrees(
  json: string,
  toStable: Map<number, string>,
): Map<string, TreeNode | null> {
  const out = new Map<string, TreeNode | null>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return out;
  }
  const raw = (parsed as Record<string, unknown>).trees;
  if (!Array.isArray(raw)) {
    return out;
  }
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (!isFiniteNumber(e.monitor) || !isFiniteNumber(e.workspace)) {
      continue;
    }
    const root = e.root == null ? null : treeFromTransport(e.root as TransportNode, toStable);
    out.set(orderKey(e.monitor, e.workspace), root);
  }
  return out;
}

/// Uma borda redimensionada + quanto a janela CRESCEU nela (px; negativo = encolheu).
export interface ResizeDelta {
  edge: 'left' | 'right' | 'top' | 'bottom';
  deltaPx: number;
}

/// Infere quais bordas se moveram comparando o frame ANTES e DEPOIS do resize, e quanto a janela
/// cresceu em cada uma (positivo). Agnóstico do compositor; resize de canto devolve duas entradas.
export function resizeDeltaFrom(
  before: { x: number; y: number; width: number; height: number },
  after: { x: number; y: number; width: number; height: number },
): ResizeDelta[] {
  const out: ResizeDelta[] = [];
  const leftGrow = before.x - after.x;
  const rightGrow = after.x + after.width - (before.x + before.width);
  const topGrow = before.y - after.y;
  const bottomGrow = after.y + after.height - (before.y + before.height);
  if (leftGrow !== 0) {
    out.push({ edge: 'left', deltaPx: leftGrow });
  }
  if (rightGrow !== 0) {
    out.push({ edge: 'right', deltaPx: rightGrow });
  }
  if (topGrow !== 0) {
    out.push({ edge: 'top', deltaPx: topGrow });
  }
  if (bottomGrow !== 0) {
    out.push({ edge: 'bottom', deltaPx: bottomGrow });
  }
  return out;
}

/// Serializa o retângulo da janela sob o cursor para o `target_json` do `ResolveDropZone` (`""` se
/// não há janela-alvo).
export function serializeTarget(
  rect: { x: number; y: number; width: number; height: number } | null,
): string {
  return rect ? JSON.stringify(rect) : '';
}

/// Liga/desliga o tiling do grupo `key` (atalho Super+Y).
export function toggleGroupDisabled(disabled: Set<string>, key: string): boolean {
  if (disabled.has(key)) {
    disabled.delete(key);
  } else {
    disabled.add(key);
  }
  return true;
}

// ---- Abas / stacks manuais (ADR 0040, paridade com GNOME) ----
//
// O agrupamento em abas é só MANUAL (drag-to-group na zona `center`; Meta+S). O esmagamento impositivo
// do core (ADR 0040) garante que toda janela rígida receba ≥ seu mínimo no grid, então não há mais
// agrupamento automático sob overflow. Cada aba recebe o slot inteiro; as inativas são ocultadas
// (minimizadas). Helpers PUROS (testáveis sem KWin), com ids `string`.

/// Remove `id` de qualquer stack (de qualquer grupo), dissolvendo stacks que ficarem com < 2 membros e
/// limpando grupos vazios. Usado ao fechar uma janela. Retorna `true` se algo mudou.
export function removeIdFromStacks(stacks: Map<string, Stack[]>, id: string): boolean {
  let changed = false;
  for (const [key, list] of stacks) {
    for (const s of list) {
      const idx = s.members.indexOf(id);
      if (idx !== -1) {
        s.members.splice(idx, 1);
        if (s.active === id) {
          s.active = s.members[0] ?? '';
        }
        changed = true;
      }
    }
    const kept = list.filter((s) => s.members.length >= 2);
    if (kept.length !== list.length) {
      changed = true;
    }
    if (kept.length === 0) {
      stacks.delete(key);
    } else {
      stacks.set(key, kept);
    }
  }
  return changed;
}

/// Empilha o `draggedId` na janela-alvo do grupo `key`. Se o alvo já está num stack, adiciona-o a ele;
/// senão cria `[targetId, draggedId]`. O recém-agrupado vira a aba ativa. Remove-o de stacks anteriores.
export function addToStack(
  stacks: Map<string, Stack[]>,
  key: string,
  targetId: string,
  draggedId: string,
): boolean {
  if (targetId === draggedId) {
    return false;
  }
  removeIdFromStacks(stacks, draggedId);
  let list = stacks.get(key);
  if (!list) {
    list = [];
    stacks.set(key, list);
  }
  const target = list.find((s) => s.members.includes(targetId));
  if (target) {
    if (!target.members.includes(draggedId)) {
      target.members.push(draggedId);
    }
    target.active = draggedId;
  } else {
    list.push({ members: [targetId, draggedId], active: draggedId });
  }
  return true;
}

/// Agrupa/desagrupa em UMA aba todas as janelas (`ids`, já na ordem) do grupo `key` — atalho Meta+S,
/// paridade com o GNOME. Se o grupo já tem stack, DESFAZ (remove a chave); senão cria um único stack com
/// todos os `ids`, ativando `activeId` (ou o primeiro). Exige ≥2 janelas para agrupar. `true` se mudou.
export function toggleStackGroup(
  stacks: Map<string, Stack[]>,
  key: string,
  ids: string[],
  activeId: string,
): boolean {
  const existing = stacks.get(key);
  if (existing && existing.length > 0) {
    stacks.delete(key);
    return true;
  }
  if (ids.length < 2) {
    return false;
  }
  const active = ids.includes(activeId) ? activeId : (ids[0] as string);
  stacks.set(key, [{ members: [...ids], active }]);
  return true;
}

/// Define a aba ativa do stack que contém `member`. Retorna `true` se mudou.
export function setActiveMember(stacks: Map<string, Stack[]>, member: string): boolean {
  for (const list of stacks.values()) {
    for (const s of list) {
      if (s.members.includes(member)) {
        if (s.active !== member) {
          s.active = member;
          return true;
        }
        return false;
      }
    }
  }
  return false;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
