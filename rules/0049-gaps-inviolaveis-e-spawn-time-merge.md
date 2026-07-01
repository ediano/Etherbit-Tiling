# 0049 — Gaps invioláveis e Spawn-Time Merge preventivo (GNOME-only)

**Status:** 🔄 Revogada por [#0052](0052-rollback-compensacao-rigida-e-spawn-merge-gnome.md) — os gaps
invioláveis e o Spawn-Time Merge (com o toggle `spawn-merge`) foram REMOVIDOS da extensão GNOME
(rollback estratégico por instabilidade do grid). O corpo abaixo permanece como histórico.

(originalmente ✅ Aceita; emenda [0048](0048-compensacao-fisica-min-size-gnome.md) — a compensação física passa a tratar o `gap`
como barreira **inviolável**, em vez de reabsorvê-lo; e reintroduz um agrupamento automático **estrito ao
spawn**, distinto do auto-agrupamento por colisão aposentado por
[0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)/[0044](0044-guard-anti-reagrupamento-desagrupar-manual.md)
e do "Merge Fallback" da ordem [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md) que a [0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)
removeu. O esmagamento impositivo do core ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md))
segue **intacto e agnóstico**. Reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md):
toda a lógica é da camada nativa GNOME; core, daemon, KDE e contrato D-Bus inalterados.)

## Contexto

Testes comparativos entre distribuições GNOME expuseram duas anomalias remanescentes da resposta elástica
sob espaço apertado — ambas na camada de EXIBIÇÃO da extensão GNOME, não no cálculo geométrico do core:

1. **Colapso de gaps.** Durante recálculos do grid, os espaçamentos entre janelas e das bordas da tela
   eram comprimidos/eliminados — janelas encostavam umas nas outras. Raiz: a compensação física de
   min-size ([0048](0048-compensacao-fisica-min-size-gnome.md), `rigid-compensation.ts`) recebia o `gap`
   como parâmetro mas **nunca o usava**: a Fase I ancorava a rígida rente à borda da work area e a Fase II
   comprimia o vizinho até **encostar** na rígida (gap interno zero). Janelas nominalmente flexíveis
   também colapsavam porque o min OBSERVADO ([0048-D](0048-compensacao-fisica-min-size-gnome.md)) lhes
   atribui um piso e as torna rígidas aos olhos da compensação.
2. **Ejeção residual para flutuante no spawn.** Janelas que nascem sem espaço físico no quadrante de
   destino (por min-size rígido) ainda flutuavam/sobrepunham em vez de se integrarem. O esmagamento
   impositivo ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)) e a compensação
   ([0048](0048-compensacao-fisica-min-size-gnome.md)) mitigam a exibição, mas há um limite físico: quando
   dois mínimos não coexistem no quadrante, comprimir vizinhos degrada para truncamento — a resposta certa
   é **não abrir o split**.

## Decisão

Duas regras, ambas 100% na extensão GNOME. Nenhuma toca o core, o daemon, o KDE ou o contrato D-Bus.

### Regra I — O gap é uma barreira física inviolável (`rigid-compensation.ts`)

O `gap` configurado (mesmo valor para margem interna e externa) passa a ser uma constante imutável nas
duas fases da compensação, em vez de espaço reabsorvível:

- **Fase I (âncora com gap externo):** ao travar uma rígida no mínimo e deslocá-la para dentro da work
  area, a âncora respeita `gap` de folga das bordas (`hi - gap`/`lo + gap`), não rente. Só reancora
  quando a rígida **transborda** os limites internos (não move quem já está confortavelmente dentro —
  preserva idempotência).
- **Fase II (gap interno cheio):** o gatilho de "ceder" dispara por **proximidade menor que `gap`** (não
  só por sobreposição); o vizinho recua deixando o `gap` inteiro entre ele e a rígida (`wHi + gap` /
  `wLo - gap`), preservando a borda distante — nenhum novo overlap é criado.
- **Degradação controlada:** em overflow REAL de hardware (dois mínimos somam mais que a tela), a rígida
  vencedora nunca é truncada; o vizinho encolhe até 1px e, **só então**, o gap efetivo cede por último
  (emergindo do `Math.max(1, …)`). É a fronteira que a Regra II existe para evitar no spawn.

Invariantes de saída preservadas ([0048](0048-compensacao-fisica-min-size-gnome.md)): toda rígida ≥ seu
mínimo; nada fora da work area; determinístico e idempotente (o dedup por `layoutSig` não oscila).

### Regra II — Spawn-Time Merge preventivo (`extension.ts` + helpers puros em `bridge.ts`)

No surgimento de uma janela, se o quadrante de destino não comporta o min-size que o app exige, agrupamos
a nova janela nas abas do RESIDENTE do quadrante em vez de abrir um split apertado:

- **Detecção geométrica (sem tocar o core).** A árvore `_trees` é opaca à ponte
  ([0026](0026-grid-fractal-3x3-elastico-e-hud.md)); a decisão é geométrica. Uma 1ª passada de `SyncWindows` dá
  o slot da nova janela; o **residente** é a janela cujo rect PRÉ-spawn (`_lastAppliedRects`, ainda
  intacto nesse ponto) a nova invadiu (maior interseção — `pickResident`). O critério de encaixe
  (`shouldMergeOnSpawn`) é ROBUSTO: agrupa quando a nova E o residente não coexistem, no eixo do split
  (lado maior do quadrante, espelhando o BSP), mantendo o gap inteiro —
  `newMin + residentMin + gap > extensão do quadrante`.
- **Síncrono, zero flutuação.** Se algo é agrupado (`addToStack`, reusado do drag-to-group manual), uma
  2ª passada de `SyncWindows` — no MESMO `_relayout`, sem paint intermediário — devolve a geometria final
  (a nova janela colapsada no slot do residente como `{stack}`). A árvore persistida é a do Pass 2, nunca
  a folha do Pass 1.
- **One-shot (o invariante central anti-re-sucção).** A decisão ocorre **uma vez por janela**
  (`_pendingSpawnEval`, consumida na avaliação) e **nunca é re-armada**. É isso que a distingue do
  auto-agrupamento por colisão aposentado pela [0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md):
  não há sinal de colisão do core, não se sequestram janelas externas (só o residente geométrico do
  quadrante), e uma janela que o usuário desagrupa manualmente depois **não é re-sugada** nos relayouts
  seguintes (o guard `_userUngrouped` da [0044](0044-guard-anti-reagrupamento-desagrupar-manual.md) fica
  desnecessário pela mesma razão de sempre: nada re-suga).

### Toggle GNOME-only (válvula de segurança)

Chave GSettings `spawn-merge` (boolean, default ligado) no schema da EXTENSÃO — **não** na config do
daemon (compartilhada com o KDE), preservando o isolamento, no mesmo padrão do
[0048-C](0048-compensacao-fisica-min-size-gnome.md). Exposta como switch no indicador e via
`gsettings`/dconf; `changed::spawn-merge` reflete o estado e re-tila. Desligar reproduz o comportamento
anterior (split apertado, tratado só pela compensação da Regra I).

## Consequências

- **Comportamento:** gaps rigorosamente idênticos, simétricos e preservados em qualquer grid apertado no
  GNOME (as janelas param antes de encostar); janelas rígidas que não caberiam no quadrante nascem já
  agrupadas em abas no residente, sem um frame de flutuação/sobreposição.
- **Reafirma 0002/0016:** o core segue decidindo a geometria (esmagamento impositivo intacto); a Regra I é
  aplicação de exibição e a Regra II reordena apenas o estado de abas da ponte (via `addToStack`), que o
  core já sabia reconciliar. Daemon e KDE não sabem que existem.
- **KDE intocado:** o comportamento elástico nativo do KWin permanece; ambas as regras são 100% GNOME.
- **Contrato D-Bus inalterado:** nenhum campo/DTO muda; os toggles vivem no GSettings da extensão.
- **Limitações conhecidas:** min-size negociado muito tarde no Wayland (depois do primeiro relayout com
  slot) cai no comportamento pós-spawn (compensação da Regra I + eventual merge manual), não no
  automático — escolha consciente para não reintroduzir a cascata de settle que a
  [0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md) matou. Overflow de hardware entre
  duas rígidas já residentes (fora do spawn) segue degradando para truncamento de borda no vizinho
  ([0048](0048-compensacao-fisica-min-size-gnome.md)).
- **Preserva:** esmagamento impositivo ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)),
  compensação física + min observado ([0048](0048-compensacao-fisica-min-size-gnome.md)), agrupamento
  manual só no centro e drag-to-ungroup ([0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)/[0047](0047-desagrupar-por-arraste-pela-barra-de-titulo.md)),
  distribuição cíclica em quadrantes ([0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)).
- **Testes:** vitest dos módulos puros — `rigid-compensation.test.ts` (Fase I preserva o gap externo ao
  reancorar; Fase II deixa o gap interno cheio; gatilho por proximidade `< gap`; gap cede por último sob
  overflow; idempotência com gap) e `bridge.test.ts` (`pickResident` por maior interseção/empate por menor
  id/sem overlap → null; `shouldMergeOnSpawn` por eixo, com o gap na conta e critério simétrico). A
  orquestração de duas passadas (GJS/D-Bus) é validada em **sessão real** no GNOME (padrão dos ADRs
  0038-0048): grid apertado com apps de min-size rígido — gaps simétricos e janela nascendo em aba; toggle
  `spawn-merge` liga/desliga; regressão anti-re-sucção (desagrupar manual permanece desagrupado).
- **Fora do escopo:** `platform-macos` (Swift); KDE/KWin (comportamento nativo preservado); qualquer
  mudança no core ou no daemon.
