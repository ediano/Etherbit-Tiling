# 0045 — Desagrupar reancora o grupo no lugar (zona `eject`)

**Status:** ✅ Aceita
(emenda [0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md) e
[0044](0044-guard-anti-reagrupamento-desagrupar-manual.md) — corrige o teleporte topológico do
desagrupamento **sem alvo**, que reabsorvia a janela recém-ejetada e capturava janelas externas; reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md): a
correção do teleporte é do **core** (topologia); o guard segue **estado de ponte**)

## Contexto

O desagrupar por arraste "cai onde foi solta" ([0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md))
usa o core `detach_window`, que ejeta a janela **reancorando o stack NO LUGAR** (slot preservado). Mas os
caminhos **sem alvo** — o menu "Desagrupar Janela" e o fallback do arraste solto no vazio
(`dropZone === 'none'` / escopo local sem alvo) — **não** passavam por `detach_window`: só faziam
`removeIdFromStacks` + relayout, sem atualizar a árvore local. No relayout, o `reconcile` recebe a árvore
**antiga** (com o `Node::Stack` intacto) e o descriptor **novo** já sem a ejetada.

`dematerialize_stacks` representa um stack pela sua **âncora** (`members.first()`). Ao ejetar a **âncora**,
o `reconcile` mantém a âncora antiga como folha no slot e trata a **nova âncora** como folha NOVA →
`insert_cyclic` **teleporta o grupo restante** para outro quadrante, rachando a célula de uma vizinha
50/50. Efeitos observados em sessão real (o "efeito ímã expandido"):

- o grupo remanescente **salta** de lugar (imprevisível);
- o split cíclico cria uma colisão nova com uma janela **externa** E; o guard
  [0044](0044-guard-anti-reagrupamento-desagrupar-manual.md) (`filterRegroupable`) só remove os ids que o
  usuário desagrupou, então **E é capturada** no stack;
- sob esmagamento impositivo ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)), o grupo
  teleportado **sobrepõe** a janela do slot → parece "reabsorção" da janela recém-ejetada.

No GNOME havia ainda um problema no **arraste** da aba: o press sobre a tag podia iniciar um move-grab do
Mutter da **janela inteira** — arrastava o "bloco inteiro" e roubava o release do `captured-event`,
deixando a supressão de relayout presa ("funciona uma vez e falha").

## Decisão

### A) Zona `eject`: desagrupar SEM alvo reancora o grupo no lugar (core)

Nova variante `DropZone::Eject`. Em `move_window`, `Eject` faz **apenas** `detach_window(tree, dragged)` —
o grupo remanescente reancora no lugar e a ejetada **sai da árvore**. A reinserção da ejetada num quadrante
novo fica a cargo do `reconcile` seguinte (que já recebe a `area`), pela distribuição cíclica
([0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)). No-op se a árvore não contém a
arrastada (o daemon aplica `move_window` a todos os grupos). Sem preview (`zone_rect` zerado). **Não** muda
a assinatura de `move_window` nem o contrato D-Bus: só um novo valor de string tolerante em
`parse_zone`/`zone_label` (retrocompat — ponte antiga nunca manda `"eject"`; ponte nova × daemon antigo cai
em `None` = no-op).

### B) As pontes roteiam todo desagrupar sem alvo pela zona `eject`

O menu "Desagrupar" e os fallbacks do drag-to-ungroup (solto no vazio / local sem alvo) emitem `MoveWindow`
com zona `"eject"` (alvo `0`, escopo `local`) e persistem a árvore da resposta, em vez de só reagendar o
relayout. Como a ejetada entra em `_userUngrouped`/`userUngrouped`
([0044](0044-guard-anti-reagrupamento-desagrupar-manual.md)), se ela **recolidir** ao reassentar, o
`filterRegroupable` a exclui → **nenhuma janela externa é capturada**. Vale para GNOME e KDE (helpers
`_ejectFromStack`/`ejectFromStack`, espelhados — [0012](0012-testes-isolados-por-plataforma.md)).

### C) GNOME: o gesto de aba tem prioridade sobre o move-grab do Mutter

`_onGrabBegin` ignora o grab enquanto um arraste de aba está ativo (`if (this._tabDrag) return;`): o press
na tag não vira mais um move-grab da janela inteira, e o release chega ao `captured-event` do gesto de aba.
Rede de segurança em `_beginTabDrag`: ao rearmar com um gesto anterior pendente, preserva o relayout para
não engolir o do gesto novo — **sem timeout** (que finalizaria um gesto em curso prematuramente). O KDE já
usa o modelo "activate adiado" no helper (`overlay.rs`) e não precisa deste guard.

## Consequências

- **Comportamento:** desagrupar (menu **ou** arraste) tira **só** a janela escolhida; o grupo restante
  **fica no lugar**; a ejetada assenta em novo quadrante (cíclico) e **não** captura vizinhas externas. O
  arraste da aba descola só a janela (nunca o bloco) e não trava entre gestos.
- **Caso 2→1:** ejetar de um stack de 2 dissolve o grupo — a **ejetada** (filtrada pelo guard) é que se
  move; o remanescente vira folha no slot. `detach_window` já cobre isso.
- **Reafirma 0002/0016:** a correção do teleporte é do **core** (topologia); o guard
  [0044](0044-guard-anti-reagrupamento-desagrupar-manual.md) segue estado de ponte. O sinal `collisions` e
  os DTOs **não** mudam.
- **Contrato:** nenhum campo/assinatura D-Bus muda; só a zona ganha o valor `"eject"` (tolerante).
- **Preserva:** ocultação de abas sob janela maximizada, esmagamento/min-size
  ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)–[0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md))
  e o auto-agrupamento por colisão ([0041](0041-agrupamento-por-colisao-estrita.md)) intactos — a decisão é
  corrigir a topologia do desagrupamento, **não** suavizar a colisão.
- **Testes:** core — `move_window` `Eject` reancora no lugar / dissolve 2→1 / no-op em grupo alheio; e o
  fluxo `detach` + `reconcile` mantém o slot e não captura externa (fecha a lacuna do teste que só removia
  membro **não-âncora**). Pontes — vitest de `removeIdFromStacks`/`parseTabActions` inalterados; o efeito
  visual (sem teleporte, sem captura, arraste estável) é validado em **sessão real**, GNOME e KDE (padrão
  dos ADRs 0038-0044).
- **Fora do escopo:** `platform-macos` (Swift).
