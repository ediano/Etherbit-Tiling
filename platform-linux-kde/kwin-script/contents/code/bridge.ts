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
  /// Título (caption) da janela, para o texto da aba na barra wgpu do KDE. Vazio = sem rótulo.
  title: string;
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

/// Espelha o `TabBarDto` do daemon: a faixa da barra de abas de um stack + o conteúdo da aba ativa.
/// `members`/`active`/`stack_id` são ids de TRANSPORTE (números opacos), que o KWin traduz de volta
/// ao `internalId` via o `byId` do retile.
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

/// Ações de aba que a barra wgpu do KDE pode disparar (espelha as do `TabHit` no daemon).
export type TabActionKind = 'activate' | 'close' | 'ungroup';

/// Espelha o `TabActionDto` do daemon: um clique do usuário na barra de abas RENDERIZADA pelo daemon
/// (wgpu/layer-shell), entregue à ponte por PULL no `layout_json` do próximo `SyncWindows` — o KWin
/// Script é pull-only e não consome o sinal `TabAction` (ver ADR 0022). `member_id`/`stack_id` são
/// ids de TRANSPORTE; a ponte os traduz de volta ao `internalId` e aplica.
export interface PendingAction {
  stack_id: number;
  member_id: number;
  action: TabActionKind;
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
  const rects = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown> | null)?.rects;
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

/// Parse defensivo das janelas FLUTUANTES (auto-floating) do `layout_json`. Lê `floating` — janelas
/// que o core isolou do grid por não caberem com seu mínimo. Ausente (daemon antigo) ou array legado
/// → vazio. A ponte aplica estes retângulos E eleva as janelas (keepAbove) acima das tiladas.
export function parseFloating(json: string): LayoutCommand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const raw = (parsed as Record<string, unknown>).floating;
  if (!Array.isArray(raw)) {
    return [];
  }
  const commands: LayoutCommand[] = [];
  for (const entry of raw) {
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

/// Parse defensivo das barras de abas do `layout_json` (objeto `{ rects, tab_bars }`). Formato
/// legado (array) → sem barras. Descarta entradas malformadas em vez de lançar.
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

/// Parse defensivo das ações de aba pendentes do `layout_json` (objeto `{ ..., pending_actions }`).
/// Ausente (daemon antigo) ou formato legado (array) → vazio. Descarta entradas malformadas ou de
/// ação desconhecida em vez de lançar. Ver ADR 0022/0025.
export function parsePendingActions(json: string): PendingAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const raw = (parsed as Record<string, unknown>).pending_actions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const actions: PendingAction[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const v = entry as Record<string, unknown>;
    if (
      isFiniteNumber(v.stack_id) &&
      isFiniteNumber(v.member_id) &&
      (v.action === 'activate' || v.action === 'close' || v.action === 'ungroup')
    ) {
      actions.push({ stack_id: v.stack_id, member_id: v.member_id, action: v.action });
    }
  }
  return actions;
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

// ---- HUD de preview do jogo da velha (cálculo LOCAL na ponte — ADR 0026) ----
//
// Espelha o `resolveHotZone` da ponte GNOME: durante o arrasto, calcula a zona sob o cursor SEM chamar
// o Rust (sobre uma janela = célula da matriz 3×3 do monitor ou centro=merge; gap vazio = bloco de
// 50%). O HUD translúcido das 9 células é desenhado pelo OVERLAY wgpu do daemon (ShowDropHud), com o
// `workspace.showOutline` nativo como fallback. O core só é acionado no DROP (MoveWindow). Puro/testável.

/// Retângulo simples em px absolutos de tela.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Resultado do HUD: a zona quente sob o cursor, as células e o destino do drop.
export interface HotZone {
  scope: 'local' | 'global' | 'grid';
  dropZone: string;
  cells: Rect[];
  hot: number[];
  outline: Rect;
}

/// Zonas das 9 células da matriz 3×3 do monitor (índice = row*3 + col). Espelha `zone_to_cell` do core.
const GRID_ZONES: string[] = [
  'top_left',
  'top',
  'top_right',
  'left',
  'center',
  'right',
  'bottom_left',
  'bottom',
  'bottom_right',
];

/// Calcula a zona quente do HUD sob o cursor, sem D-Bus. `target` = retângulo da janela sob o cursor
/// (`null` num gap vazio); `monitor` = área útil do monitor sob o cursor.
///  - Terço CENTRAL de uma janela → `center` local (fusão em abas).
///  - Qualquer outra parte SOBRE uma janela → CÉLULA da matriz 3×3 do monitor (escopo `grid`): o app se
///    fixa na célula 1/9 sem esticar para 50% (densidade não dispara mais 50% acidental).
///  - Gap vazio → bloco de 50% pela borda mais próxima (escopo `global`).
export function resolveHotZone(
  pointer: { x: number; y: number },
  target: Rect | null,
  monitor: Rect,
): HotZone {
  if (target && target.width > 0 && target.height > 0) {
    const tfx = (pointer.x - target.x) / target.width;
    const tfy = (pointer.y - target.y) / target.height;
    if (tfx > 1 / 3 && tfx < 2 / 3 && tfy > 1 / 3 && tfy < 2 / 3) {
      // Literal explícito (NÃO object spread): o QJSEngine do KWin rejeita `{ ...x }`. Ver ADR 0013.
      const whole = { x: target.x, y: target.y, width: target.width, height: target.height };
      return { scope: 'local', dropZone: 'center', cells: [whole], hot: [0], outline: whole };
    }
    return gridHotZone(pointer, monitor);
  }
  const mfx = monitor.width > 0 ? (pointer.x - monitor.x) / monitor.width : 0.5;
  const mfy = monitor.height > 0 ? (pointer.y - monitor.y) / monitor.height : 0.5;
  return globalHotZone(mfx, mfy, monitor);
}

function globalHotZone(mfx: number, mfy: number, monitor: Rect): HotZone {
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
  return { scope: 'global', dropZone, cells: [block], hot: [0], outline: block };
}

/// Escopo GRID: a célula 1/9 da matriz 3×3 do monitor sob o cursor. Desenha as 9 células e acende a do
/// cursor; o drop fixa o app naquela célula (span 1×1, sem auto-expansão).
function gridHotZone(pointer: { x: number; y: number }, monitor: Rect): HotZone {
  const cw = monitor.width / 3;
  const ch = monitor.height / 3;
  const cells: Rect[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      cells.push({ x: monitor.x + col * cw, y: monitor.y + row * ch, width: cw, height: ch });
    }
  }
  const col = Math.min(2, Math.max(0, Math.floor((pointer.x - monitor.x) / cw)));
  const row = Math.min(2, Math.max(0, Math.floor((pointer.y - monitor.y) / ch)));
  const i = row * 3 + col;
  return {
    scope: 'grid',
    dropZone: GRID_ZONES[i] as string,
    cells,
    hot: [i],
    outline: cells[i] as Rect,
  };
}

/// Serializa o escopo do drop para o `MoveWindow` (ADR 0026): `"global"` (50%), `"grid"` (célula 3×3)
/// ou `"local"` (fusão/centro).
export function serializeScope(scope: 'local' | 'global' | 'grid'): string {
  if (scope === 'global') {
    return 'global';
  }
  if (scope === 'grid') {
    return 'grid';
  }
  return 'local';
}

/// Serializa as células do HUD do jogo da velha para o `ShowDropHud` do daemon (overlay wgpu). Marca
/// `hot` na célula realçada (`hotIdx`). Literal EXPLÍCITO por célula (NÃO object spread — o QJSEngine
/// do KWin rejeita `{ ...x }`; ver ADR 0013). Sem IDs (só geometria), então sem risco de `uint64`.
export function serializeHudCells(cells: Rect[], hotIdx: number): string {
  const out: { x: number; y: number; width: number; height: number; hot: boolean }[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i] as Rect;
    out.push({ x: c.x, y: c.y, width: c.width, height: c.height, hot: i === hotIdx });
  }
  return JSON.stringify(out);
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

// ---- Estado de abas (stacks) e de tiling por grupo (estado leve da ponte) ----
//
// Espelha os helpers do GNOME, mas com ids STRING (`internalId`). O `state_json` do contrato usa ids
// de TRANSPORTE (números) — então `serializeState` recebe um `transportOf` (internalId → id opaco)
// para traduzir os membros na hora de enviar. Helpers PUROS (testáveis sem KWin).

/// Um stack: membros (internalId) na ordem das abas + a aba ativa (visível).
export interface Stack {
  members: string[];
  active: string;
}

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
/// ADR 0026: o `grid` elástico 3×3 substitui o `split` binário.
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
    // Traduz cada membro; membros sem transporte (janela fechada) caem. < 2 → degrada (folha/colapso).
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
    const activeT = transportOf.get(node.stack.active);
    const active =
      activeT !== undefined && members.includes(activeT) ? activeT : (members[0] as number);
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
    const activeS = toStable.get(node.stack.active);
    const active =
      activeS !== undefined && members.includes(activeS) ? activeS : (members[0] as string);
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

/// Serializa o estado leve para o `state_json`, traduzindo os membros (internalId) para ids de
/// transporte via `transportOf`. Só viajam stacks com ≥ 2 membros presentes (traduzíveis).
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
        const activeT = transportOf.get(s.active);
        const active = activeT !== undefined ? activeT : (members[0] as number);
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

/// Remove `id` (internalId) de qualquer stack, dissolvendo stacks com < 2 membros e limpando grupos
/// vazios. Retorna `true` se algo mudou.
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

/// Toggle de agrupamento do grupo `key` (atalho Super+S). Se já há stack → desfaz; senão empilha
/// TODOS os `ids` (internalId, na ordem estável) num único stack, com `active` visível.
export function toggleStackGroup(
  stacks: Map<string, Stack[]>,
  key: string,
  ids: string[],
  active: string,
): boolean {
  const existing = stacks.get(key);
  if (existing && existing.length > 0) {
    stacks.delete(key);
    return true;
  }
  if (ids.length < 2) {
    return false;
  }
  const activeId = ids.includes(active) ? active : (ids[0] as string);
  stacks.set(key, [{ members: [...ids], active: activeId }]);
  return true;
}

/// Empilha o arrastado na janela-alvo (drag-to-group). Se o alvo já está num stack do grupo, adiciona
/// o arrastado; senão cria `[targetId, draggedId]`. O arrastado vira a aba ativa.
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

/// Liga/desliga o tiling do grupo `key` (atalho Super+Y).
export function toggleGroupDisabled(disabled: Set<string>, key: string): boolean {
  if (disabled.has(key)) {
    disabled.delete(key);
  } else {
    disabled.add(key);
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
