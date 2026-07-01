# 0048 — Compensação física de min-size na exibição (GNOME-only)

**Status:** ✅ Aceita
(emenda [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md) — o "deslocamento compensatório"
que empurrava as vizinhas para fora da borda deixa de VAZAR para a tela no GNOME; o esmagamento
impositivo do core permanece intacto e agnóstico. NÃO reintroduz o auto-agrupamento por colisão
aposentado por [0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md). Quebra DELIBERADA
e localizada do agnosticismo — reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md)
ao manter a decisão de layout no core e confinar a correção à camada nativa GNOME.)

## Contexto

Regressão **exclusiva do GNOME Shell**: apps com tamanho mínimo rígido de hardware (`min-width`/
`min-height` — Calculadora, GNOME Settings, lojas de apps) quebram o tiling: ficam parcialmente
flutuantes, sobrepõem vizinhos ou oscilam. No **KDE (KWin)** o comportamento elástico nativo já é fluido.

Diagnóstico nas três camadas: o esmagamento impositivo do core ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md),
`solve_tracks`/`compute_constrained`) dá a cada janela rígida seu mínimo EXATO mas **quebra
deliberadamente** a invariante `Σ tracks == avail`, produzindo rects que podem **transbordar a work
area ou sobrepor vizinhos** ("deslocamento compensatório"). No KDE o KWin absorve isso nativamente. No
GNOME, o Mutter/Wayland aceita o mínimo do cliente mas **rejeita `move_resize_frame` abaixo do mínimo**:
a janela oscila/sobrepõe → a checagem `geometryConverged` ([0038](0038-realizacao-gated-dedup-e-boot-settle.md))
falha → o relayout re-dispara em loop. A remoção do auto-agrupamento por colisão
([0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)) tirou o paliativo que "escondia"
a sobreposição empilhando as janelas em abas — reintroduzi-lo está fora de cogitação (contradiz o 0046).

A raiz do problema é de **ecossistema**: uma particularidade do Mutter sobre o Wayland, não uma falha do
cálculo geométrico. Por isso a correção **não pode** poluir o core (que deve permanecer puro e universal)
nem o daemon/KDE — ela pertence à camada que aplica a geometria no GNOME.

## Decisão

Uma passada de **compensação física GNOME-only**, puramente na camada de EXIBIÇÃO da extensão,
recomputada a cada relayout e **nunca** persistida de volta ao core. Vive num módulo PURO e testável
(`platform-linux-gnome/extension/src/rigid-compensation.ts`, sem `gi://`, espelho de `bridge.ts`),
chamado em `_relayout` logo após `parseLayout`, ANTES da assinatura de dedup e do laço de aplicação. O
core, o daemon e o KDE não são tocados; a árvore lógica (`_trees`) segue crua (o core nunca vê a
geometria compensada). Como GJS + `move_resize_frame` bastam, NÃO foi criado o "addon Rust de escape"
que a diretiva autorizava como plano B.

### A) Fase I — Trava no mínimo (anti-float/anti-oscilação)

Nenhuma janela rígida recebe rect menor que seu `min_width`/`min_height`; se o slot do core for menor,
trava no mínimo EXATO em px e desloca o rect para DENTRO da work area (recupera a margem externa). É o
que impede o cliente Wayland de rejeitar o `move_resize_frame` e deixar a janela flutuar/oscilar. Se o
mínimo for maior que o monitor, clampa ao monitor (limitação de hardware).

### B) Fase II — Reabsorção de gaps e sobrevivência do grid (anti-quebra/anti-sobreposição)

Ordem estrita de política, por eixo (X e Y independentes), por monitor: (1) recuperar o **gap interno**
entre a rígida e o vizinho (a rígida cresce para dentro do gap antes de contar sobreposição); (2)
recuperar a **margem externa**; (3) **encolher o vizinho** de menor prioridade (rígida > flexível;
empate pelo índice de entrada), preservando a borda distante — nenhum overlap novo é criado; (4) último
recurso: **truncamento de borda limitado** no vizinho (overflow de hardware, ex.: duas rígidas somam
mais que a tela) — a rígida vencedora NUNCA é truncada; o impacto físico é absorvido só na exibição do
vizinho. **Nunca** reintroduz auto-agrupamento.

Invariantes de saída: todo rect rígido ≥ seu mínimo; nada fora da work area; sobreposição eliminada ou
reduzida a truncamento de borda; **determinístico** (mesma entrada → mesma saída, com arredondamento a
inteiro) — condição para o dedup por assinatura da ponte não oscilar e o loop do 0040 fechar.

### C) Toggle GNOME-only (válvula de segurança)

Chave GSettings `rigid-compensation` (boolean, default ligado) no schema da EXTENSÃO — **não** na config
do daemon (compartilhada com o KDE), preservando o isolamento. Exposta como switch no indicador e via
`gsettings`/dconf; `changed::rigid-compensation` reflete o estado e re-tila. Desligar reproduz o
comportamento anterior do compositor.

### D) Aquisição robusta do min-size — min OBSERVADO (aprendido pela recusa do cliente)

A compensação só age quando conhece o mínimo da janela. Em alguns Mutter/Wayland,
`Meta.Window.get_min_size()` degrada para `(0,0)` mesmo com a janela visível e rígida — o `mins` chega
vazio e a compensação (e o toggle) viram **no-op silencioso** (o comportamento reportado como "toggle
inoperante"). Como o cliente Wayland **recusa encolher abaixo do seu mínimo**, aprendemos o piso
empiricamente: a cada relayout comparamos o rect que committamos no ciclo anterior (`_lastAppliedRects`)
com o frame assentado (`get_frame_rect`); se a janela realizou nosso `move_resize_frame` (posição
ancorada, `±2px`) mas ficou **maior** num eixo, aquele tamanho é um piso do mínimo (`learnObservedMin`,
helper PURO em `bridge.ts`). O `mins` da compensação passa a usar `max(get_min_size, min_observado)`
(`mergeMin`) — **aditivo**: funciona quer o método real degrade, quer devolva o valor verdadeiro. O
aprendizado roda SEMPRE (mesmo com o toggle desligado, que pede o rect cru e serve de sonda para a
auto-correção de baixa), é monotonic-max com correção limitada (ponto-fixo → o dedup de `layoutSig` não
oscila), e pula maximizada/fullscreen/minimizada e o alvo de resize/arraste. Memoizado por id
(`_observedMins`), ao lado de `_lastMinSizes`.

## Consequências

- **Comportamento:** apps de min-size rígido no GNOME não flutuam, não oscilam e não quebram o grid;
  cabem no mínimo com gaps/vizinhos comprimidos. Overflow de hardware degrada para truncamento de borda
  no vizinho (escolha consciente sobre voltar a oscilar ou agrupar).
- **Reafirma 0002/0016:** o core segue decidindo a geometria lógica (esmagamento impositivo intacto); a
  compensação é APLICAÇÃO de exibição na camada nativa GNOME, não decisão de layout. O daemon e o KDE
  não sabem que ela existe.
- **KDE intocado:** o comportamento elástico nativo do KWin permanece; a correção é 100% GNOME.
- **Contrato D-Bus inalterado:** nenhum campo/DTO muda; o core recebe sempre a árvore crua. O toggle vive
  no GSettings da extensão, fora do contrato do daemon.
- **Limitações conhecidas:** overflow de hardware (mínimos somam mais que a tela) gera truncamento de
  borda no vizinho; min-size negociado tarde no Wayland (ou `get_min_size()` degradado para `(0,0)`, ver
  **D**) gera **um** frame de atraso na primeira aparição da janela rígida até a recusa ser observada e o
  `size-changed` re-tilar com o mínimo aprendido (a memoização de `_observedMins`/`effectiveMinSize`
  estabiliza os ciclos seguintes).
- **Preserva:** esmagamento cooperativo de min-size ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)),
  min-size real nas pontes ([0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)), dedup gated por
  realização + boot settle ([0038](0038-realizacao-gated-dedup-e-boot-settle.md)).
- **Testes:** vitest do módulo puro (`rigid-compensation.test.ts`): sem rígida = no-op; trava no mínimo
  recuperando gap; encolhe vizinho flexível; duas rígidas → truncamento da segunda; nada fora da work
  area; eixos X/Y independentes; idempotência/determinismo; multi-monitor isolado; min > tela. O efeito
  visual (Calculadora/GNOME Settings/lojas sem flutuar, oscilar ou sobrepor) é validado em **sessão
  real** no GNOME (padrão dos ADRs 0038-0047).
- **Fora do escopo:** `platform-macos` (Swift); KDE/KWin (comportamento nativo preservado); qualquer
  mudança no core ou no daemon.
