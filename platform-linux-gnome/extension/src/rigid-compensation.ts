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
/// e `workAreas` localizam cada rect no seu monitor; `gap` é o espaçamento configurado, tratado como
/// BARREIRA FÍSICA INVIOLÁVEL (ADR 0049): preservado como margem externa (Fase I) e interna (Fase II),
/// nunca colapsado — salvo overflow real de hardware, onde cede por último e só o necessário.
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

/// Separação COM SINAL entre `a` e `b` no eixo principal, olhando apenas para as bordas voltadas uma
/// para a outra: negativo = sobreposição (px); positivo = espaço livre entre elas (px). É o que permite
/// tratar o `gap` como barreira: uma folga menor que `gap` (mesmo sem overlap) já viola o espaçamento.
function separationBetween(a: CompRect, b: CompRect, axis: Axis): number {
  const aLo = mainPos(a, axis);
  const aHi = aLo + mainSize(a, axis);
  const bLo = mainPos(b, axis);
  const bHi = bLo + mainSize(b, axis);
  return Math.max(aLo, bLo) - Math.min(aHi, bHi);
}

/// Faz o vizinho `o` CEDER a `w` no eixo, deixando um `gap` INTEIRO entre eles: empurra a borda de `o`
/// voltada para `w` até `gap` px além da borda oposta de `w`, MANTENDO a borda de `o` mais distante de
/// `w` (a compressão fica local no lado de `o` voltado para `w`). O `gap` é INVIOLÁVEL nos casos
/// normais — encolhe o vizinho (nível 3) preservando o espaçamento. Em overflow REAL de hardware (duas
/// rígidas somam mais que a tela), o `Math.max(1, …)` clampa o vizinho a 1px: aí, e só aí, o gap
/// efetivo cede POR ÚLTIMO (o vizinho já esgotou o próprio corpo). A rígida vencedora nunca é tocada.
/// `clampGeometry` na aplicação também garante ≥ 1px.
function yieldNeighbor(w: CompRect, o: CompRect, axis: Axis, gap: number): void {
  const wLo = mainPos(w, axis);
  const wHi = wLo + mainSize(w, axis);
  const oLo = mainPos(o, axis);
  const oHi = oLo + mainSize(o, axis);
  const oCenter = oLo + mainSize(o, axis) / 2;
  const wCenter = wLo + mainSize(w, axis) / 2;

  if (oCenter >= wCenter) {
    // `o` está DEPOIS de `w` (à direita/abaixo): recua a borda inicial de `o` para `wHi + gap`,
    // preservando a borda final `oHi`. Deixa o gap inteiro; só encolhe abaixo dele em overflow real.
    const newLo = Math.max(oLo, wHi + gap);
    const newSize = Math.max(1, oHi - newLo);
    setMainPos(o, axis, oHi - newSize);
    setMainSize(o, axis, newSize);
  } else {
    // `o` está ANTES de `w` (à esquerda/acima): recua a borda final de `o` para `wLo - gap`,
    // preservando a borda inicial `oLo`.
    const newHi = Math.min(oHi, wLo - gap);
    const newSize = Math.max(1, newHi - oLo);
    setMainSize(o, axis, newSize);
    // borda inicial (oLo) preservada; a borda final recuou.
  }
}

/// Compensa UM eixo dos rects de UM monitor (mutação in-place). Fase I: trava cada rígida no seu mínimo
/// e a desloca para dentro da work area PRESERVANDO o gap externo (a margem que o core teria deixado).
/// Fase II: garante o gap INTERNO — o rect de MENOR prioridade cede ao de maior (rígida > flexível;
/// entre iguais, menor índice de entrada vence) sempre que a folga entre eles for menor que `gap`.
/// Vizinhos cedem preservando a borda distante, então nenhum novo overlap é criado no lado oposto — uma
/// passada por vencedor converge. Determinístico: ordem fixa por prioridade e índice; `gap` inviolável.
function compensateAxis(
  rects: CompRect[],
  mins: Map<number, RigidMin>,
  wa: CompWorkArea,
  axis: Axis,
  gap: number,
): void {
  const lo = waLo(wa, axis);
  const size = waSize(wa, axis);
  const hi = lo + size;
  // Limites internos: a borda útil recuada do `gap` inviolável em cada lado.
  const loInner = lo + gap;
  const hiInner = hi - gap;

  // Fase I — trava no mínimo + desloca para dentro da work area (preservando o gap externo).
  for (const r of rects) {
    const m = minOn(mins.get(r.id), axis);
    if (m <= 0) continue;
    let s = mainSize(r, axis);
    if (s < m) s = m;
    if (s > size) s = size; // mínimo maior que a tela: clamp de hardware (não há como caber além disso).
    setMainSize(r, axis, s);
    let p = mainPos(r, axis);
    if (s <= size - 2 * gap) {
      // Cabe com os DOIS gaps externos: só reancora se transbordar os limites internos (não mexe numa
      // janela que já está confortavelmente dentro — preserva idempotência).
      if (p + s > hiInner) p = hiInner - s; // transbordou a borda final → ancora com gap externo.
      if (p < loInner) p = loInner; // transbordou a borda inicial → ancora com gap externo.
    } else {
      // Cabe no monitor mas não com os dois gaps completos: o gap externo cede POR ÚLTIMO e só o
      // necessário — mantém a rígida inteira, dentro do monitor, ancorando o mais próximo possível dela.
      if (p + s > hi) p = hi - s;
      if (p < lo) p = lo;
    }
    setMainPos(r, axis, p);
  }

  // Prioridade (menor = vence): rígida no eixo vem antes de flexível; empate desfeito pelo índice.
  const rankOf = new Map<number, number>();
  rects.forEach((r, i) => {
    const rigidBucket = minOn(mins.get(r.id), axis) > 0 ? 0 : 1;
    rankOf.set(r.id, rigidBucket * (rects.length + 1) + i);
  });
  const rank = (id: number): number => rankOf.get(id) ?? Number.MAX_SAFE_INTEGER;

  // Fase II — vencedores em ordem de prioridade fazem os vizinhos de menor prioridade cederem sempre que
  // a folga entre eles for menor que o `gap` (sobreposição OU aproximação demais violam o espaçamento).
  const winners = [...rects].sort((a, b) => rank(a.id) - rank(b.id));
  for (const w of winners) {
    for (const o of rects) {
      if (o === w) continue;
      if (rank(o.id) <= rank(w.id)) continue; // `o` tem prioridade ≥ `w`: não cede a ele.
      if (!sharePerpBand(w, o, axis)) continue;
      if (separationBetween(w, o, axis) >= gap) continue; // já há gap suficiente → não mexe.
      yieldNeighbor(w, o, axis, gap);
    }
  }
}

/// Descrição de UM grupo de abas (stack) para a compensação por SLOT (ADR 0050). O `slot` geométrico é
/// `bar ∪ content` — que no core equivale EXATAMENTE ao retângulo do stack (`srect`): a barra é a faixa
/// `barHeight` no topo, o content é o resto (mesmos `x`/`width`). `activeId` é o id da aba ativa (a única
/// que o core emite como `WindowRect`), usado como chave do slot; `memberIds` é a ordem das abas.
export interface StackSlot {
  activeId: number;
  memberIds: number[];
  bar: CompRect; // faixa da barra CRUA (id = activeId).
  content: CompRect; // content da aba ativa CRU (id = activeId).
  barHeight: number; // = bar.height (group_header_px efetivo, já clampado pelo core).
}

/// Entrada da compensação por slot: a de janelas soltas + a descrição dos stacks. `mins[activeId]` já
/// deve trazer a SOBERANIA do grupo (MAX do min efetivo de todos os membros; a altura já com `barHeight`).
export interface CompensationInputWithStacks extends CompensationInput {
  stacks: StackSlot[];
}

/// Saída da compensação por slot: os `commands` (a aba ativa refatiada = content compensado) e o mapa
/// `bars` (activeId → faixa da barra compensada). Barra e janela vêm da MESMA fonte → sincronizadas.
export interface CompensationResult {
  commands: CompRect[];
  bars: Map<number, CompRect>;
}

/// Núcleo da compensação física (ADR 0048): agrupa `rects` por monitor e roda `compensateAxis` (X depois
/// Y) em cada monitor que tenha ≥ 1 rect rígido. MUTA `rects` in-place. Extraído para ser reusado tanto
/// por `compensateRigidWindows` (janelas soltas) quanto por `compensateWithStacks` (slots + soltas).
function compensateRects(
  rects: CompRect[],
  mins: Map<number, RigidMin>,
  workAreas: Map<number, CompWorkArea>,
  monitorOf: Map<number, number>,
  gap: number,
): void {
  // Agrupa por monitor; só processa monitores que tenham ≥ 1 janela rígida.
  const byMonitor = new Map<number, CompRect[]>();
  for (const r of rects) {
    const mon = monitorOf.get(r.id);
    if (mon === undefined || !workAreas.has(mon)) continue; // sem monitor/work area conhecida → intacto.
    const arr = byMonitor.get(mon);
    if (arr) arr.push(r);
    else byMonitor.set(mon, [r]);
  }
  for (const [mon, group] of byMonitor) {
    const wa = workAreas.get(mon);
    if (!wa) continue;
    const hasRigid = group.some((r) => mins.has(r.id));
    if (!hasRigid) continue;
    // Eixos independentes. X primeiro, depois Y (as operações de X só tocam x/width; as de Y, y/height).
    compensateAxis(group, mins, wa, 'x', gap);
    compensateAxis(group, mins, wa, 'y', gap);
  }
}

/// Arredonda um rect para inteiro IN-PLACE (o core entrega i32; o /2 dos centros pode gerar subpixel) —
/// evita que a assinatura de dedup da ponte oscile entre `100.0000001` e `100`.
function roundRect(r: CompRect): void {
  r.x = Math.round(r.x);
  r.y = Math.round(r.y);
  r.width = Math.round(r.width);
  r.height = Math.round(r.height);
}

/// Compensação física de min-size (GNOME-only, ADR 0048). Recebe os rects CRUS do core + os mínimos das
/// janelas + as work areas por monitor, e devolve uma NOVA lista de rects onde toda janela rígida ≥ seu
/// mínimo, nada transborda a work area e a sobreposição foi eliminada (ou reduzida a truncamento de
/// borda no vizinho). PURA e DETERMINÍSTICA (mesma entrada → mesma saída, para o dedup de layout da
/// ponte não oscilar). Não muta a entrada. `mins` vazio → devolve os comandos inalterados (no-op).
export function compensateRigidWindows(input: CompensationInput): CompRect[] {
  const { commands, mins, workAreas, monitorOf, gap } = input;
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

  compensateRects(out, mins, workAreas, monitorOf, gap);
  for (const r of out) roundRect(r);
  return out;
}

/// Compensação física POR SLOT para grupos de abas (GNOME-only, ADR 0050). Trata cada stack como UM slot
/// único (`bar ∪ content`), de modo que a barra e a janela ativa passem a vir da MESMA geometria
/// compensada — eliminando a dessincronização em que a barra (crua do core) e a janela (compensada)
/// divergiam. O `mins[activeId]` deve trazer a SOBERANIA do grupo (o maior mínimo entre TODOS os membros,
/// com `barHeight` embutido na altura): a Fase I trava o slot nesse mínimo e a Fase II empurra os
/// quadrantes vizinhos — sem clipping de janela rígida em célula apertada. PURA e DETERMINÍSTICA.
/// Não muta a entrada. Devolve os `commands` (ativa refatiada = content) e o mapa `bars` (por activeId).
export function compensateWithStacks(input: CompensationInputWithStacks): CompensationResult {
  const { commands, mins, workAreas, monitorOf, gap, stacks } = input;

  // Clona (não muta a entrada); preserva a ordem original na saída.
  const out: CompRect[] = commands.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
  }));
  const byId = new Map<number, CompRect>();
  for (const r of out) byId.set(r.id, r);

  // EXPANDE cada aba ativa ao seu slot (= `srect` = bar ∪ content), in-place. Stacks cuja ativa não veio
  // em `commands` (ex.: dropada numa corrida) são puladas — a barra crua será devolvida no fatiamento.
  const expanded = new Set<number>();
  for (const s of stacks) {
    const cmd = byId.get(s.activeId);
    if (!cmd) continue;
    cmd.x = s.bar.x;
    cmd.y = s.bar.y;
    cmd.width = s.bar.width;
    cmd.height = s.barHeight + s.content.height; // reconstrói o srect original exato.
    expanded.add(s.activeId);
  }

  // Compensa (slots rígidos + janelas soltas) se houver algo rígido; depois arredonda tudo.
  if (mins.size > 0) {
    compensateRects(out, mins, workAreas, monitorOf, gap);
  }
  for (const r of out) roundRect(r);

  // FATIA cada slot compensado de volta: a barra é a faixa `barHeight` no topo; o content é o resto,
  // abaixo dela. Escreve o content no command (mantendo o id) e registra a barra no mapa.
  const bars = new Map<number, CompRect>();
  for (const s of stacks) {
    const cmd = byId.get(s.activeId);
    if (!cmd || !expanded.has(s.activeId)) {
      // Ativa ausente: devolve a barra CRUA arredondada para a ponte ainda ter onde desenhar.
      const raw: CompRect = {
        id: s.activeId,
        x: s.bar.x,
        y: s.bar.y,
        width: s.bar.width,
        height: s.bar.height,
      };
      roundRect(raw);
      bars.set(s.activeId, raw);
      continue;
    }
    const slotH = cmd.height;
    // Clamp de hardware: slot menor que a faixa → a barra encolhe para caber (espelha o `bar_h.min(srect.h)`
    // do core); o content nunca fica < 1px.
    const barH = Math.min(s.barHeight, slotH);
    bars.set(s.activeId, { id: s.activeId, x: cmd.x, y: cmd.y, width: cmd.width, height: barH });
    cmd.y = cmd.y + barH;
    cmd.height = Math.max(1, slotH - barH);
  }

  return { commands: out, bars };
}
