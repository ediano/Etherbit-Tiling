# 0042 — Colisão por célula, resize sob grab no GNOME e desagrupar por arraste ("cai onde foi solta")

**Status:** ✅ Aceita; emendada por [0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)
(o 2º gatilho por célula `child_below_min` sai com o auto-colisão aposentado; o **drag-to-ungroup** é
reativado em runtime — GNOME pela geometria da barra do último layout (sobrevive a relayout), KDE por
rastreio de motion no helper (robusto a clamp do release))
(emenda [0041](0041-agrupamento-por-colisao-estrita.md) — o sinal `collisions` ganha um **segundo
gatilho por célula**; corrige a regressão de resize do [0038](0038-realizacao-gated-dedup-e-boot-settle.md)
na ponte GNOME; estende o desagrupar de [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)
com **drag-to-ungroup**; reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md))

## Contexto

Três problemas em sessão real, sobre a base do [0041](0041-agrupamento-por-colisao-estrita.md):

1. **Resize manual morto no GNOME.** Arrastar a borda de **qualquer** janela (avulsa ou agrupada) não
   redimensionava — a janela voltava à proporção automática. Causa-raiz na **ponte GNOME**: sem o latch
   one-shot do `size-changed` (relaxado pelo [0038](0038-realizacao-gated-dedup-e-boot-settle.md)), cada
   `size-changed` **durante o grab** reagenda um relayout que reaplica a geometria antiga e puxa a janela
   de volta; no `grab-op-end` o frame já voltou → `resizeDeltaFrom` dá ≈0 → `ResizeWindow` nunca dispara.
   O **KDE não tem o bug** (o `retile` já é suprimido no move e nada re-tila no meio do resize) — serve
   de referência.

2. **Ejeção/sobreposição residual.** O `collisions` do [0041](0041-agrupamento-por-colisao-estrita.md) só
   dispara no **colapso de eixo inteiro** (`tracks_overflow`: `Σ mins rígidos > avail`). Uma folha cujo
   **slot resolvido** fica abaixo do seu mínimo na costura `Σ ≈ avail` (arredondamento) sem o eixo
   colapsar por completo escapava do sinal e ficava sob esmagamento (recorte/sobreposição).

3. **Desagrupar só por menu.** A única forma de tirar uma janela de um grupo de abas era o menu de
   contexto ("Desagrupar"). Faltava o gesto natural e reversível de **arrastar a aba para fora** do
   contêiner (espelho do drag-to-group que já existe).

## Decisão

### A) Resize sob grab no GNOME (ponte — `extension.ts`)

O `_onGrabBegin` (mover **ou** redimensionar) ativa `_suppressRelayout = true` (reusa o mecanismo de
supressão + `_relayoutPending` já existente) e cancela qualquer settle em corrida, de modo que o
`size-changed` durante o arraste vira **no-op coalescido**. O `grab-op-end`, após aplicar o
drop/resize (que muta a árvore em `_trees`), chama `_releaseSuppression()` — um único relayout após o
settle de 50 ms, já com a geometria nova. Assim `_applyResize` lê o frame **real** do usuário e o
`ResizeWindow` volta a fluir. O core (`resize_window`/`find_path`, que já trata `Node::Stack`) e o KDE
**não mudam** — o resize de células de abas passa a funcionar no GNOME por tabela (Regra II da diretiva).

### B) Segundo gatilho de colisão por CÉLULA (core — `layout.rs`)

`geom_leaves_min` passa a sinalizar colapso também quando **uma célula** (folha/stack) tem o slot já
resolvido (via `solve_tracks`) **abaixo do seu mínimo** (`round(slot) < min`, estrito) em algum eixo —
helper novo `child_below_min`, complementando `tracks_overflow`. As folhas do grid são então emitidas
como `CollisionGroup` para a ponte agrupar em abas, **exatamente pelo mesmo caminho** do 0041 (mesmo
`collect_node_leaf_ids`, mesmo **guard `≥ 2`**). A escolha dos **irmãos** do grid como parceiros de
fusão garante **convergência**: ao agrupar, a região do grid (a união das células) absorve o mínimo, o
stack deixa de estourar e o sinal esvazia — sem oscilação. O grid-filho é ignorado (o próprio nível
dele decide) e a supressão `in_collapsed` segue evitando grupos aninhados redundantes.

**Caso patológico preservado:** uma janela **sozinha** cujo mínimo excede a célula (sem irmão com quem
fundir) continua sob **esmagamento impositivo** ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md))
— o guard `≥ 2` não emite grupo de um só, evitando re-merge em loop.

### C) Desagrupar por arraste, "cai onde foi solta" (core + pontes + helper KDE)

- **Core (`move_window`):** passa a usar `detach_window` no lugar de `collapse_leaf` — remove a janela
  arrastada de **onde estiver** (folha solta **ou** membro de stack, inclusive a **âncora**),
  **preservando os demais** membros (o stack reancora; com 1 restante dissolve em folha). Em seguida a
  reinsere rachando a folha-alvo. Assim, arrastar uma aba (mesmo a visível) para fora ejeta **só ela** e
  mantém o grupo; a janela ejetada **cai no ponto de soltura** (split local / bloco global / maximizar),
  reusando a mesma resolução de zona do drag-to-tile.
- **GNOME (`extension.ts`):** o press esquerdo numa guia inicia um rastreio de arraste; um
  `captured-event` no stage observa o **release**. Soltar **fora** da barra ejeta
  (`removeIdFromStacks`) e reposiciona via `MoveWindow` na zona resolvida em `resolveHotZone`; soltar
  **dentro** é o clique normal (troca de aba). O menu "Desagrupar" permanece.
- **KDE (helper `preview` + KWin script):** o helper de overlay ganha detecção de arraste
  (`Press`/`Release` sob o grab implícito do ponteiro): soltar uma guia fora da faixa enfileira uma
  `TabAction { kind: "ungroup_drag", x, y }` (coordenadas **globais** de soltura). O KWin script, ao
  drenar, faz `removeIdFromStacks` + `resolveHotZone(x, y)` + `MoveWindow`. `TabAction` ganha `x`/`y`
  com `#[serde(default)]` (retrocompat do JSON drenado). O `ungroup` simples (menu) segue reinserindo no
  grid cíclico.

## Consequências

- **Reafirma 0002/0016:** o core puro decide colisão e topologia (inclusive o `detach_window`); o daemon
  segue sem estado; as pontes só aplicam/agrupam a mando do usuário.
- **Contrato:** `MoveWindow`/`ResizeWindow` inalterados. Só a `TabAction` do helper KDE ganha `x`/`y`
  (retrocompat). O sinal `collisions` mantém a forma (o segundo gatilho reusa o mesmo campo/guard).
- **Comportamento:** o resize elástico volta a funcionar no GNOME (avulso e agrupado), a barra de abas
  1/N reajusta sozinha; o agrupamento cobre também o déficit por célula (sem sobreposição residual); a
  janela desagrupada por arraste assenta onde foi solta.
- **Testes:** `layout.rs` ganha casos de `detach_window` (ejeta âncora mantendo o grupo; dissolve stack
  de 2) e de `child_below_min`; `preview/tabs.rs` valida a serialização de `ungroup_drag`; os vitest das
  pontes cobrem o parse de `ungroup_drag`. Resize no GNOME e o gesto de ejetar por arraste (GNOME e KDE)
  são validados em **sessão real**.
- **Fora do escopo:** `platform-macos` (Swift); i18n do rótulo do menu do helper KDE; guard persistente
  "o usuário desagrupou, não re-agrupe".
