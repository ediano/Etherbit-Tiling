# 0051 — Anti-inflação do min observado: não aprender no relayout pós-gesto (GNOME-only)

**Status:** 🔄 Revogada por [#0052](0052-rollback-compensacao-rigida-e-spawn-merge-gnome.md) — o
aprendizado do min observado foi REMOVIDO junto com a compensação GNOME (rollback estratégico por
instabilidade do grid). O corpo abaixo permanece como histórico.

(originalmente ✅ Aceita; emenda [0048](0048-compensacao-fisica-min-size-gnome.md) — corrige o aprendizado do min OBSERVADO
(0048-D) para não gravar como mínimo o tamanho que o usuário escolheu num resize. Reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md): a
correção vive só na ponte GNOME; core, daemon, KDE e contrato D-Bus inalterados. O KDE não tem o
aprendizado nem a degradação `get_min_size()→(0,0)`, então não sofre o bug.)

## Contexto

Janelas rígidas (Calculadora GTK, Ubuntu Store/Flutter) tilam e comprimem corretamente num grid
50/25/25. Mas **após uma reorganização** — arrastar a divisória do grid (um resize) ou mover uma
janela — o **resize manual dessas janelas trava**: a geometria congela em coordenadas estáticas e os
quadrantes vizinhos desalinham. No KDE (mesmo core/daemon, sem a camada de exibição do GNOME) o fluxo
é liso.

A raiz está no aprendizado do min OBSERVADO (0048-D), que existe porque o `Meta.Window.get_min_size()`
degrada para `(0,0)` em alguns Mutter/Wayland: a ponte deduz o mínimo real observando o cliente
**recusar encolher** (comparando o rect que committamos, `_lastAppliedRects`, com o frame assentado).
Duas propriedades combinadas causam a falha:

1. **RAISE cego ao pedido.** `learnObservedMin` (`bridge.ts`) eleva o piso quando, num eixo,
   `settled.pos ≈ committed.pos (≤2px)` e `settled.size > committed.size` — sem checar se o
   `committed` já estava no piso. Uma janela cujo frame ficou **maior** que o rect committado,
   mantendo uma borda de âncora, grava o **tamanho do novo frame como se fosse o mínimo**.
2. **Piso monotônico-para-cima.** O DOWN-correct só é alcançável quando committamos ABAIXO do piso —
   o que a compensação física LIGADA (default, [0048](0048-compensacao-fisica-min-size-gnome.md)/[0050](0050-unificacao-barra-janela-slot-compensado-gnome.md))
   nunca faz (trava ≥ min). Logo, uma vez inflado, o piso **persiste até a janela fechar**.

**Gatilho preciso.** O aprendizado roda no INÍCIO do `_relayout`, e o gate `learnable` exclui a janela
**durante** o gesto (`_resizeStart?.id`, `_draggedId`). Mas esses campos são zerados em `_onGrabEnd`
**antes** do relayout de settle. No PRIMEIRO relayout após um resize, a janela recém-redimensionada
volta a ser "learnable" exatamente quando seu frame (aumentado pelo usuário) diverge do slot
committado antigo → RAISE do piso para o tamanho arrastado. A janela passa a ser tratada como rígida
com esse mínimo falso; a compensação a trava lá e a Fase II empurra os vizinhos → congelamento e
desalinhamento. Sequência típica: `A @ x=8 w=948` arrastada +200 → `settled x=8 w=1148` vs
`committed x=8 w=948` → `_observedMins[A] = 1148`.

Isso explica "funcionava e parou": no grid inicial ninguém foi redimensionado maior, nenhum piso
inflou; o primeiro resize/divisória infla e ativa o travamento (que some ao fechar/reabrir a janela).

## Decisão

Estender por **um relayout** a exclusão de aprendizado que já vigora durante o gesto. A ponte guarda
o id da janela cujo frame o usuário acabou de manipular (`_lastGesturedId`, setado em `_onGrabEnd`
para o alvo de resize e para o arrastado) e o exclui do `learnable` no primeiro `_relayout` seguinte
— o de settle, garantido pela supressão do grab como o primeiro após o gesto. Consumido (zerado) na
própria passada de aprendizado (one-shot); no ciclo seguinte o `committed` já reflete o slot aplicado
e o aprendizado genuíno (recusa real do cliente) volta a operar, apenas adiado um ciclo.

O único sinal que distingue uma **recusa genuína** (bootstrap legítimo do min, 0048-D) de uma
**inflação** (o usuário aumentou a janela) é **se um gesto acabou de acontecer** — ambos têm
`prev=0` e `committed>0`. Por isso a correção é **temporal na ponte**, não uma regra na função pura.

### Alternativas descartadas

- **Gate `committed ≤ piso` em `learnObservedMin`:** quebraria o bootstrap da 0048-D (min real
  aprendido a partir de um slot menor que o min tem `prev=0`, `committed>0`, indistinguível da
  inflação pela função pura) — mataria o aprendizado legítimo.
- **Invalidar `_observedMins` a cada gesto:** causaria _flicker_ (a rígida re-flutua por um frame até
  re-aprender). A prevenção na origem não tem esse custo.

## Consequências

- **Comportamento:** o resize manual permanece ativo após reorganizações sucessivas; o tamanho
  escolhido pelo usuário nunca é gravado como mínimo. Rígidas reais continuam travando no seu mínimo
  verdadeiro (correto).
- **Função pura intocada:** `learnObservedMin`/`mergeMin`/`effectiveMinSize` não mudam — o RAISE
  segue legítimo para recusas reais; muda apenas _quando_ a ponte aprende. Todos os testes existentes
  de `learnObservedMin` (bridge.test.ts) seguem verdes.
- **Agnóstico ao toolkit:** a ponte já captura estritamente `get_frame_rect()` (sem callbacks
  específicos de GTK/Flutter). A fragilidade real ligada a toolkit — o renderizador em lote do Flutter
  reportar frames transientes maiores, alimentando o RAISE falso — é neutralizada por não aprender no
  ciclo pós-gesto, sem nenhum código específico de toolkit.
- **KDE/core/daemon/D-Bus inalterados:** o KDE não tem o aprendizado nem a compensação (KWin absorve
  nativamente) e não sofre a degradação `get_min_size()→(0,0)`.
- **Limitação conhecida (não corrigida aqui):** o resize lê a geometria EXIBIDA (compensada) mas o
  core ajusta o RATIO LÓGICO da árvore; quando a compensação torna exibido ≠ lógico (rígida real em
  slot apertado), o delta é mal-escalado. Com a inflação eliminada, isso se restringe a janelas
  verdadeiramente rígidas em slots verdadeiramente apertados, onde encolher abaixo do mínimo **deve**
  ser bloqueado. Um refinamento futuro pode derivar o delta do último rect CRU memoizado.
- **Testes:** caracterização em `bridge.test.ts` (uma flexível cujo slot cresceu no mesmo anchor
  RAISE para o tamanho arrastado — documenta o hazard que a ponte evita). A ordem GJS/settle
  (`_lastGesturedId` consumido no relayout de settle) é validada em **sessão real** no GNOME (padrão
  dos ADRs 0038-0050): grid 50/25/25 com Calculadora + Ubuntu Store, arrastar a divisória para maior e
  depois menor deve encolher livremente; reorganizações sucessivas mantêm o resize ativo.
- **Fora do escopo:** `platform-macos`; KDE/KWin; core e daemon.
