# 0066 — Clamp de borda no KDE, drop overlay contido ao quadrante, desagrupamento proporcional e barreira atômica de descarte

**Status:** ✅ Aceita
(estende [0065](0065-clamp-de-borda-na-ponte-e-captura-de-spawn-hidpi.md) — o `clampToWorkArea`
shrink-to-fit implementado na ponte GNOME é **portado para a ponte KDE** (paridade de borda no spawn) e
completa o diagnóstico da "drawdown expansiva" do KDE como o **nosso próprio preview global**, não o
outline nativo; emenda [0045](0045-desagrupar-reancora-no-lugar.md) — o ramo **global** do
desagrupamento por arraste deixa de tomar 50% do workspace e roteia pela zona `eject` (reinserção
cíclica proporcional), simetricamente em GNOME e KDE; estende [0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md)
— a trava de borda rígida do GNOME no resize interativo ganha guarda explícita por `_resizeStart`
(paridade com o KDE, que só re-tila em `interactiveMoveResizeFinished`); estende
[0062](0062-abas-kde-ciclo-de-vida-do-helper-e-salvaguardas-de-descarte-gnome.md)/[0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md)
— o descarte síncrono do GNOME passa a excluir a janela em fechamento por **id explícito**
(`_closingIds`), não só por liveness do ator; reafirma [0002](0002-arquitetura-core-agnostico.md)/
[0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md) — tudo agnóstico, derivado da
work-area/escala **em tempo real** do compositor, sem hardcode de resolução; **contrato D-Bus e core
inalterados**)

## Contexto

Uma diretiva unificada reportou, em instalações físicas limpas com **múltiplos monitores de tamanhos,
proporções, resoluções e escalas totalmente diferentes**, cinco sintomas — dois no KDE e três no GNOME.
A varredura forense dos logs de ambos os ambientes e a leitura cruzada com o código reduziram cada um a
uma causa-raiz precisa. Os logs em si não continham crash de layout nem erro FFI/D-Bus (só ruído de
portal geolocation e o filtro `non_maximizable` operando); as causas estavam na **semântica** das pontes.

1. **KDE — vazamento de borda EXCLUSIVO no spawn do monitor primário.** Ao abrir apps nativamente
   (Konsole/System Monitor) com foco no primário, as janelas expandiam **além da borda direita útil** e
   ficavam invisíveis/inacessíveis. Arrastar do secundário para o primário **não** reproduzia. A ponte KDE
   aplicava o retângulo do core **cru** (`win.frameGeometry = command`), confiando no clamp **nativo** do
   KWin — que contém à **tela**, mas não à `MaximizeArea` (não desconta painéis). O resíduo do esmagamento
   impositivo ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)) transborda a borda **útil** no
   spawn saturado do primário (escala fracionária), e o clamp nativo não segura. É exatamente o resíduo que
   a [0065](0065-clamp-de-borda-na-ponte-e-captura-de-spawn-hidpi.md) fechou no GNOME e **presumiu** para o
   KDE.

2. **KDE — "animação de drawdown expansiva" no drop overlay.** Ao arrastar, o indicador sugeria
   visualmente que agruparia quadrantes vizinhos; no drop a lógica agrupava só o alvo correto (ajuste
   **estritamente visual**). O outline nativo do KWin já fora removido ([0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md))
   e o helper desenha um retângulo **estático**. A fonte residual é o **nosso próprio preview global**: em
   `onMoveStep`, quando o cursor cruza um **gap** de um workspace populado, `windowUnderPointObj` devolve
   `null` → `resolveHotZone` cai em `globalHotZone` → bloco de **50%/monitor inteiro** piscando sobre os
   vizinhos. No drop o cursor final cai sobre uma janela → zona local → agrupa só o quadrante.

3. **GNOME — desagrupamento assume 50% da tela (grids densos).** Ao arrastar uma aba para fora de um
   agrupamento num grid de até 16 janelas, a desacoplada tomava **50% do workspace imperativamente**,
   esmagando as demais. Em `_ejectTabAt`, sem janela sob o cursor (gap), o escopo é `global` e o
   `MoveWindow` global faz `make_split(…, 0.5, …)` no core → 50% de TODO o workspace. O caminho `eject`
   (`detach_window` + reconcile/`insert_cyclic`) já reduz proporcionalmente e dá 50/50 no caso legítimo de
   2 janelas. O mesmo defeito existia no KDE (`dropEjectedAt`, ramo global).

4. **GNOME — resize de borda deforma/oscila (vs. KDE rígido).** A diretiva pede que o GNOME **barre/trave
   rigidamente** o redimensionamento na borda interna, idêntico ao KDE. O núcleo disso já existia: o
   `adjust_ratio` min-aware ([0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md)) trava o
   vizinho no seu min real e o `clampToWorkArea` ([0065](0065-clamp-de-borda-na-ponte-e-captura-de-spawn-hidpi.md))
   impede a migração de monitor — **ambos compartilhados com o KDE** (mesmo core). A diferença de
   comportamento vinha do risco de um relayout **no meio** do resize interativo (o `size-changed`, sem
   latch, reagenda `_relayout`), que reaplicaria a geometria antiga e brigaria com o cursor. O KDE não
   sofre porque só re-tila em `interactiveMoveResizeFinished`.

5. **GNOME — sobreposição vertical pós-descarte.** Em grids assimétricos, ao fechar a janela central de
   uma pilha vertical, ela perdia a âncora e sobrepunha a inferior. O core é **provadamente correto** (teste
   `discard_central_de_pilha_assimetrica_nao_sobrepoe`, [0065](0065-clamp-de-borda-na-ponte-e-captura-de-spawn-hidpi.md)):
   grids binários, irmão sobe no colapso, snap por aresta sem overlap. A causa é **timing na ponte**: no
   `unmanaged`, o ator da janela que fecha **pode ainda não estar destruído**, então `_isWindowLive`
   retorna `true`, a janela morta entra no snapshot síncrono, o core recebe a topologia **antiga** e a
   sobrevivente inferior é selada sobreposta no mesmo frame.

**Nota transversal (agnóstico):** toda a geometria de monitor já vem viva do compositor por output
(`getWorkAreaForMonitor` no GNOME, `clientArea(MaximizeArea, output, …)` no KDE) e a escala HiDPI é
resolvida nas pontes. Nenhuma correção introduz constante de resolução/escala/proporção.

## Decisão

### A) Ponte KDE — `clampToWorkArea` no apply (paridade de borda com o GNOME)

Novo helper puro `clampToWorkArea(cmd, area)` em `platform-linux-kde/.../bridge.ts` — espelho byte-a-byte
do GNOME ([0065](0065-clamp-de-borda-na-ponte-e-captura-de-spawn-hidpi.md)): shrink-to-fit (origem sobe
para ≥ origem útil; `width`/`height` encolhem para não cruzar a borda útil; nunca empurra a origem para
trás; piso ≥1px). No callback de `SyncWindows`, o snapshot de monitores é coletado **uma vez** (reuso na
serialização e no clamp); cada janela é mapeada à work-area do seu output (`outputs.indexOf(win.output)`) e
`clampToWorkArea` é aplicado **dentro do `if (!skip)`** — janela maximizada por ação do usuário
(`maximizedIds`) nunca é clampada (Unmaximize Recovery intacto). Só o apply geral muda; o `windowAdded`
não escreve frame. A árvore/dedup usam o rect já clampado, então o sub-min transitório recusado pelo
cliente Wayland **não gera busy-loop** (mesma garantia da 0065 no GNOME).

### B) Ponte KDE — gating do preview global (overlay contido ao quadrante)

Predicado puro `shouldPaintGlobalPreview(scope, populated)` em `bridge.ts` (`false` só quando
`scope === 'global' && populated`) e helper `groupPopulatedUnder(x, y)` em `main.ts` (conta janelas
normais vivas do grupo `(monitor sob o cursor, desktop atual)`, excluindo a arrastada, via `clientArea` e
identidade por nome de conector — agnóstico). Em `onMoveStep`, o preview é **suprimido** (passa `null` a
`updateOutline`) quando resolveria o bloco global num workspace populado. O preview **local** (quadrante do
alvo) é sempre pintado; o global legítimo (workspace vazio, primeira janela) é preservado. `onMoveFinish`/
`dropEjectedAt` **não mudam** — o drop segue idêntico (ajuste puramente visual).

### C) Pontes GNOME e KDE — desagrupamento sobre gap roteia por `eject` (nunca 50%)

- **GNOME** (`_ejectTabAt`): após `removeIdFromStacks`, se `hot.scope === 'global'` → `_ejectFromStack`
  (zona `eject`), antes do `MoveWindow` local. Toda ejeção sobre gap reancora no lugar + reinsere
  ciclicamente ([0045](0045-desagrupar-reancora-no-lugar.md)).
- **KDE** (`dropEjectedAt`): o ramo `hot.scope === 'global'` passa a **`return false`** — `finishUngroup`
  cascata para `ejectFromStack` (zona `eject`).

O ramo **global** do core `move_window` (`make_split` 0.5) **permanece** — segue válido para **mover** uma
janela não-membro ao gap (drag-to-tile em `_onGrabEnd`/`onMoveFinish`). Só o **roteamento do
desagrupamento** muda, nas pontes. A reinserção cíclica reduz proporcionalmente num grid denso **e** dá
50/50 no caso de 2 janelas (coberto por `move_window_eject_dissolve_stack_de_dois` /
`reconcile_apos_eject_reancora…`). **Core intacto.**

### D) Ponte GNOME — trava de borda rígida no resize interativo

`_scheduleRelayout` ganha guarda explícita: enquanto um grab de resize está ativo (`_resizeStart != null`),
o trigger vira `_relayoutPending` (não relayouta). O `_resizeStart` é zerado no `grab-op-end` **antes** de
liberar a supressão, então o único relayout do resize é o pós-`_applyResize` (borda materializada uma vez,
min-aware). Complementa o `_suppressRelayout` já existente: torna a invariante "sem relayout durante o
resize" explícita e imune a uma liberação de supressão em corrida — paridade com o KDE, que só re-tila em
`interactiveMoveResizeFinished`. Resizes **não-interativos** (negociação de min XDG pós-spawn,
[0038](0038-negociacao-de-min-size-por-realizacao-gnome.md)) são preservados (a guarda só age durante o
grab).

### E) Ponte GNOME — barreira atômica de descarte por id explícito (`_closingIds`)

Novo `_closingIds: Set<number>`. No `unmanaged`, o id é registrado **antes** do relayout síncrono; no
snapshot do `_relayout`, a janela é pulada por `_closingIds.has(id) || !_isWindowLive(window)`; o set é
consumido (zerado) após a construção do snapshot. Assim a passada corretiva vê **apenas sobreviventes**,
independente do timing de destruição do ator — inclusive no caminho adiado sob supressão (o set persiste
até um `_relayout` efetivo). Fecha a corrida que a barreira síncrona da 0064 deixava aberta.

## Rejeitado

- **Mudar o ramo global do core `move_window` (item C).** Removeria o gesto legítimo de drag-to-tile de
  janela não-membro ao gap (50%) e quebraria testes do core. O fix correto é de **roteamento nas pontes**.
- **Guarda de resize redundante sem valor (item D).** Considerou-se não adicionar a guarda por o
  `_suppressRelayout` já cobrir o caminho comum; mantida como hardening barato e explícito da rigidez de
  borda, com escopo estrito ao grab (nulo fora dele).
- **`repack_grid`/mudança de snap no core (item E).** O core está provado correto por teste; a causa é
  timing de ponte. Reafirma a rejeição da [0065](0065-clamp-de-borda-na-ponte-e-captura-de-spawn-hidpi.md).

## Consequências

- **Contenção absoluta no KDE desde o spawn** em qualquer monitor (paridade com o GNOME), sem hardcode; o
  resíduo do esmagamento impositivo é aparado só na exibição, core intacto.
- **Drop overlay do KDE contido ao quadrante** (sem o bloco global piscando sobre vizinhos); drop
  inalterado; global legítimo preservado em workspace vazio.
- **Desagrupamento proporcional** em grids densos (sem esmagar a 50%), 50/50 preservado no caso de 2
  janelas, simétrico GNOME⇄KDE.
- **Resize do GNOME rígido na borda interna** como o KDE (sem deformar/oscilar nem migrar de monitor).
- **Fim da sobreposição vertical pós-descarte** por exclusão determinística da janela em fechamento.
- **Contrato D-Bus e core estáveis** (nenhuma assinatura nova; toda a mudança é local às pontes).
- **Testes:** ponte KDE — `clampToWorkArea` (contido, shrink à direita/baixo, origem em monitor deslocado,
  degenerado ≥1px) e `shouldPaintGlobalPreview` (local sempre; global suprimido só em populado); core e
  ponte GNOME sem regressão (100 / 85 testes verdes). O clamp de apply, o gating de preview/resize e a
  barreira `_closingIds` são validados em sessão real (hardware multitela).
- **Nota operacional:** o efeito nativo de quick-tile/electric-border do KWin (`kwinrc [Windows]
ElectricBorderTiling`) pode disparar sua própria animação num arraste de barra de título — um KWin Script
  não o desliga com robustez; recomenda-se desabilitá-lo enquanto o Etherbit gerencia o tiling. O fix (B)
  cobre a fonte que está sob nosso controle.
- **String na fronteira:** o adendo consultivo int32/int64/geometria-como-String segue **dispensado**
  ([0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)); as raízes aqui são
  semântica de clamp, roteamento e timing, não precisão numérica. String permanece só para **IDs**
  ([0009](0009-nomenclatura-dbus-uuid.md)).
