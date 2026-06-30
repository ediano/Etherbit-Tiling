# 0028 — Mecânica de arraste em eixos limpos (estilo Cosmic) e KDE sem abas

**Status:** ✅ Aceita (substitui as **zonas/escopo** do
[0026](0026-grid-fractal-3x3-elastico-e-hud.md); torna as abas
[0018](0018-abas-atalhos-globais-drag-to-group.md)/[0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md)
**GNOME-only**; remove a barra clicável do KDE do
[0025](0025-barra-abas-clicavel-kde-entrega-por-pull.md). Reafirma
[0016](0016-extensao-ponte-burra-render-no-daemon.md). Estendida por
[0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md): o **Merge Fallback** de colapso é
**GNOME-only** — o KDE, tiling puro, mantém o **auto-floating**; os splits seguem **50/50**)

## Contexto

O modelo do [0026](0026-grid-fractal-3x3-elastico-e-hud.md) (matriz **3×3 / jogo da velha** com 9 zonas,
**cantos**, **célula unitária** por densidade e split **local de 1/3**) provou ser mais complexo do que a
UX desejada. A nova estratégia espelha a mecânica do **COSMIC** (System76 / Pop!\_OS): **eixos limpos**,
universais e previsíveis, com divisões sempre **50/50**, em que as restrições de tamanho mínimo (de uma
janela ou de um grupo) governam a elasticidade. Em paralelo, o ecossistema de **abas no KDE** (barra
clicável via wgpu/wlr-layer-shell + minimização de inativas) trazia complexidade crônica de empilhamento
e foco no KWin; o escopo do KDE passa a ser **100% tiling dinâmico puro**.

## Decisão

### Mecânica de arraste (universal: GNOME e KDE)

**Zonas globais** — cursor nas faixas de borda da **TELA** (em _gap_, ou sobre janela colada à borda):
esquerda/direita → **50% vertical**; topo/base → **50% horizontal**; miolo central da tela vazia →
**maximizar** (100%). **Sem os 4 cantos.**

**Zonas locais** — cursor sobre o corpo de uma janela, longe das bordas: lados → split **50/50** lado a
lado; cima/baixo → **50/50** empilhado; **centro** → **merge em abas (GNOME)** ou **swap** das duas
janelas **(KDE)**.

### Núcleo (`core/src/layout.rs`)

- `move_window` passa a produzir **splits 50/50** (`DropScope::Local` deixa de dar 1/3). `DropScope::Grid`
  é **removido** do enum; `zone_to_cell` e `place_in_grid_cell` saem. `DropZone::Center` em escopo `Local`
  vira **`swap_leaves(dragged, target)`** (nova função que permuta duas folhas preservando topologia e
  proporções) — é o gesto do KDE puro; o GNOME intercepta o centro na ponte (merge) e nunca chama o core
  com `Center`.
- `detect_drop_zone` perde a detecção de cantos (mantém bordas → metade e centro → maximizar). Os
  **cantos do enum `DropZone` permanecem** apenas por **retrocompat de `parse_zone`** (uma ponte antiga
  ainda pode mandá-los; degradam para a metade correspondente).
- **`Node::Grid` é mantido**, restrito ao caso **binário** (2 tracks, 50/50). Reverter ao `Node::Split`
  teria custo alto e zero ganho: toda a geometria (`geom_leaves_min`, `solve_tracks`, `track_mins`),
  o resize (`binary_grid_axis`/`adjust_ratio`) e o contrato D-Bus já operam sobre `Grid`; os helpers
  `split_h`/`split_v` já são a ponte de compatibilidade. Grids 3×3 herdados ainda renderizam (geometria
  genérica) e colapsam para binário conforme o usuário rearranja.

### Salvaguarda de tamanho mínimo (mantém [0021](0021-tamanhos-minimos-geometry-hints.md), generaliza no preview)

A salvaguarda **funcional** já é emergente do [0026](0026-grid-fractal-3x3-elastico-e-hud.md): um split
0.5 vira `Grid { cols:[0.5,0.5] }` e `compute_constrained → geom_leaves_min → solve_tracks` clampa por
track em **cascata cooperativa** (a janela/grupo que exige mais satura no mínimo, as vizinhas encolhem
proporcionalmente, 100% preenchido sem sobreposição). Em grupos de abas (GNOME), `build_min_sizes`
agrega o **`max`** dos mínimos dos membros sob a âncora — a maior restrição dita a regra. **Nada a
reescrever aqui.**

Novidade: o **preview antecipa o mínimo da janela arrastada**. `detect_drop_target` ganha `dragged_min`
e a metade local do preview é **esticada** (`extent = clamp(max(metade, min), MIN_RATIO·disp,
(1-MIN_RATIO)·disp)`) — `(0,0)` recai na metade pura. Como o preview do drag é calculado **na ponte**
(`resolveHotZone`, ver 0026/0016), a mesma fórmula é espelhada em TS (KDE e GNOME), lendo o `minSize`
da janela em arrasto. O contrato `ResolveDropZone` ganha `dragged_min_w/h` para o caminho via daemon.

### KDE: tiling puro, sem abas (remove do KDE o 0018/0022/0025)

- O KWin Script remove o estado e os helpers de abas (`stacks`, `groupTiled`, `stackHidden`,
  `addToStack`, `toggleStackGroup`, `setActiveMember`, `removeIdFromStacks`, `parseTabBars`,
  `parsePendingActions`), o atalho **Meta+S** e a minimização de inativas. `treeFromTransport`/
  `treeToTransport` **colapsam** um `stack` herdado para a folha do primeiro membro (migração para
  tiling puro no primeiro retile). Mantém **Meta+Shift+Y** (geral) e **Meta+Y** (por desktop).
- O **daemon** remove a **barra de abas clicável** wgpu (o "applet satélite" do imaginário do 0025 nunca
  foi plasmoid — era essa barra): `tabbar.rs`, render de texto (glyphon), `BarInput`, a fila
  `pending_actions`, o sinal `TabAction`. **Mantém o overlay de HUD** de preview (também wgpu/layer-shell:
  `apply_hud`/`draw_fill`/`HUD_FILL`/`HUD_HOT`) — o KDE ainda precisa dele.

### GNOME: mantém abas

A extensão conserva stacks/abas/merge no centro; muda **só** a mecânica de eixos (1/3 → 1/2, sem 3×3,
sem cantos). Os DTOs de abas (`TabBarDto`, `tab_bars`, `titles`, stacks no `SyncStateDto`, `Node::Stack`)
**permanecem no contrato** porque o GNOME os consome (desenha as próprias barras com `St.Widget`).

### Contrato D-Bus

`parse_scope` deixa de reconhecer `"grid"` (degrada para `local`, sem erro). `ResolveDropZone` ganha
`dragged_min_w/h`. `MoveWindow`/escopo seguem como string; IDs seguem viajando como **string** no KDE
([0009](0009-nomenclatura-dbus-uuid.md)).

## Consequências

- **Reafirma o 0016/0002:** core puro, daemon sem estado, ponte dona do estado leve. `Node::Grid`
  (binário) continua viajando em `state_json`/`trees_json`.
- **ADRs afetados:** as **zonas/escopo** do [0026](0026-grid-fractal-3x3-elastico-e-hud.md) são
  substituídas (o `Node::Grid` e a máquina de min/auto-float permanecem); as abas do
  [0018](0018-abas-atalhos-globais-drag-to-group.md)/[0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md)
  passam a **GNOME-only**; a barra clicável do KDE do
  [0025](0025-barra-abas-clicavel-kde-entrega-por-pull.md) é **removida** (o HUD overlay segue).
- **Testes:** os ~80 testes do `layout.rs` foram ajustados (1/3 → 1/2, swap, sem cantos), com remoção
  dos casos de grid 3×3 e adição de casos de swap e de preview clampado por mínimo. As pontes ajustam
  `resolveHotZone`/`serializeScope`/`serializeState`; o KDE remove as suítes de abas.
- **Fora do escopo:** `platform-macos` (Swift, não compila no container). O core segue agnóstico; o
  consumo macOS do novo modelo é trabalho futuro no host.
