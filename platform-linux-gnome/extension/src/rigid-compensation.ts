// rigid-compensation.ts — compensação física de min-size, EXCLUSIVA do GNOME (ADR 0048).
//
// Lógica PURA (sem `import 'gi://…'`), testável em Node/vitest — espelha o padrão de `bridge.ts`.
//
// Contexto (ver ADR 0048): o core, via esmagamento impositivo (ADR 0040), dá a cada janela rígida seu
// mínimo EXATO mas quebra deliberadamente a invariante `Σ tracks == avail`, produzindo rects que podem
// TRANSBORDAR a work area ou SOBREPOR vizinhos ("deslocamento compensatório"). No KDE o KWin absorve
// isso nativamente; no GNOME, o Mutter/Wayland aceita o mínimo do cliente mas REJEITA um
// `move_resize_frame` abaixo do mínimo → a janela oscila/flutua/sobrepõe. Esta passada transforma os
// rects CRUS do core numa geometria de EXIBIÇÃO onde toda janela rígida fica ≥ seu mínimo, nada
// transborda a work area e a sobreposição some (ou vira truncamento de borda limitado no vizinho).
//
// É uma transformação de EXIBIÇÃO: roda a cada relayout na ponte GNOME e NUNCA é persistida de volta
// ao core (que mantém as coordenadas lógicas cruas na árvore `_trees`). Não toca daemon nem KDE.

/// Retângulo geométrico (mesma forma de `LayoutCommand`).
export interface CompRect {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Tamanho mínimo imposto por uma janela (geometry hint, px de frame). `0` = flexível naquele eixo.
export interface RigidMin {
  minWidth: number;
  minHeight: number;
}

/// Área útil de um monitor (já descontadas barras/docks).
export interface CompWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// Entrada da compensação. `mins` só carrega janelas com mínimo > 0 (ausente = flexível); `monitorOf`
/// e `workAreas` localizam cada rect no seu monitor; `gap` é o espaçamento configurado (reservado
/// para políticas de espaçamento; a reabsorção de gap já emerge das arestas dos rects do core).
export interface CompensationInput {
  commands: CompRect[];
  mins: Map<number, RigidMin>;
  workAreas: Map<number, CompWorkArea>;
  monitorOf: Map<number, number>;
  gap: number;
}

/// Eixo de processamento. X (largura) e Y (altura) são tratados de forma INDEPENDENTE.
type Axis = 'x' | 'y';

/// Sobreposição perpendicular mínima (px) para considerar dois rects "lado a lado" no eixo — evita
/// empurrar uma janela que está noutra faixa (linha/coluna) e só encosta numa quina.
const BAND_EPS = 1;

function mainPos(r: CompRect, axis: Axis): number {
  return axis === 'x' ? r.x : r.y;
}
function mainSize(r: CompRect, axis: Axis): number {
  return axis === 'x' ? r.width : r.height;
}
function setMainPos(r: CompRect, axis: Axis, v: number): void {
  if (axis === 'x') r.x = v;
  else r.y = v;
}
function setMainSize(r: CompRect, axis: Axis, v: number): void {
  if (axis === 'x') r.width = v;
  else r.height = v;
}
function perpLo(r: CompRect, axis: Axis): number {
  return axis === 'x' ? r.y : r.x;
}
function perpSize(r: CompRect, axis: Axis): number {
  return axis === 'x' ? r.height : r.width;
}
function waLo(wa: CompWorkArea, axis: Axis): number {
  return axis === 'x' ? wa.x : wa.y;
}
function waSize(wa: CompWorkArea, axis: Axis): number {
  return axis === 'x' ? wa.width : wa.height;
}
function minOn(min: RigidMin | undefined, axis: Axis): number {
  if (!min) return 0;
  return axis === 'x' ? min.minWidth : min.minHeight;
}

/// `true` se `a` e `b` compartilham faixa no eixo PERPENDICULAR (logo estão realmente lado a lado nesse
/// eixo, não em linhas/colunas diferentes que só se tocam numa quina).
function sharePerpBand(a: CompRect, b: CompRect, axis: Axis): boolean {
  const aLo = perpLo(a, axis);
  const aHi = aLo + perpSize(a, axis);
  const bLo = perpLo(b, axis);
  const bHi = bLo + perpSize(b, axis);
  return Math.min(aHi, bHi) - Math.max(aLo, bLo) > BAND_EPS;
}

/// Quanto `a` e `b` se sobrepõem NO EIXO principal (positivo = sobreposição em px).
function mainOverlap(a: CompRect, b: CompRect, axis: Axis): number {
  const aLo = mainPos(a, axis);
  const aHi = aLo + mainSize(a, axis);
  const bLo = mainPos(b, axis);
  const bHi = bLo + mainSize(b, axis);
  return Math.min(aHi, bHi) - Math.max(aLo, bLo);
}

/// Faz o vizinho `o` CEDER a `w` no eixo, removendo a sobreposição: empurra a borda de `o` encostada em
/// `w` até a borda oposta de `w`, MANTENDO a borda de `o` mais distante de `w` (a compressão fica local
/// no lado de `o` voltado para `w`). Encolhe o vizinho (nível 3) e, no limite, o trunca (nível 4) — a
/// rígida vencedora nunca é tocada. `clampGeometry` na aplicação garante ≥ 1px; aqui já limitamos a 1.
function yieldNeighbor(w: CompRect, o: CompRect, axis: Axis): void {
  const wLo = mainPos(w, axis);
  const wHi = wLo + mainSize(w, axis);
  const oLo = mainPos(o, axis);
  const oHi = oLo + mainSize(o, axis);
  const oCenter = oLo + mainSize(o, axis) / 2;
  const wCenter = wLo + mainSize(w, axis) / 2;

  if (oCenter >= wCenter) {
    // `o` está DEPOIS de `w` (à direita/abaixo): recua a borda inicial de `o` para `wHi`, preservando a
    // borda final `oHi`. Encolhe `o` exatamente pela sobreposição.
    const newLo = Math.max(oLo, wHi);
    const newSize = Math.max(1, oHi - newLo);
    setMainPos(o, axis, oHi - newSize);
    setMainSize(o, axis, newSize);
  } else {
    // `o` está ANTES de `w` (à esquerda/acima): recua a borda final de `o` para `wLo`, preservando a
    // borda inicial `oLo`.
    const newHi = Math.min(oHi, wLo);
    const newSize = Math.max(1, newHi - oLo);
    setMainSize(o, axis, newSize);
    // borda inicial (oLo) preservada; a borda final recuou.
  }
}

/// Compensa UM eixo dos rects de UM monitor (mutação in-place). Fase I: trava cada rígida no seu mínimo
/// e a desloca para dentro da work area (recupera a margem externa). Fase II: resolve sobreposições — o
/// rect de MENOR prioridade cede ao de maior (rígida > flexível; entre iguais, menor índice de entrada
/// vence). Vizinhos cedem preservando a borda distante, então nenhum novo overlap é criado no lado
/// oposto — uma passada por vencedor converge. Determinístico: ordem fixa por prioridade e índice.
function compensateAxis(
  rects: CompRect[],
  mins: Map<number, RigidMin>,
  wa: CompWorkArea,
  axis: Axis,
): void {
  const lo = waLo(wa, axis);
  const size = waSize(wa, axis);
  const hi = lo + size;

  // Fase I — trava no mínimo + desloca para dentro da work area.
  for (const r of rects) {
    const m = minOn(mins.get(r.id), axis);
    if (m <= 0) continue;
    let s = mainSize(r, axis);
    if (s < m) s = m;
    if (s > size) s = size; // mínimo maior que a tela: clamp de hardware (não há como caber além disso).
    setMainSize(r, axis, s);
    let p = mainPos(r, axis);
    if (p + s > hi) p = hi - s; // transbordou a borda final → ancora à borda.
    if (p < lo) p = lo; // transbordou a borda inicial → ancora à borda.
    setMainPos(r, axis, p);
  }

  // Prioridade (menor = vence): rígida no eixo vem antes de flexível; empate desfeito pelo índice.
  const rankOf = new Map<number, number>();
  rects.forEach((r, i) => {
    const rigidBucket = minOn(mins.get(r.id), axis) > 0 ? 0 : 1;
    rankOf.set(r.id, rigidBucket * (rects.length + 1) + i);
  });
  const rank = (id: number): number => rankOf.get(id) ?? Number.MAX_SAFE_INTEGER;

  // Fase II — vencedores em ordem de prioridade fazem os vizinhos de menor prioridade cederem.
  const winners = [...rects].sort((a, b) => rank(a.id) - rank(b.id));
  for (const w of winners) {
    for (const o of rects) {
      if (o === w) continue;
      if (rank(o.id) <= rank(w.id)) continue; // `o` tem prioridade ≥ `w`: não cede a ele.
      if (!sharePerpBand(w, o, axis)) continue;
      if (mainOverlap(w, o, axis) <= 0) continue;
      yieldNeighbor(w, o, axis);
    }
  }
}

/// Compensação física de min-size (GNOME-only, ADR 0048). Recebe os rects CRUS do core + os mínimos das
/// janelas + as work areas por monitor, e devolve uma NOVA lista de rects onde toda janela rígida ≥ seu
/// mínimo, nada transborda a work area e a sobreposição foi eliminada (ou reduzida a truncamento de
/// borda no vizinho). PURA e DETERMINÍSTICA (mesma entrada → mesma saída, para o dedup de layout da
/// ponte não oscilar). Não muta a entrada. `mins` vazio → devolve os comandos inalterados (no-op).
export function compensateRigidWindows(input: CompensationInput): CompRect[] {
  const { commands, mins, workAreas, monitorOf } = input;
  if (mins.size === 0) {
    return commands; // caminho comum (sem janelas rígidas): nada a fazer.
  }

  // Clona (não muta a entrada); preserva a ordem original na saída.
  const out: CompRect[] = commands.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
  }));

  // Agrupa por monitor; só processa monitores que tenham ≥ 1 janela rígida.
  const byMonitor = new Map<number, CompRect[]>();
  for (const r of out) {
    const mon = monitorOf.get(r.id);
    if (mon === undefined || !workAreas.has(mon)) continue; // sem monitor/work area conhecida → intacto.
    const arr = byMonitor.get(mon);
    if (arr) arr.push(r);
    else byMonitor.set(mon, [r]);
  }

  for (const [mon, rects] of byMonitor) {
    const wa = workAreas.get(mon);
    if (!wa) continue;
    const hasRigid = rects.some((r) => mins.has(r.id));
    if (!hasRigid) continue;
    // Eixos independentes. X primeiro, depois Y (as operações de X só tocam x/width; as de Y, y/height).
    compensateAxis(rects, mins, wa, 'x');
    compensateAxis(rects, mins, wa, 'y');
  }

  // Arredonda para inteiro (o core entrega i32; o /2 dos centros pode gerar subpixel) — evita que a
  // assinatura de dedup da ponte oscile entre `100.0000001` e `100`.
  for (const r of out) {
    r.x = Math.round(r.x);
    r.y = Math.round(r.y);
    r.width = Math.round(r.width);
    r.height = Math.round(r.height);
  }
  return out;
}
