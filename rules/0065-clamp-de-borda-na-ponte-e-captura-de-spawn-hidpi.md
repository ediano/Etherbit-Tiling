# 0065 — Travamento de borda por clamp na ponte (GNOME), captura imperativa de spawn e drop overlay nítido no HiDPI (KDE)

**Status:** ✅ Aceita
(emenda [0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md) — o "clamp de apply à
work-area na ponte" que a 0064 **presumia existir** é de fato **implementado** aqui, fechando a ejeção/
transbordo entre monitores no GNOME; reafirma [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)
— o esmagamento impositivo do render segue **inalterado**, o transbordo compensatório passa a ser aparado
na exibição do GNOME sem tocar o core; emenda [0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md)
— a captura de spawn maximizado deixa de depender só do teste geométrico frágil e ganha um caminho
**imperativo** + folga sensível à escala; estende [0039](0039-kde-abas-visuais-no-helper-de-overlay.md)/
[0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md) — o indicador de drop do helper
declara `set_buffer_scale` por output; reafirma [0002](0002-arquitetura-core-agnostico.md)/
[0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md) — tudo agnóstico, derivado da
`WorkArea`/escala **em tempo real**, sem hardcode de resolução)

## Contexto

Uma diretiva de refinamento reportou a **recorrência** em hardware real (multi-monitor assimétrico: 4K
primário com escala fracionária + Full HD secundário @1.0) dos quatro sintomas que a 0064 já pretendia
fechar. A varredura forense — e, no caso do overlap, a **reprodução empírica no core** — reduziu cada um
a uma causa-raiz precisa, mostrando que dois deles ficaram **incompletos** e um repousava sobre um
**pressuposto falso** do plano original.

1. **GNOME — ejeção/transbordo entre monitores no resize/relayout.** A 0064 tornou o `adjust_ratio`
   min-aware (trava o vizinho no seu min real), mas isso só protege quando a janela reporta min-size XDG;
   clientes Wayland **sem hint** caem no piso proporcional de 5% e ainda vazam. Além disso, o esmagamento
   impositivo do `solve_tracks` ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)) deixa a
   última track **transbordar a borda** (deslocamento compensatório) — e o comentário do core dizia que
   esse resíduo era "aparado na PONTE (clamp de apply à work-area)". **Esse clamp não existia:** o
   `clampGeometry` da ponte GNOME só garantia ≥1px. Sem ele, o frame transbordante é aplicado como está e
   um `get_monitor()` seguinte **reatribui** a janela ao display vizinho. O KWin não sofre disso porque
   **clampa o frame à tela nativamente**.

2. **GNOME — "sobreposição vertical no descarte" NÃO é geometria do core.** O plano inicial atribuía o
   overlap a um `collapse_leaf` que preservaria tracks obsoletas. A investigação mostrou que os grids do
   core são **estritamente binários e aninhados** (`split_h`/`split_v`), e o colapso já faz o **irmão
   subir** preenchendo o slot — **sem overlap**. Um teste de regressão dedicado
   (`discard_central_de_pilha_assimetrica_nao_sobrepoe`) reproduz a "coluna de 3 ao lado de 2", fecha o
   nó central e a âncora de um stack, e prova geometria limpa (`assert_no_overlap`) em ambos. Logo, um
   `repack_grid` no core seria **código morto**. O overlap relatado em hardware é (i) o **transbordo
   cross-monitor** do item 1 (agora contido pelo clamp da ponte) e/ou (ii) um **build desatualizado**
   anterior à barreira síncrona da [0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md).

3. **KDE — janela nascida maximizada evade o tiling só no 4K.** `isMaximized` comparava
   `frameGeometry` × `MaximizeArea` com tolerância fixa de **±1 px lógico**. Sob escala fracionária no
   4K, o KWin arredonda as coordenadas lógicas ao grid de pixels **físicos**, então um quadro cheio
   diverge > 1px lógico → `isMaximized` dá **falso-negativo** → nem a captura agressiva do apply nem o
   `spawnUnmaximizeIfBorn` desmaximizam → a janela (Konsole/System Monitor) fica maximizada, fora do
   grid. No Full HD @1.0 os valores são inteiros exatos, por isso só o primário falha. O ciclo
   maximizar/restaurar "acorda" porque `maximizedChanged` alimenta `maximizedIds` por **estado**, não por
   geometria.

4. **KDE — drop overlay no 4K.** A "animação expansiva" que sugeria agrupar quadrantes vizinhos era o
   **outline nativo do KWin**, já removido pela [0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md)
   (se persiste, é build desatualizado). O resíduo **agnóstico** é que o helper `etherbit-tiling-preview`
   nunca declarava `set_buffer_scale`: a `LayerSurface` era dimensionada só em px lógicos, então no output
   HiDPI o retângulo saía **borrado/aparência expandida** — embora sua **extensão** (o `hot.outline`
   resolvido no core/ponte) já fosse estritamente a do quadrante.

## Decisão

### A) Ponte GNOME — clamp de apply à `WorkArea` (paridade de borda com o KWin)

Novo helper puro `clampToWorkArea(cmd, monitor)` na ponte (`bridge.ts`): contém o rect **dentro** da
work-area do monitor-alvo por **shrink-to-fit** — a origem sobe para ≥ origem útil e `width`/`height`
**encolhem** para não cruzar a borda útil, nunca empurrando a origem "para trás" (o que sobreporia a
vizinha na over-subscrição). O `_relayout` coleta os monitores **uma vez** (reuso no `SyncWindows` e no
clamp), mapeia cada janela ao monitor do seu **snapshot** (o core agrupa por `(monitor, workspace)`, então
é o alvo correto) e aplica `clampToWorkArea` antes do `move_resize_frame`; o `_lastAppliedRects` grava o
rect **já clampado**.

Isto **difere** do clamp no CORE que a [0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md)
rejeitou (ver seu "Rejeitado"): lá, clampar tamanho/origem entregava sub-min → recusa do cliente Wayland →
**busy-loop**, ou reintroduzia overlap. Aqui, na **ponte**, a árvore e o min-exato do core ficam
**intactos** e o dedup compara o rect já clampado — se o cliente recusar o sub-min transitório, a
assinatura não muda e **não há loop**. O shrink-to-fit (encolhe, não desloca a origem) não reintroduz
overlap na over-subscrição genuína. Agnóstico: a `WorkArea` vem viva de `getWorkAreaForMonitor`.

### B) Core — nada a mudar; teste de regressão trava a invariante

Adicionado `discard_central_de_pilha_assimetrica_nao_sobrepoe` (prova que o descarte em pilha assimétrica
e a remoção de âncora de stack não sobrepõem). **Nenhuma** lógica de `repack_grid` — seria código morto
(grids binários, irmão sobe no colapso).

### C) Ponte KDE — captura imperativa de spawn + `isMaximized` sensível à escala

- **`maximizeEpsilonForScale(scale)`** (puro, em `bridge.ts`): folga = `max(2, ceil(scale))` px lógicos —
  escala com o fator do output e fica bem abaixo do menor gap do tiling (≥ 8px), então não reintroduz
  falso-positivo. `isMaximized` lê a escala via `win.output.scale` (defensivo → 1) e usa essa folga:
  corrige o falso-negativo no 4K para **ambos** os caminhos (captura agressiva do apply e predicado de
  spawn).
- **`forceSpawnUnmaximize(win)`**: no `windowAdded`, com o Tiling ativo e `!everTiled`, chama
  `setMaximize(false, false)` **incondicionalmente** (no-op se não estiver maximizada), sem depender do
  teste geométrico. É a "força antes de registrar" que a diretiva pede; o `spawnUnmaximizeIfBorn` (via
  predicado) segue como rede para apps de restore lento. Unmaximize Recovery intacto (só age em janela
  nunca tilada).

### D) Helper KDE `etherbit-tiling-preview` — `set_buffer_scale` por output

`apply_preview` lê a escala inteira do output-alvo (`OutputInfo::scale_factor`, mesmo caminho de
`output_at`/`logical_*` da [0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md)), declara
`wl_surface().set_buffer_scale(scale)` e `draw_preview` aloca o buffer SHM em px **físicos**
(`w*scale × h*scale`, `damage_buffer` em coordenadas de buffer). O `set_size` segue em px lógicos, então a
**extensão** do indicador **não muda** (nunca invade o quadrante vizinho) — só a **nitidez** melhora no
4K. A lógica de drop (`resolveHotZone`/`localHotZone`/`MoveWindow`) é intacta.

## Rejeitado — `repack_grid` no core

O plano inicial previa re-empacotar/renormalizar tracks no `collapse_leaf`/`detach_window`. Rejeitado por
ser **desnecessário**: a reprodução empírica prova que o colapso de grid binário já sobe o irmão sem
overlap. Adicionar o helper introduziria caminho morto e risco de regressão em invariantes testadas do
[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)/[0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md).

## Consequências

- **Fim da ejeção/transbordo entre monitores no GNOME** para qualquer janela (com ou sem hint de min),
  agnóstico, sem tocar o core; costura preservada.
- **Overlap pós-descarte** endereçado na raiz correta (contenção na ponte + barreira síncrona da 0064);
  invariante do core travada por teste.
- **Spawn maximizado capturado imediatamente no 4K** (Konsole/System Monitor), sem ciclo manual; FHD sem
  regressão; Unmaximize Recovery preservado.
- **Indicador de drop nítido e pixel-exato no HiDPI**, contido no quadrante; sem animação fantasma (já
  removida na 0064).
- **Contrato D-Bus estável** (nenhuma assinatura nova; o clamp e a escala são locais às pontes/helper).
- **Testes:** core — `discard_central_de_pilha_assimetrica_nao_sobrepoe`; ponte GNOME —
  `clampToWorkArea` (contido, shrink à direita/baixo, origem em monitor deslocado, degenerado ≥1px);
  ponte KDE — `maximizeEpsilonForScale` (escala 1/fracionária/inválida). O clamp de apply, a
  desmaximização imperativa e o buffer scale do helper são validados em sessão real (hardware).
- **Nota operacional:** revalidar o `dist-release`/bundle empacotado contra o branch antes de diagnosticar
  regressão de hardware — sintomas 2 e 4 podem ser resíduo de build anterior à 0064
  ([0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md)/[0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md) já alertavam).
- **String na fronteira:** o adendo consultivo (int32/int64 / geometria como String) segue **dispensado**
  ([0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)): as raízes aqui são
  semântica de clamp e escala, não precisão numérica. String permanece só para **IDs**
  ([0009](0009-nomenclatura-dbus-uuid.md)).
