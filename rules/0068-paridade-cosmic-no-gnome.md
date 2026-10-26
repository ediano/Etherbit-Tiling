# 0068 — Paridade COSMIC no GNOME: recusa de tamanho, inserção pela focada, teclado, borda ativa e monitores

**Status:** ✅ Aceita
(resolve as pendências mapeadas em [0067](0067-auditoria-gnome-timeout-dbus-adocao-e-cantos-csd.md).
Emendas:

- [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md): a distribuição cíclica deixa de ser o padrão e
  vira o modo `cyclic`; o padrão passa a ser `focus` (COSMIC).
- [0019](0019-arvore-bsp-persistente-resize-elastico.md): o gap externo pode ser independente do interno.

Estende [0016](0016-extensao-ponte-burra-render-no-daemon.md): a borda ativa passa a ser desenhada pela extensão,
que roda dentro do compositor.

Reafirma [0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md): o D-Bus continua
síncrono, mas com teto.

Contrato D-Bus **estendido de forma retrocompatível**: só campos `serde(default)` e métodos novos.)

## Contexto

A auditoria da [0067](0067-auditoria-gnome-timeout-dbus-adocao-e-cantos-csd.md) comparou o tiling do
GNOME com o do COSMIC (Pop!_OS) e listou falhas de renderização e lacunas de funcionalidade:

- **Janelas que recusam o tamanho do slot**, como terminais com _size increments_ e janelas com tamanho
  máximo, nunca convergiam. Cada gatilho (inclusive troca de foco) reaplicava `move_resize_frame`, e
  isso gerava flicker. O GJS não expõe os _size hints_ do Mutter (só `get_min_size`/`get_max_size`),
  então o core não tem como prever o tamanho aceito.
- **Inserção:** a janela nova seguia o ciclo de quadrantes, enquanto no COSMIC ela racha a janela focada.
- **Sem teclado:** não havia foco, move, swap ou resize por teclado, nem toggle de orientação, float por
  janela ou ciclo de abas.
- **Borda ativa:** a config `active_border` existia, mas nada era desenhado.
- **Gaps:** não havia smart gaps, e o gap externo não podia ser separado do interno.
- **Exceções** só por `app_id`.
- **Monitores:** o estado da ponte é indexado pelo índice posicional do monitor, então hotplug ou
  reordenação reatribuíam as árvores ao monitor errado.
- **Barras de abas** eram recriadas a cada relayout não deduplicado.

## Decisão

1. **Recusa de tamanho, tratada na ponte e de forma genérica.** Funções puras em `bridge.ts`:
   `sizeRefused`, `containedIn`, `centerInSlot`, `sameRect`.
   - `geometryConverged` passa a aceitar como convergida a janela **menor e contida** no slot pedido.
   - Se o mesmo slot já foi pedido e o cliente ficou menor, a ponte **não reenvia o resize**: só
     centraliza com `move_frame`, que não dispara `size-changed`, então não há realimentação.
   - Uma janela fora do slot (apply descartado no boot) continua **não** convergida, preservando a
     [0038](0038-realizacao-gated-dedup-e-boot-settle.md).
2. **Inserção COSMIC** (`reconcile_focused` no core, modo `insert_mode = "focus"`, que é o padrão):
   - a nova janela racha a folha da **focada anterior** no eixo maior, ficando à direita ou embaixo;
   - várias novas de uma vez formam espiral, porque cada uma herda o foco;
   - um membro de stack resolve para a âncora do stack;
   - sem foco válido (ou no bootstrap), cai no ciclo da 0030;
   - a ponte manda como `focused_id` a janela mais recente do **histórico de foco (MRU)** que já está
     no grid (`pickInsertAnchor`), porque quando o `SyncWindows` roda o GNOME já focou a janela nova;
   - `insert_mode = "cyclic"` mantém o comportamento antigo; `reconcile` não muda.
3. **Teclado.** Atalhos novos no gschema:
   - **Foco** (`Super`+setas): pela geometria das janelas visíveis, cruzando monitores
     (`neighborInDirection`).
   - **Move** (`Super+Shift`+setas): `MoveWindow` com a zona da direção e escopo local. Sem vizinha no
     monitor, a janela vai para o monitor adjacente (`get_monitor_neighbor_index` + `move_to_monitor`).
     Um membro de stack primeiro sai do grupo.
   - **Swap** (`Super+Alt`+setas): `MoveWindow` com `center` local, que é o `swap_leaves` do core. A
     ponte espelha a troca nos stacks (`swapInStacks`).
   - **Resize** (`Super+Ctrl`+setas): `ResizeWindow` de 48 px na borda direita ou inferior. Se a árvore
     não muda (janela na borda da tela), usa a borda oposta.
   - **Orientação** (`Super+O`): método D-Bus novo `ToggleOrientation`, com `toggle_orientation` no
     core. Transpõe o grid binário mais interno que contém a janela.
   - **Float** (`Super+G`): `state_json.floating`. O daemon descarta a janela com o motivo `floating`.
   - **Abas** (`Super+]`/`Super+[`): `cycleStackActive` + `activate`.
   - **Conflitos com atalhos nativos:** com `override-conflicting-keys` ligado (padrão), os atalhos
     nativos que colidem são zerados e os valores originais ficam salvos em `saved-native-keys`, que
     sobrevive a um crash. São restaurados no `disable()`, como faz o pop-shell.
4. **Borda ativa.** Um `St.Widget` no `global.window_group`, logo acima do ator da janela focada:
   - segue `position-changed`/`size-changed` da janela e o `restacked` do display;
   - some com a config desligada, em janela maximizada, fullscreen ou minimizada, durante o arrasto, na
     visão geral e enquanto o ator está fora do `window_group` (animação de troca de workspace);
   - o raio acompanha `corner_radius`.
5. **Gaps.**
   - `smart_gaps`: um grupo com um único slot (folha ou stack) fica sem gaps.
   - `outer_gap: Option<u32>`: `None` segue o `gap` único.
   - Métodos D-Bus novos: `SetSmartGaps`, `SetOuterGap`, `SetInsertMode`.
   - O indicador ganha chaves para a borda ativa, os smart gaps e a inserção pela focada.
6. **Exceções** (`matches_exception` no core): `title:<trecho>` casa se o título contém o trecho;
   `class:<id>` ou `<id>` puro casa por igualdade com o `app_id` (forma histórica). Tudo
   case-insensitive. O `WindowDto` ganha `title`.
7. **Monitores** (`remapMonitors`/`remapGroupMap`):
   - no `monitors-changed`, os índices antigos são casados com os novos pela **geometria completa** do
     monitor e, na falta dela, pelo mesmo índice;
   - `_trees`, `_stacks`, `_order` e `_disabledGroups` são reescritos;
   - grupos de monitor removido são descartados, e o core reinsere as janelas que o Mutter migrou.
8. **Barras de abas** com a mesma geometria, membros, ativa e títulos não são recriadas.

## Não adotado

- **D-Bus assíncrono.** A barreira síncrona de descarte da 0064 depende de reaplicar a geometria no
  mesmo frame do `unmanaged`. O teto de 1 s da 0067 já elimina o congelamento longo. Fica síncrono.
- **Esmagamento impositivo sem 0 px.** É a troca consciente da [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md).
  Qualquer piso para as flexíveis aumenta o transbordo que o clamp da ponte apara, e gera sobreposição.
- **Resize ao vivo.** Contradiz a trava rígida de resize da 0064/0066. O resize continua aplicado ao
  soltar.
- **Unificar a detecção de drop.** O `ResolveDropZone` segue no contrato por retrocompatibilidade; o
  GNOME usa só o `resolveHotZone` local.

## Consequências

- Terminais e apps com tamanho máximo assentam centralizados no slot, sem flicker.
- O comportamento padrão de inserção, teclado e borda passa a ser o do COSMIC. O modo cíclico continua
  disponível via `SetInsertMode("cyclic")`.
- Hotplug e reordenação de monitores preservam o layout de cada monitor.
- A ponte KDE é inalterada. Ela herda o modo `focus` do daemon e cai no ciclo quando o foco enviado é a
  própria janela nova.

## Emenda (2026-10-26) — grab do usuário invalida a recusa

A heurística de recusa compara o frame atual com o último slot committado. Depois de um resize ou
arraste manual, o frame menor é ação do usuário, não recusa do cliente — e, se o slot seguinte for
o mesmo, a janela só era centralizada e nunca voltava a preencher o slot. Ao fim de todo grab
(`grab-op-end` no GNOME, `interactiveMoveResizeFinished` no KDE) a ponte esquece o slot committado
da janela agarrada (no GNOME também invalida o dedup). A recusa volta a ser detectada se o cliente
recusar um pedido novo.
