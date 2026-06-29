// bridge.ts — contrato e helpers PUROS da ponte GNOME ↔ daemon (sem dependências de GJS).
//
// A extensão é uma "ponte burra": coleta metadados das janelas e dos monitores, envia ao daemon
// via `SyncWindows` e apenas APLICA os retângulos devolvidos. Toda a decisão de layout vive no
// core (Rust). Aqui ficam só a montagem do JSON de saída e o parse defensivo do layout de volta —
// isolados de `gi://` para serem testáveis em Node/vitest (ver ADR rules/0016).

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

/// Trava de segurança de dimensão: width/height < 1 quebram o framebuffer do Cogl ao aplicar a
/// janela (`cogl_framebuffer_set_viewport: assertion 'width > 0 && height > 0' failed`). Garante ≥ 1px,
/// preservando id/x/y. Aplicada na ponte antes de cada `move_resize_frame`.
export function clampGeometry(cmd: LayoutCommand): LayoutCommand {
  return { ...cmd, width: Math.max(1, cmd.width), height: Math.max(1, cmd.height) };
}

/// Espelha o `PreviewDto` do daemon: a zona resolvida + o retângulo do overlay de preview.
export interface DropPreview {
  zone: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Espelha o `TabBarDto` do daemon: a faixa da barra de abas de um stack + o conteúdo da aba ativa.
/// A ponte desenha a barra em `{x,y,width,height}` (título/ícone vêm da ponte) e posiciona a janela
/// ativa em `content`. `members` é a ordem das abas; `active` é a aba visível.
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

/// Serializa as janelas para o `windows_json` do contrato D-Bus.
export function serializeWindows(windows: WindowSnapshot[]): string {
  return JSON.stringify(windows);
}

/// Serializa os monitores para o `monitors_json` do contrato D-Bus.
export function serializeMonitors(monitors: MonitorSnapshot[]): string {
  return JSON.stringify(monitors);
}

/// Parse defensivo do `layout_json` do daemon — devolve os retângulos a aplicar. Aceita o formato
/// novo (objeto `{ rects, tab_bars }`) e o LEGADO (array de rects, para tolerar um daemon antigo).
/// Descarta entradas malformadas em vez de lançar — uma resposta inválida nunca derruba a ponte.
export function parseLayout(json: string): LayoutCommand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  // Novo formato: objeto com `rects`. Legado: o próprio array.
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
/// → vazio. A ponte aplica estes retângulos E eleva as janelas acima das tiladas.
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
/// resposta malformada durante o arrasto nunca deve derrubar a ponte; o chamador só esconde o overlay.
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
// Durante o arrasto, a ponte NÃO chama o Rust por tick: lê o retângulo da janela-alvo sob o cursor,
// divide por 3 (escopo LOCAL) ou usa as bordas do monitor (escopo GLOBAL) e devolve as 9 zonas quentes
// + o destaque + o retângulo resultante. O core só é acionado no DROP (MoveWindow). Helpers PUROS
// (testáveis sem GJS), espelhados na ponte KDE.

/// Retângulo simples em px absolutos de tela.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Resultado do HUD: a zona quente sob o cursor, as células a desenhar e o destino do drop.
export interface HotZone {
  /// `local` = subdivide a submatriz da janela-alvo; `global` = bloco de 50% do workspace.
  scope: 'local' | 'global';
  /// Comando a enviar no drop: `left|right|top|bottom|top_left|top_right|bottom_left|bottom_right|
  /// center|none`. `center` = fusão em abas (a ponte chama `addToStack`, não o MoveWindow).
  dropZone: string;
  /// Células do jogo da velha a DESENHAR (9 no local; 1 bloco no global). GNOME usa todas; KDE ignora.
  cells: Rect[];
  /// Índices de `cells` a ACENDER (a zona ativa).
  hot: number[];
  /// Retângulo único do destino (KDE: `workspace.showOutline`). `center` = a janela-alvo inteira.
  outline: Rect;
}

/// Faixa (fração do MONITOR) junto às bordas da tela que aciona o escopo GLOBAL.
const SCREEN_EDGE_FRAC = 0.12;

/// Calcula a zona quente do HUD sob o cursor, sem D-Bus. `target` é o retângulo da janela sob o cursor
/// (ou `null` se o cursor está num gap vazio). `monitor` é a área útil do monitor sob o cursor.
export function resolveHotZone(
  pointer: { x: number; y: number },
  target: Rect | null,
  monitor: Rect,
): HotZone {
  const mfx = monitor.width > 0 ? (pointer.x - monitor.x) / monitor.width : 0.5;
  const mfy = monitor.height > 0 ? (pointer.y - monitor.y) / monitor.height : 0.5;
  const nearScreenEdge =
    mfx < SCREEN_EDGE_FRAC ||
    mfx > 1 - SCREEN_EDGE_FRAC ||
    mfy < SCREEN_EDGE_FRAC ||
    mfy > 1 - SCREEN_EDGE_FRAC;

  // Global: perto das bordas da tela OU sem janela sob o cursor (gap vazio).
  if (nearScreenEdge || !target || target.width <= 0 || target.height <= 0) {
    return globalHotZone(mfx, mfy, monitor);
  }
  return localHotZone(pointer, target);
}

/// Escopo GLOBAL: a borda da tela mais próxima vira um bloco de 50% do monitor.
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

/// Escopo LOCAL: 3×3 dentro da janela-alvo. Centro = merge; eixos = linha/coluna inteira; cantos =
/// célula única.
function localHotZone(pointer: { x: number; y: number }, target: Rect): HotZone {
  const cw = target.width / 3;
  const ch = target.height / 3;
  const cells: Rect[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      cells.push({ x: target.x + col * cw, y: target.y + row * ch, width: cw, height: ch });
    }
  }
  const idx = (r: number, c: number): number => r * 3 + c;
  const fx = (pointer.x - target.x) / target.width;
  const fy = (pointer.y - target.y) / target.height;
  const col = Math.min(2, Math.max(0, Math.floor(fx * 3)));
  const row = Math.min(2, Math.max(0, Math.floor(fy * 3)));

  // Centro → fusão em abas (a janela-alvo inteira acende).
  if (col === 1 && row === 1) {
    return { scope: 'local', dropZone: 'center', cells, hot: [idx(1, 1)], outline: { ...target } };
  }
  // Eixos → linha/coluna inteira (faixa de 1/3 do lado).
  if (col === 1 && row === 0) {
    return localAxis('top', cells, [idx(0, 0), idx(0, 1), idx(0, 2)], {
      x: target.x,
      y: target.y,
      width: target.width,
      height: ch,
    });
  }
  if (col === 1 && row === 2) {
    return localAxis('bottom', cells, [idx(2, 0), idx(2, 1), idx(2, 2)], {
      x: target.x,
      y: target.y + 2 * ch,
      width: target.width,
      height: ch,
    });
  }
  if (row === 1 && col === 0) {
    return localAxis('left', cells, [idx(0, 0), idx(1, 0), idx(2, 0)], {
      x: target.x,
      y: target.y,
      width: cw,
      height: target.height,
    });
  }
  if (row === 1 && col === 2) {
    return localAxis('right', cells, [idx(0, 2), idx(1, 2), idx(2, 2)], {
      x: target.x + 2 * cw,
      y: target.y,
      width: cw,
      height: target.height,
    });
  }
  // Cantos → célula única; o nome do canto vai ao core (que mapeia para a borda horizontal dominante).
  const cornerZone = `${row === 0 ? 'top' : 'bottom'}_${col === 0 ? 'left' : 'right'}`;
  const i = idx(row, col);
  return { scope: 'local', dropZone: cornerZone, cells, hot: [i], outline: cells[i] as Rect };
}

function localAxis(dropZone: string, cells: Rect[], hot: number[], outline: Rect): HotZone {
  return { scope: 'local', dropZone, cells, hot, outline };
}

/// Serializa o escopo do drop para o `MoveWindow` (ADR 0026): `"global"` ou `"local"`.
export function serializeScope(scope: 'local' | 'global'): string {
  return scope === 'global' ? 'global' : 'local';
}

// ---- Ordem estável das janelas (estado leve da ponte) ----
//
// O core é um BSP determinístico função da ORDEM de entrada; manter uma ordem estável por
// `(monitor, workspace)` evita reshuffle no foco e torna o rearranjo do drop persistente sem que o
// daemon guarde estado. Helpers puros (testáveis sem GJS).

/// Chave do grupo de ordenação.
export function orderKey(monitor: number, workspace: number): string {
  return `${monitor}:${workspace}`;
}

/// Acrescenta `id` ao fim do grupo `key` se ainda não estiver presente (mutação in-place do mapa).
export function appendToOrder(order: Map<string, number[]>, key: string, id: number): void {
  const list = order.get(key);
  if (!list) {
    order.set(key, [id]);
  } else if (!list.includes(id)) {
    list.push(id);
  }
}

/// Remove `id` de TODOS os grupos (a janela pode ter mudado de monitor/workspace antes de fechar).
export function removeFromOrder(order: Map<string, number[]>, id: number): void {
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
export function sortByOrder(order: Map<string, number[]>, key: string, ids: number[]): number[] {
  const ranks = order.get(key) ?? [];
  const rankOf = (id: number): number => {
    const r = ranks.indexOf(id);
    return r === -1 ? Number.MAX_SAFE_INTEGER : r;
  };
  // Estável: ordena por rank; empates (ids novos) mantêm a ordem de entrada via índice.
  return ids
    .map((id, index) => ({ id, index }))
    .sort((a, b) => rankOf(a.id) - rankOf(b.id) || a.index - b.index)
    .map((e) => e.id);
}


// ---- Estado de abas (stacks) e de tiling por grupo (estado leve da ponte) ----
//
// Como a ordem, este estado vive na ponte (o daemon é sem estado): quais janelas estão empilhadas
// (`Map<orderKey, Stack[]>`) e quais grupos `(monitor, workspace)` têm tiling desligado (`Set<orderKey>`).
// É enviado a cada `SyncWindows` via `state_json`; o core decide a geometria. Helpers PUROS (testáveis).

/// Um stack: membros na ordem das abas + a aba ativa (visível).
export interface Stack {
  members: number[];
  active: number;
}

/// Célula de um `grid` na árvore (espelha `etherbit_tiling_core::GridChild`): nó recursivo + posição
/// `(col,row)` (0-based) e span em colunas/linhas (1..=3).
export interface TreeGridCell {
  node: TreeNode;
  col: number;
  row: number;
  col_span: number;
  row_span: number;
}

/// Nó da árvore persistente (espelha o blob do daemon `etherbit_tiling_core::Node`, ADR 0026): folha
/// `{ win }`, stack `{ stack }` ou grid elástico `{ grid: { cols, rows, cells } }`. A ponte GNOME trata
/// o `root` como OPACO (produzido/consumido pelo core) — só o transporta e o persiste por grupo.
export type TreeNode =
  | { win: number }
  | { stack: { members: number[]; active: number } }
  | { grid: { cols: number[]; rows: number[]; cells: TreeGridCell[] } };

/// Reverte `orderKey`: `"monitor:workspace"` → `[monitor, workspace]`.
export function parseOrderKey(key: string): [number, number] {
  const [m, w] = key.split(':');
  return [Number(m) || 0, Number(w) || 0];
}

/// Serializa o estado leve para o `state_json` do contrato D-Bus. Só stacks com ≥ 2 membros viajam
/// (um stack de 1 não faz sentido). `disabled_groups` é um array de pares `[monitor, workspace]`.
export function serializeState(
  stacks: Map<string, Stack[]>,
  disabled: Set<string>,
  trees: Map<string, TreeNode | null>,
  focusedId: number,
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
      if (s.members.length >= 2) {
        stackDtos.push({ monitor, workspace, members: [...s.members], active: s.active });
      }
    }
  }
  const disabledDtos: Array<[number, number]> = [];
  for (const key of disabled) {
    disabledDtos.push(parseOrderKey(key));
  }
  // Árvores persistentes por grupo (o core reconcilia e devolve a versão atualizada).
  const treeDtos: Array<{ monitor: number; workspace: number; root: TreeNode | null }> = [];
  for (const [key, root] of trees) {
    const [monitor, workspace] = parseOrderKey(key);
    treeDtos.push({ monitor, workspace, root });
  }
  return JSON.stringify({
    stacks: stackDtos,
    disabled_groups: disabledDtos,
    trees: treeDtos,
    focused_id: focusedId,
  });
}

/// Lê as árvores devolvidas pelo daemon (`layout_json` do SyncWindows ou `trees_json` do MoveWindow)
/// para a ponte PERSISTIR por grupo. Defensivo: entradas malformadas são puladas; `root` é opaco.
export function parseLayoutTrees(json: string): Map<string, TreeNode | null> {
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
    out.set(orderKey(e.monitor, e.workspace), (e.root ?? null) as TreeNode | null);
  }
  return out;
}

/// Uma borda redimensionada + quanto a janela CRESCEU nela (px; negativo = encolheu).
export interface ResizeDelta {
  edge: 'left' | 'right' | 'top' | 'bottom';
  deltaPx: number;
}

/// Infere quais bordas se moveram comparando o frame ANTES e DEPOIS do resize, e quanto a janela
/// cresceu em cada uma (positivo). Agnóstico do compositor (não depende da operação de grab) — vale
/// para GNOME e KDE. Resize de canto devolve duas entradas (uma por eixo).
export function resizeDeltaFrom(
  before: { x: number; y: number; width: number; height: number },
  after: { x: number; y: number; width: number; height: number },
): ResizeDelta[] {
  const out: ResizeDelta[] = [];
  const leftGrow = before.x - after.x; // borda esquerda foi para a esquerda → cresceu
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

/// Remove `id` de qualquer stack (de qualquer grupo), dissolvendo stacks que ficarem com < 2 membros
/// e limpando grupos vazios. Usado ao fechar uma janela ou ao movê-la para outro stack. Retorna
/// `true` se algo mudou.
export function removeIdFromStacks(stacks: Map<string, Stack[]>, id: number): boolean {
  let changed = false;
  for (const [key, list] of stacks) {
    for (const s of list) {
      const idx = s.members.indexOf(id);
      if (idx !== -1) {
        s.members.splice(idx, 1);
        if (s.active === id) {
          s.active = s.members[0] ?? 0;
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

/// Toggle de agrupamento do grupo `key` (atalho Super+S). Se já existe stack no grupo → desfaz
/// (ungroup). Senão → empilha TODOS os `ids` do grupo num único stack, com `active` visível.
/// `ids` deve estar na ordem estável do grupo. Retorna `true` se mudou.
export function toggleStackGroup(
  stacks: Map<string, Stack[]>,
  key: string,
  ids: number[],
  active: number,
): boolean {
  const existing = stacks.get(key);
  if (existing && existing.length > 0) {
    stacks.delete(key);
    return true;
  }
  if (ids.length < 2) {
    return false;
  }
  const activeId = ids.includes(active) ? active : (ids[0] as number);
  stacks.set(key, [{ members: [...ids], active: activeId }]);
  return true;
}

/// Empilha a janela arrastada na janela-alvo (drag-to-group). Se o alvo já está num stack do grupo,
/// adiciona o arrastado a ele; senão cria um stack novo `[targetId, draggedId]`. A janela arrastada
/// vira a aba ativa. Remove o arrastado de stacks anteriores. Retorna `true` se mudou.
export function addToStack(
  stacks: Map<string, Stack[]>,
  key: string,
  targetId: number,
  draggedId: number,
): boolean {
  if (targetId === draggedId) {
    return false;
  }
  // O arrastado pode vir de outro stack/grupo: tira de onde estava primeiro.
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

/// Define a aba ativa do stack que contém `member` (clique numa aba). Retorna `true` se mudou.
export function setActiveMember(stacks: Map<string, Stack[]>, member: number): boolean {
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

/// Liga/desliga o tiling do grupo `key` (atalho Super+Y). Retorna `true` (sempre muda).
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
