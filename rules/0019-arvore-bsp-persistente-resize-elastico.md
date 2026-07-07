# 0019 — Árvore BSP persistente, resize elástico, gap único e cantos arredondados

**Status:** 🔄 Topologia substituída por [#0026](0026-grid-fractal-3x3-elastico-e-hud.md) (o `Node::Split`
binário deu lugar ao `Node::Grid` elástico 3×3); a **regra de inserção** (rachar a folha focada/maior) foi
substituída por [#0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md) (Distribuição Cíclica em
Quadrantes). Permanecem válidos: estado leve na ponte, daemon sem
estado, core puro, gap único, cantos arredondados, resize elástico (agora por track) e o contrato
espelhado. Emendado por [#0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md): o resize
elástico passa a clampar a proporção aos **mínimos reais (px)** do vizinho (trava na borda) em vez do
piso proporcional fixo — fim da ejeção cross-monitor no GNOME.

## Contexto

O motor **Ether Flow** era um BSP **balanceado e função pura da ordem** das janelas
([0018](0018-abas-atalhos-globais-drag-to-group.md)): a cada nova janela ele **reembaralhava** toda a
grade, e não havia como persistir proporções. Em testes práticos no Wayland (GNOME; KDE a seguir)
isso causou três problemas e faltava um quarto recurso:

1. abrir a 5ª janela parecia "estourar" a grade e mexia em todas as outras (sem estabilidade i3/COSMIC);
2. não havia **resize manual** — o [0016](0016-extensao-ponte-burra-render-no-daemon.md) registrava
   "resize proporcional persistente exigiria estado e fica como trabalho futuro (novo ADR)";
3. o preview de drop em grades povoadas mostrava **50% do monitor** em vez do sub-quadrante real da
   janela-alvo;
4. dois ajustes de UX pedidos: **gap único** (um controle para ambos os eixos) e **cantos
   arredondados** opcionais.

Os requisitos #1 (estabilidade), o desempate de inserção (#2) e o resize elástico (#3) **exigem
estado persistente** (topologia + `ratio` por nó) — impossível com a função pura da ordem.

## Decisão

- **Árvore BSP persistente no core, vivendo como estado leve da PONTE** (o daemon segue **sem
  estado**, reafirma 0016). Tipos novos em `core/src/layout.rs`: `Axis`, `Node` (`Leaf(u64)` |
  `Split{axis, ratio, first, second}`), `LayoutTree`, `Edge`, `MIN_RATIO`. As folhas são **ids de
  janela**; um **stack** ocupa a folha do seu id-âncora (primeiro membro presente) e é resolvido na
  geometria — assim as operações de árvore lidam só com `u64`. (Decisão de implementação: dispensa uma
  variante `Leaf::Stack`; a aparência/efeito é idêntica ao 0018.)
- **Funções PURAS do core** (o daemon só serializa, a ponte só transporta):
  - `reconcile(prev, ids, stacks, focused, area, opts)` — árvore vazia → **balanceada** (geometria
    idêntica ao BSP legado: bootstrap simétrico); senão, cada janela NOVA racha a folha **focada** (ou
    a maior), e janelas fechadas **colapsam** (o irmão sobe). Estabilidade: as demais folhas não se
    movem.
  - `compute_geometry(tree, area, opts, stacks, ids)` — aplica `ratio` + gaps + stacks.
  - `move_window(tree, dragged, target, zone)` — drag-to-tile: remove o arrastado e o reinsere
    rachando a folha do alvo no lado da zona (#2-mouse).
  - `resize_window(tree, area, opts, id, edge, delta_px)` — acha o split ancestral que **governa a
    borda** (o mais profundo no eixo da borda em que a folha desce pelo lado certo) e ajusta o `ratio`;
    o vizinho encolhe na mesma proporção (soma constante → tela 100% preenchida). Clamp a `MIN_RATIO`;
    borda externa = no-op (#3 resize).
  - `detect_drop_target` corrigido: abaixo da faixa de stack, o preview é a **metade da janela-alvo**
    (não 50% do monitor), casando pixel a pixel com o split que o `move_window` produzirá (#4 preview).
- **Desempate de inserção (#2):** foco de TECLADO (`focused_id` no `state_json`) escolhe a folha a
  rachar ao abrir janela; o MOUSE (zona sob o cursor) escolhe a folha no drag. A ponte só informa o
  foco/alvo; toda a matemática é do core.
- **Contrato D-Bus evoluído** (campos com `#[serde(default)]`, retrocompatíveis):
  - `state_json` ganha `trees` (uma árvore por `(monitor, workspace)`) e `focused_id`;
  - `layout_json` devolve `trees` (reconciliadas) para a ponte **persistir** e reenviar;
  - métodos novos `MoveWindow(state_json, dragged, target, zone) -> trees_json` e
    `ResizeWindow(monitors_json, state_json, id, edge, delta_px) -> trees_json` — **tree-only**: mutam
    a árvore e devolvem o blob; a geometria vem do `SyncWindows` seguinte (baixa frequência, igual ao
    padrão de `ResolveDropZone`).
  - Blob: nó = `{"split":{axis,ratio,first,second}}`; folha = `{"win":id}`; grupo vazio = `null`. DTOs
    `NodeDto`/`SplitDto`/`TreeDto` (untagged) em `protocol.rs`, com clamp defensivo de `ratio`.
- **Gap único:** `Config.gap` substitui `inner_gap`/`outer_gap` na superfície (config, D-Bus `SetGap`,
  UI), aplicado a ambas as costuras e ambos os eixos; `#[serde(alias="inner_gap")]` migra configs
  antigas. O core mantém os dois campos de `LayoutOptions` internamente e o daemon mapeia `gap` →
  ambos (sem churn de pixels nos testes).
- **Cantos arredondados (opção):** `Config.rounded_corners` + `corner_radius`; método D-Bus
  `SetRoundedCorners(enabled, radius)`. **GNOME** anexa um `Clutter.ShaderEffect` (SDF de retângulo
  arredondado) ao `Meta.WindowActor` — a extensão roda **dentro** do Mutter (pode), ao contrário do
  daemon (processo externo: Wayland proíbe overlay alheio, ver 0016); é **defensivo** (se o shader
  falhar, a janela renderiza normal). **KDE:** um KWin _Script_ não instancia shaders → depende do
  efeito **nativo** de cantos do KWin; o script só propaga a config (mesma família de "diferença de
  apresentação aceita" do 0016/0018).

## Consequências

- **Daemon ainda sem estado, core ainda puro:** a árvore é entrada/saída; nenhum estado de sessão no
  daemon. Reafirma 0002 e 0016.
- **Estabilidade i3/COSMIC:** abrir/fechar janelas não reembaralha as demais; o layout inicial (árvore
  vazia → balanceada) é idêntico ao BSP legado, então a migração é suave e os testes legados seguem
  válidos (o `compute_layout`/`compute_layout_with` permanecem como fallback).
- **Contrato espelhado** em service.rs, protocol.rs, dbus.ts (XML + proxy), extension.ts e KWin
  main.ts, e nos dois `bridge.ts`. KDE mantém a árvore **canônica em `internalId`** e traduz
  ↔ transporte na fronteira (`treeToTransport`/`treeFromTransport`, colapsando folhas intraduzíveis);
  quem mexer no KWin script deve preservar esse de/para.
- **Limitações registradas:** o efeito de cantos no GNOME é **best-effort** (carece de validação
  visual entre versões do Shell; degrada para "sem arredondamento" se o shader não compilar). No KDE,
  cantos dependem do efeito nativo do KWin. Resize contra a borda externa do monitor é no-op
  (não há vizinho para encolher).
- **Drag deixou de ser swap:** soltar uma janela sobre o lado de outra agora **racha** a folha do alvo
  (move+split), não troca posições — comportamento alinhado ao i3/COSMIC e ao preview do #4.
