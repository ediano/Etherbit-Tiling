// bridge.ts — contrato e helpers PUROS da ponte GNOME ↔ daemon (sem dependências de GJS).
//
// A extensão é uma "ponte burra": coleta metadados das janelas e dos monitores, envia ao daemon
// via `SyncWindows` e apenas APLICA os retângulos devolvidos. Toda a decisão de layout vive no
// core (Rust). Aqui ficam só a montagem do JSON de saída e o parse defensivo do layout de volta —
// isolados de `gi://` para serem testáveis em Node/vitest (ver ADR rules/0016).

/// Espelha o `WindowDto` do daemon (platform-linux-daemon/daemon/src/protocol.rs).
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

/// Drop = TROCA (swap) a posição do arrastado com a do alvo dentro do grupo `key`. Se a janela
/// arrastada ainda não estiver no grupo (mudou de monitor/workspace), insere-a na posição do alvo.
/// Retorna `true` se algo mudou. MVP do rearranjo; split de folha arbitrária fica para o futuro.
export function reorderForDrop(
  order: Map<string, number[]>,
  key: string,
  draggedId: number,
  targetId: number,
): boolean {
  if (draggedId === targetId) {
    return false;
  }
  const list = order.get(key);
  if (!list) {
    return false;
  }
  const ti = list.indexOf(targetId);
  if (ti === -1) {
    return false;
  }
  const di = list.indexOf(draggedId);
  if (di === -1) {
    // Arrastada veio de outro grupo: insere na posição do alvo.
    list.splice(ti, 0, draggedId);
    return true;
  }
  [list[di], list[ti]] = [list[ti] as number, list[di] as number];
  return true;
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

/// Reverte `orderKey`: `"monitor:workspace"` → `[monitor, workspace]`.
export function parseOrderKey(key: string): [number, number] {
  const [m, w] = key.split(':');
  return [Number(m) || 0, Number(w) || 0];
}

/// Serializa o estado leve para o `state_json` do contrato D-Bus. Só stacks com ≥ 2 membros viajam
/// (um stack de 1 não faz sentido). `disabled_groups` é um array de pares `[monitor, workspace]`.
export function serializeState(stacks: Map<string, Stack[]>, disabled: Set<string>): string {
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
  return JSON.stringify({ stacks: stackDtos, disabled_groups: disabledDtos });
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
