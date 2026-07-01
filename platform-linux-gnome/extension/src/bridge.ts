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

/// `true` sse a janela tem tamanho GENUINAMENTE FIXO: `min == max` em AMBOS os eixos, com `max > 0`
/// (os dois travados). Um `max` ausente/0 = "sem teto" → não-fixo. Travar só um eixo não basta — o
/// outro ainda redimensiona. Hints em px de frame (`Meta.Window.get_min_size`/`get_max_size`).
export function isFixedSize(opts: {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}): boolean {
  return (
    opts.maxWidth > 0 &&
    opts.maxHeight > 0 &&
    opts.minWidth === opts.maxWidth &&
    opts.minHeight === opts.maxHeight
  );
}

/// Decide se a janela é redimensionável de forma INDEPENDENTE DO ESTADO (ADR 0037). A propriedade
/// `Meta.Window.resizeable` do Mutter é estado-dependente — retorna `false` enquanto a janela está
/// maximizada/fullscreen —, o que fazia a 1ª janela (que nasce preenchendo a tela) ser descartada
/// como `non_resizable`, preemptando o portão `is_tileable` do core. Confiamos no `resizeable === true`
/// (caminho rápido); quando ele é `false`, derivamos dos hints de tamanho: a janela só é realmente
/// não-redimensionável se for `isFixedSize`. Sem teto / min ≠ max → redimensionável (paridade Cosmic).
/// Diálogos de tamanho fixo reais (`min == max > 0`) seguem corretamente classificados como não.
export function isResizable(opts: {
  rawResizeable: boolean;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}): boolean {
  if (opts.rawResizeable === true) {
    return true;
  }
  return !isFixedSize(opts);
}

/// Último `min-size` REAL conhecido de uma janela, memoizado por id. `Meta.Window.get_min_size()` de
/// uma janela MINIMIZADA/não-mapeada no Wayland devolve `(0,0)`/stale — e como as abas inativas de um
/// grupo são minimizadas, o membro grande (ex.: Firefox alvo) chegaria ao core com min zerado e a
/// célula de abas não expandiria (`build_min_sizes` agrega `max` sobre valores degradados). Enquanto a
/// janela está VISÍVEL e reporta `min > 0`, gravamos o valor no cache; quando a fonte degrada
/// (minimizada), devolvemos o memoizado. Um `raw` zerado de janela VISÍVEL não polui o cache (a janela
/// simplesmente não tem mínimo). Pura e sem dependência de GJS (testável em vitest).
export function effectiveMinSize(
  cache: Map<number, [number, number]>,
  id: number,
  raw: [number, number],
  minimized: boolean,
): [number, number] {
  if (!minimized && (raw[0] > 0 || raw[1] > 0)) {
    cache.set(id, raw);
    return raw;
  }
  return cache.get(id) ?? [0, 0];
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

/// Decide se a maximização (ou fullscreen) de uma janela deve ser SUPRIMIDA por ser "nascida
/// maximizada" no spawn (ADR 0043). Regra:
///   - `!enabled` ou `!isMaximized` → nunca suprime (nada a fazer / Tiling desligado);
///   - dentro da janela de graça pós-nascimento → suprime SEMPRE, mesmo já tilada (`everTiled`): apps
///     de restore lento (GTK/gsettings) auto-maximizam DEPOIS do último settle tick, e essa
///     auto-maximização de spawn não pode ser confundida com ato manual;
///   - após a graça → só suprime se a janela NUNCA foi tilada; do contrário é maximização MANUAL do
///     usuário e deve ser preservada (Unmaximize Recovery, congela o grid). Pura e determinística.
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

/// Uma janela RECEBIDA que o daemon não posicionou, com o motivo (`non_normal`, `non_resizable`,
/// `non_maximizable`, `ignored`, `excluded_maximized`). Puramente diagnóstico — alimenta o log fiel.
export interface DroppedWindow {
  id: number;
  reason: string;
}

/// Parse defensivo do diagnóstico `dropped` do `layout_json`: janelas recebidas que o daemon NÃO
/// tilou, com o motivo. Ausente (daemon antigo) ou malformado → vazio. Não afeta o layout, só o log.
export function parseDropped(json: string): DroppedWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const raw = (parsed as Record<string, unknown>).dropped;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: DroppedWindow[] = [];
  for (const entry of raw) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === 'number' &&
      typeof (entry as Record<string, unknown>).reason === 'string'
    ) {
      const e = entry as { id: number; reason: string };
      out.push({ id: e.id, reason: e.reason });
    }
  }
  return out;
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

// ---- HUD de preview de "eixos limpos" (cálculo LOCAL na ponte — ADR 0028) ----
//
// Durante o arrasto, a ponte NÃO chama o Rust por tick: lê o retângulo da janela-alvo sob o cursor e
// resolve o destino LOCALMENTE — centro de uma janela → fusão em abas; fora do centro → split 50/50 do
// slot do alvo; gap vazio → 50% pela borda (ou monitor inteiro no miolo central). Devolve a(s) célula(s)
// a desenhar + o realce + o retângulo resultante. O core só é acionado no DROP (MoveWindow). Helpers
// PUROS (testáveis sem GJS), espelhados na ponte KDE.

/// Retângulo simples em px absolutos de tela.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Verifica se a geometria que NÓS aplicamos "pegou" na tela (dedup gated por realização, ADR 0038).
/// `last` = rects que committamos (por id); `current` = `get_frame_rect()` atuais. Devolve `true` se
/// todo id de `last` que ainda existe em `current` bate dentro de `epsilon` (px). Ids ausentes em
/// `current` (janela fechada/maximizada — o chamador os exclui) são ignorados; `last` vazio → `true`.
/// No boot, o compositor descarta o `move_resize_frame` em janelas ainda não realizadas: o frame não
/// bate → NÃO convergiu → o dedup do `_lastLayoutSig` não pode curto-circuitar a reaplicação.
export function geometryConverged(
  last: Map<number, Rect>,
  current: Map<number, Rect>,
  epsilon: number,
): boolean {
  for (const [id, want] of last) {
    const got = current.get(id);
    if (!got) {
      continue;
    }
    if (
      Math.abs(got.x - want.x) > epsilon ||
      Math.abs(got.y - want.y) > epsilon ||
      Math.abs(got.width - want.width) > epsilon ||
      Math.abs(got.height - want.height) > epsilon
    ) {
      return false;
    }
  }
  return true;
}

/// Resultado do HUD: a zona quente sob o cursor, as células a desenhar e o destino do drop.
export interface HotZone {
  /// `local` = sobre uma janela-alvo: centro → fusão em abas (a ponte chama `addToStack`); fora do
  /// centro → split 50/50 do slot do alvo. `global` = gap vazio: 50% pela borda, ou monitor inteiro
  /// (maximizar) no miolo central.
  scope: 'local' | 'global';
  /// Comando a enviar no drop: `left|right|top|bottom|center|none`. `center` com escopo `local` =
  /// fusão em abas (a ponte intercepta e chama `addToStack`, NÃO manda MoveWindow); `center` com
  /// escopo `global` = maximizar (monitor inteiro).
  dropZone: string;
  /// Células do HUD a DESENHAR (2 metades no split local; 1 bloco no global/maximizar; 1 realce no
  /// merge). GNOME desenha as presentes e esconde o resto; KDE ignora.
  cells: Rect[];
  /// Índices de `cells` a ACENDER (a zona ativa).
  hot: number[];
  /// Retângulo único do destino. `center` local = a janela-alvo inteira (realce de merge).
  outline: Rect;
}

/// Calcula a zona quente do HUD sob o cursor, sem D-Bus. `target` = retângulo da janela sob o cursor
/// (`null` num gap vazio); `monitor` = área útil do monitor sob o cursor; `draggedMin` = tamanho mínimo
/// da janela em arrasto (estica a metade local do preview se necessário — ADR 0028; `(0,0)` = 50/50 puro).
///  - Miolo CENTRAL de uma janela-alvo → `center` local (a ponte funde em abas via `addToStack`).
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
      const whole = { x: target.x, y: target.y, width: target.width, height: target.height };
      return { scope: 'local', dropZone: 'center', cells: [whole], hot: [0], outline: whole };
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
  return { scope: 'local', dropZone, cells: [block], hot: [0], outline: block };
}

/// `clamp(value, 5%*disp, 95%*disp)`: limita a metade esticada por min-size aos extremos do alvo no eixo.
function clampExtent(value: number, disp: number): number {
  const lo = 0.05 * disp;
  const hi = 0.95 * disp;
  return Math.min(hi, Math.max(lo, value));
}

/// Escopo GLOBAL (gap vazio): miolo central da tela → maximizar (monitor inteiro); senão a borda mais
/// próxima vira um bloco de 50% do monitor.
function globalHotZone(mfx: number, mfy: number, monitor: Rect): HotZone {
  // Miolo central da tela vazia → maximizar (bloco = monitor inteiro). Antes de escolher a borda.
  if (mfx > 1 / 3 && mfx < 2 / 3 && mfy > 1 / 3 && mfy < 2 / 3) {
    const whole = { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height };
    return { scope: 'global', dropZone: 'center', cells: [whole], hot: [0], outline: whole };
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
  return { scope: 'global', dropZone, cells: [block], hot: [0], outline: block };
}

/// Serializa o escopo do drop para o `MoveWindow` (ADR 0028): `"global"` (50%/maximizar) ou `"local"`
/// (split do slot do alvo). O centro local NÃO chega aqui no GNOME — a ponte funde em abas (`addToStack`).
export function serializeScope(scope: 'local' | 'global'): string {
  if (scope === 'global') {
    return 'global';
  }
  return 'local';
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

/// `true` se `id` é membro de ALGUM stack (varre todos os grupos — a janela pode estar num stack de
/// outro monitor/workspace). Consulta PURA e read-only (não muta o Map, ao contrário de
/// `removeIdFromStacks`): usada para decidir se um arraste pela barra de título nativa deve ejetar
/// (desagrupar) em vez de seguir o fluxo normal de move/tile.
export function isStackMember(stacks: Map<string, Stack[]>, id: number): boolean {
  for (const list of stacks.values()) {
    for (const s of list) {
      if (s.members.includes(id)) {
        return true;
      }
    }
  }
  return false;
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
