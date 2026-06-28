# 0021 — Tamanhos mínimos de janela (geometry hints): splits assimétricos e auto-floating

**Status:** ✅ Aceita

## Contexto

O motor **Ether Flow** ([0019](0019-arvore-bsp-persistente-resize-elastico.md)) divide o espaço por
`ratio` por nó, mas **ignorava os tamanhos mínimos** que os apps impõem (geometry hints). Apps com
mínimo rígido — GNOME Software, janelas de Suporte de Idioma, apps Flutter/GTK4 — quebravam o grid
quando o espaço encolhia: o compositor faz **clamp silencioso** ao aplicar um retângulo menor que o
mínimo da janela, e ela **invade a vizinha** (sobreposição). Faltava a resiliência estilo COSMIC:
ceder o mínimo a quem precisa, espremer os vizinhos maleáveis e, no pior caso, isolar a janela
problemática sem desorganizar as demais.

## Decisão

- **Captura do mínimo na ponte** (reafirma a ponte burra do [0016](0016-extensao-ponte-burra-render-no-daemon.md)):
  - GNOME: `Meta.Window.get_min_size()` (X11 via `WM_NORMAL_HINTS`; Wayland via `xdg_toplevel.set_min_size`),
    com fallback defensivo `[0, 0]` se o método não existir/lançar.
  - KDE: `KWinWindow.minSize` (QSizeF), arredondado.
  - Novos campos `min_width`/`min_height` em `WindowSnapshot` (pontes), `WindowDto` (daemon) e
    `WindowInfo` (core), com `#[serde(default)]`/`?? 0` — **0 = sem restrição** e **retrocompatível**
    (ponte antiga × daemon novo e vice-versa). O contrato D-Bus ([0009](0009-nomenclatura-dbus-uuid.md))
    não muda: só a forma do JSON opaco evolui.

- **Splits assimétricos no core (modo proporcional forçado), aplicados SÓ na geometria.** O `ratio`
  persistido **não muda**; em `core/src/layout.rs` o corte de cada split é **clampado** para que cada
  subárvore receba ao menos seu mínimo (`min_extent` recursivo: soma + `gap` no mesmo eixo, `max` no
  perpendicular; `split_rect_clamped`; `geom_leaves_min`). Assim a janela restrita recebe o mínimo e o
  vizinho maleável encolhe — e, quando o espaço cresce, tudo **volta ao `ratio`** original.

- **Auto-floating como rede de segurança.** Quando os mínimos não cabem (em algum eixo o mínimo total
  da raiz excede a área interna), `enforce_min_sizes` **remove da árvore — só para a geometria** — a
  folha que mais pesa no eixo violado (desempate por menor id; **determinística e idempotente**, sem
  thrash) e a devolve como **flutuante centralizada** sobre o grid. A ponte aplica o retângulo e
  **eleva** a janela (`make_above`/`keepAbove`), rastreando o estado para **baixá-la** quando voltar
  ao grid. A árvore **completa** (não a podada) continua sendo persistida pela ponte, então a janela
  **lembra a posição** e re-tila quando houver espaço. Novo campo `floating` em `LayoutResult`/
  `LayoutResultDto` (retrocompatível).

- **Stacks (v1):** a folha-âncora de um stack agrega o **`max`** dos mínimos dos membros presentes
  (+ `tab_bar_height` na altura). Stacks **não** são auto-flutuados na v1 (limitação documentada).

## Consequências

- Apps de mínimo rígido deixam de sobrepor vizinhas; o grid permanece organizado mesmo sob pressão de
  espaço, com fallback flutuante para o caso impossível.
- O `ratio` (vontade do usuário) é preservado: o clamp é uma camada de renderização. Encolher uma
  janela abaixo do mínimo via resize manual **satura** na geometria (como i3/sway), mas o resize segue
  válido — volta a valer quando o espaço permite.
- O daemon permanece **sem estado**; toda a decisão vive no core (`compute_constrained`), reafirmando
  [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md).
- Trabalho futuro: auto-float de stacks inteiros; respeitar `max_size`; clamp também no caminho legado
  `compute_layout_with` (hoje só o caminho da árvore persistente respeita o mínimo).
