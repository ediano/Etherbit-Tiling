# 0050 — Unificação barra/janela por slot compensado em grupos de abas (GNOME-only)

**Status:** 🔄 Revogada por [#0052](0052-rollback-compensacao-rigida-e-spawn-merge-gnome.md) — a
unificação barra/janela por slot compensado foi REMOVIDA com o restante da compensação GNOME
(rollback estratégico por instabilidade do grid). O corpo abaixo permanece como histórico.

(originalmente ✅ Aceita; emenda [0048](0048-compensacao-fisica-min-size-gnome.md) — a compensação física passa a tratar cada grupo
de abas como um **slot único** (`bar ∪ content`), de modo que a barra de abas e a janela ativa derivem da
**mesma** geometria compensada; e estende a soberania de min-size do core
[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)/`build_min_sizes` à camada de EXIBIÇÃO do
GNOME, onde o `get_min_size()` do Mutter pode degradar. O esmagamento impositivo do core e o `gap`
inviolável de [0049](0049-gaps-inviolaveis-e-spawn-time-merge.md) seguem **intactos**. Reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md): toda a
lógica é da camada nativa GNOME; core, daemon, KDE e contrato D-Bus inalterados.)

## Contexto

Testes em sessão expuseram duas anomalias correlacionadas, **exclusivas dos grupos de abas no GNOME** (o
KDE, com KWin elástico nativo, não as tem) — ambas na camada de EXIBIÇÃO da extensão, não no cálculo do
core:

1. **Dessincronização de resize (barra vs janela).** Ao redimensionar (uma janela vizinha que comprime um
   grupo, ou o próprio grupo), a **barra de abas** se reajustava ao novo tamanho, mas a **janela do app
   ativo** permanecia congelada — as duas divergiam. Raiz: no `_relayout`, só os rects das **janelas**
   passavam pela compensação física ([0048](0048-compensacao-fisica-min-size-gnome.md),
   `rigid-compensation.ts`); a barra era desenhada a partir da geometria **crua** do core
   (`_rebuildTabBars(tabBars, …)`). Fontes distintas (compensada vs crua) → divergência sempre que a
   compensação deslocava/redimensionava a aba ativa.
2. **Recorte (clipping) por violação de min-size no grupo.** Uma janela rígida entrando num grupo cuja
   célula era menor que seu mínimo sofria corte visual em vez de a célula expandir. O core **já** agrega
   `MAX(min de todos os membros) + group_header_px` na âncora do stack (`build_min_sizes`), mas só com os
   mínimos que RECEBE: o `get_min_size()` do Mutter degrada para `(0,0)` em alguns compositores/Wayland
   **mesmo com a janela visível** ([0048-D](0048-compensacao-fisica-min-size-gnome.md)), e o piso
   APRENDIDO (`_observedMins`) vive só no GNOME — nunca chega ao core. Nesses casos o core subestima a
   célula e a compensação (que conhece o `observed`) travava só a **aba ativa** no min DELA, não no `MAX`
   do grupo.

## Decisão

Uma única mudança geométrica, 100% na extensão GNOME. Não toca o core, o daemon, o KDE nem o contrato
D-Bus. A camada de exibição GNOME passa a ser a **fonte única da verdade** para grupos de abas.

### Regra — Compensação por SLOT (`rigid-compensation.ts` + `extension.ts`)

O core confirma que, para um stack, `slot = bar ∪ content = srect` é **exato** (`render_stack`): a barra é
a faixa `group_header_px` no topo, o content é o resto — mesmos `x`/`width`. Logo o fatiamento é reversível
sem perda. A compensação passa a operar sobre o **slot**, não sobre o content isolado:

- **Expansão.** Antes de compensar, cada aba ativa (o único `WindowRect` que o core emite para um stack)
  é expandida in-place ao seu slot (`srect`). Janelas soltas entram como estão.
- **Soberania na EXIBIÇÃO.** O `mins` do slot é o agregado do grupo: `MAX(min efetivo de TODOS os
membros)`, com a faixa da barra embutida na altura (`MAX(minH) + barHeight`). O min efetivo por membro é
  o `_effectiveMin` ([0048-D](0048-compensacao-fisica-min-size-gnome.md), `raw ⊔ observed`), então a célula
  expande mesmo quando o `get_min_size()` degradou e o core subestimou — inclusive por causa de um membro
  **inativo** (minimizado) com mínimo maior que o da aba visível.
- **Empuxo reusado.** A mesma `compensateAxis` (Fase I trava o slot no min agregado respeitando o `gap`
  externo; Fase II empurra os quadrantes vizinhos de menor prioridade preservando o `gap` interno) roda
  sobre `{slots + janelas soltas}` — **zero código novo de empuxo**. A [0049](0049-gaps-inviolaveis-e-spawn-time-merge.md)
  segue valendo (gap inviolável; só cede por último em overflow real de hardware).
- **Fatiamento.** Cada slot compensado é refatiado de volta: a **barra** é a faixa `barHeight` no topo; o
  **content** é o resto, abaixo dela. O content vira o rect aplicado à janela ativa (`move_resize_frame`);
  a barra é desenhada dessa faixa. Barra e janela vêm do MESMO slot → sincronizadas por construção. Clamp
  de hardware: se o slot ficar menor que a faixa, a barra encolhe (espelha `bar_h.min(srect.h)` do core) e
  o content nunca fica `< 1px`.

A ponte usa essas barras compensadas em `_rebuildTabBars`, no `_collectGroupTiled` e na assinatura de dedup
`layoutSig` (commands e barras arredondados para inteiro → determinístico, o dedup não oscila).
`_tabBarRects` (base do drag-to-ungroup, [0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md)/[0047](0047-desagrupar-por-arraste-pela-barra-de-titulo.md))
passa a refletir a barra REAL na tela, de graça.

### Caminho do toggle desligado

Com o toggle `rigid-compensation` ([0048-C](0048-compensacao-fisica-min-size-gnome.md)) OFF, a ponte usa os
commands e as barras CRUS do core — que já concordam entre si (saem do mesmo `srect`). A dessincronização
existia **por causa** da compensação deslocar só a janela; sem ela, não há divergência. A unificação vale
sem código extra no caminho OFF.

## Consequências

- **Comportamento:** ao redimensionar qualquer quadrante, a barra de abas e a janela do app ativo do grupo
  encolhem/expandem/deslocam de forma síncrona; uma janela rígida agrupada numa célula apertada nunca é
  cortada — o grupo expande até o maior mínimo do grupo e empurra os quadrantes vizinhos para abrir o
  espaço físico exato.
- **Reafirma 0002/0016:** o core segue decidindo a geometria lógica (esmagamento impositivo e agregação de
  min na âncora intactos); esta é aplicação de EXIBIÇÃO, recomputada a cada relayout e NUNCA persistida de
  volta ao core (a árvore `_trees` permanece crua). Daemon e KDE não sabem que existe.
- **KDE intocado:** comportamento elástico nativo do KWin preservado; a regra é 100% GNOME.
- **Contrato D-Bus inalterado:** nenhum campo/DTO muda; a lógica vive na ponte, atrás do toggle GSettings
  `rigid-compensation` já existente.
- **Alternativa descartada:** enviar o min OBSERVADO ao core (via `WindowInfo`/`build_min_sizes`)
  resolveria a soberania na origem, mas o campo é **compartilhado com o KDE** pelo daemon — injetar um piso
  aprendido só-GNOME arriscaria regredir o Plasma (elástico nativo, sem a degradação `get_min_size()→(0,0)`).
  A unificação no slot resolve os dois sintomas sem tocar o core.
- **Limitações conhecidas:** um membro que **nunca** foi ativo desde o enable não terá `observed` aprendido
  (o gate `!isMinimized` de `learnObservedMin` não roda em aba inativa); cai no `raw`/memoizado
  (`_lastMinSizes`), o melhor disponível. Uma janela rígida que o cliente Wayland recusa encolher abaixo do
  mínimo segue não encolhendo (comportamento inerente do min-size) — mas agora a barra acompanha o tamanho
  EFETIVO, sem divergência.
- **Preserva:** esmagamento impositivo ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)),
  compensação física + min observado + gaps invioláveis ([0048](0048-compensacao-fisica-min-size-gnome.md)/[0049](0049-gaps-inviolaveis-e-spawn-time-merge.md)),
  Spawn-Time Merge preventivo ([0049](0049-gaps-inviolaveis-e-spawn-time-merge.md)), agrupamento manual e
  drag-to-ungroup ([0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)/[0047](0047-desagrupar-por-arraste-pela-barra-de-titulo.md)).
- **Testes:** vitest do módulo puro `rigid-compensation.test.ts` — os 13 casos de `compensateRigidWindows`
  provam a não-regressão do refator (o corpo extraído para `compensateRects`); os novos casos de
  `compensateWithStacks` cobrem soberania (`MAX` do grupo, inclusive membro inativo), altura com a faixa da
  barra, fatiamento reversível, empuxo de vizinho com gap, determinismo/ponto-fixo, multi-monitor e clamp
  de hardware com barra. A sincronização barra↔janela na tela é validada em **sessão real** no GNOME
  (padrão dos ADRs 0038-0049): apps de min-size rígido (`gnome-calculator`, `gnome-control-center`)
  agrupados numa célula estreita — sem clipping, barra colada ao app, resize síncrono; toggle
  `rigid-compensation` liga/desliga.
- **Fora do escopo:** `platform-macos` (Swift); KDE/KWin (comportamento nativo preservado); qualquer
  mudança no core ou no daemon.
