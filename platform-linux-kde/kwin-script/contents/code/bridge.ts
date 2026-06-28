// bridge.ts — contrato e helpers PUROS da ponte KWin ↔ daemon (sem globais do KWin).
//
// Espelho 1:1 do bridge.ts da extensão GNOME (como config.ts já é espelhado). O KWin script é uma
// "ponte burra": coleta metadados das janelas/monitores, chama `SyncWindows` e APLICA os retângulos
// devolvidos. Toda decisão de layout vive no core (Rust). Aqui só a montagem do JSON e o parse
// defensivo — isolados das globais do KWin para serem testáveis em Node/vitest (ver ADR rules/0016).

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

/// Parse defensivo do `layout_json` do daemon. Descarta entradas malformadas (campos não
/// numéricos / ausentes) em vez de lançar — uma resposta inválida nunca deve derrubar a ponte.
export function parseLayout(json: string): LayoutCommand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const commands: LayoutCommand[] = [];
  for (const entry of parsed) {
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

/// Drop = TROCA (swap) a posição do arrastado com a do alvo dentro do grupo `key`. Se o arrastado
/// ainda não estiver no grupo, insere-o na posição do alvo. Retorna `true` se algo mudou.
export function reorderForDrop(
  order: Map<string, string[]>,
  key: string,
  draggedId: string,
  targetId: string,
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
    list.splice(ti, 0, draggedId);
    return true;
  }
  [list[di], list[ti]] = [list[ti] as string, list[di] as string];
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
