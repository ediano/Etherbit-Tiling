# 0022 — `Node::Stack` na árvore, fechar/desagrupar na barra de abas e Unmaximize Recovery

**Status:** 🔄 Topologia substituída por [#0026](0026-grid-fractal-3x3-elastico-e-hud.md) (o `Node::Stack`
agora convive com `Node::Grid` no lugar do `Node::Split`). Permanecem válidos: `Stack` como variante de
primeira classe, fechar/desagrupar na barra, e o **Unmaximize Recovery** (adaptado ao grid).

## Contexto

Três evoluções dos recursos de abas/produtividade, todas respeitando o princípio "core puro, daemon sem
estado, ponte aplica" (ADR [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md)):

1. O ADR [0018](0018-abas-atalhos-globais-drag-to-group.md)/[0019](0019-arvore-bsp-persistente-resize-elastico.md)
   modelava um stack como uma **folha-âncora** (`Node::Leaf` com o id do 1º membro) + um
   `StackDescriptor` lateral. Faltava o **container de abas como tipo de primeira classe na árvore**.
2. A barra de abas (GNOME) só tinha ícone + título + clique-para-ativar. Faltavam o **ícone "x" de
   fechar** por aba e um **menu de contexto** focado em **"Desagrupar Janela"**.
3. Uma janela aberta **já maximizada** que o usuário depois **desmaximiza** ficava flutuando solta (o
   grid não a reencaixava).

## Decisão

- **`Node::Stack { members, active }` é um variante de primeira classe do enum `Node`** (core), ao lado
  de `Leaf` e `Split`. Um stack ocupa **um** slot do BSP; todas as `members` herdam o mesmo `(X,Y,W,H)`
  e só a `active` entra em `rects` (a barra come o topo). A âncora/identidade é `members[0]`.
  - **Topologia desmaterializada:** a lógica de inserir/colapsar/balancear do `reconcile` opera sobre a
    forma "desmaterializada" (cada `Stack` vira `Leaf(âncora)`), e o resultado é **materializado** de
    volta em `Node::Stack` conforme o comando `stacks` da ponte. Isso mantém a aritmética do BSP e a
    máquina de **mínimos/auto-floating** ([0021](0021-tamanhos-minimos-geometry-hints.md)) intactas (um
    stack conta como 1, mínimo agregado sob a âncora). A geometria renderiza o `Node::Stack` direto do
    nó (sem descritor lateral).
  - **Persistência/contrato:** `NodeDto` ganha a variante `{ "stack": { members, active } }`
    (untagged, retrocompatível); as duas pontes ganham a variante no tipo `TreeNode`, e o **KDE**
    traduz os `members`/`active` entre `internalId` (string) e id de transporte (número) no
    `treeToTransport`/`treeFromTransport`. **Desagrupar** = a ponte tira a janela do estado de stacks e
    o `reconcile` reexpande a folha (sem `Node::Stack` para aquele grupo).
- **Barra de abas (GNOME) interativa:** cada guia vira um `St.BoxLayout` reativo com **[conteúdo
  clicável → ativa]** + **[ícone "x" → fecha o app]** (`Meta.Window.delete`). Clique com o **botão
  direito** abre um `PopupMenu` minimalista com o item único **"Desagrupar Janela"** (reusa o helper
  puro `removeIdFromStacks` da ponte). O preview de drag realça a zona **"stack"** em verde (empilhar)
  vs. azul (split). Reafirma o 0016/0018: o **GNOME desenha na ponte**; o **KDE** terá a barra clicável
  via wgpu/layer-shell (ver Trabalho futuro).
- **Unmaximize Recovery:** o contrato ganha `maximized: bool` (snapshot → `WindowDto`/`WindowInfo`,
  `#[serde(default)]`). Regra pura no core (`retain_tileable_when_maximized`):
  - janela maximizada que **ainda não tem folha** na árvore (abriu maximizada) fica **fora** do grid
    até desmaximizar — aí entra pela **maior folha** (`largest_leaf_id`, já existente), dividindo
    balanceado;
  - janela maximizada que **já era folha** (maximizada temporariamente) **preserva o slot** e volta à
    posição/proporção exatas ao desmaximizar (sai de graça da árvore persistente).
  As pontes detectam o estado (GNOME `get_maximized() === BOTH` — **ver emenda 2026-06 abaixo**; KDE comparando com a `MaximizeArea`),
  **não aplicam geometria** em janelas maximizadas e re-tilam no evento de (des)maximização (GNOME
  `notify::maximized-*`; KDE `maximizedChanged`, conectado defensivamente). Nenhum método D-Bus novo —
  o evento vira um `SyncWindows` (daemon sem estado).

## Consequências

- **Core ainda puro, daemon ainda sem estado:** stacks, maximização e toggles seguem entrada/saída. O
  `Node::Stack` vive na árvore persistida (estado leve da ponte), não no daemon.
- **Contrato espelhado:** a variante de nó (DTO + dois `TreeNode`) e o campo `maximized` (DTO + dois
  `WindowSnapshot`) foram atualizados em conjunto (GNOME, KDE, daemon).
- **Testes:** core cobre materialização/desmaterialização do `Node::Stack`, desagrupar uma janela e o
  Unmaximize Recovery (maior-folha e preservação de slot). As ações de UI (x/menu) são GJS → validação
  manual.
- **Limitação registrada:** a detecção de maximização no KDE por comparação de geometria pode ter
  falso-positivo com `gap = 0` e uma única janela ocupando a tela — inofensivo (tratá-la como fora do
  grid não muda nada visível).

## Barra de abas clicável no KDE via wgpu/layer-shell (fundação)

O 0016/0018 registrou que o KWin *Script* não faz overlay clicável. A barra interativa no KDE (x + menu
+ preview de empilhar) é o **daemon renderizando com `wgpu` numa superfície `wlr-layer-shell`**
(suportada pelo KWin) — superfície PRÓPRIA do daemon, não overlay sobre janelas alheias (respeita o
0016). Isso **substitui** a ideia de um KWin *Effect* (C++/QML) e reaproveita a matemática do core
(`tab_bars`).

**Fundação já implementada (atrás da feature `wgpu-ui`, compila no CI sem GPU):**
- `tabbar.rs` — modelo + **hit-testing puro** (qual guia/“x”/menu um clique atinge), com testes;
- `render.rs` — pipeline `wgpu` de quads (faixa + guias + “x”), `build_quads` testado; **texto** do
  título/ícone do app fica como próximo passo (atlas de glifos: cosmic-text/glyphon);
- `layer.rs` — orquestração `TabBarOverlay` (atualizar barras, desenhar, despachar clique) + a ponte
  `raw-window-handle` ↔ `wgpu::Surface`; o `run_event_loop` (bind real da `LayerSurface` + loop do
  `wl_pointer` via `smithay-client-toolkit`) é o único ponto **de hardware** (precisa de sessão KWin) e
  encerra graciosamente fora dela;
- `service.rs` — sinal D-Bus **`TabAction(stack_id, member_id, action)`** (`activate|close|ungroup`) +
  `emit_tab_action`.

**Restrição descoberta (a resolver na integração de hardware):** o KWin *Script* (QJSEngine) **não
assina sinais D-Bus** — só faz `callDBus` (modelo *pull*, ver 0016). Logo o `TabAction` **não é
consumível diretamente** pela ponte KDE. O transporte da ação ao KDE será resolvido por **pull** (um
método tipo `PollTabActions` que a ponte drena) **ou** migrando a barra para um **KWin Effect** (que tem
acesso pleno). Decisão e ADR próprios quando a integração de hardware for feita; muda a "apresentação
nativa minimizada" do 0018 para o KDE.

## Emenda (2026-06): detecção de maximização no GNOME por feature-detection → ver [0023](0023-compat-api-mutter-feature-detection.md)

A detecção `GNOME get_maximized() === BOTH` acima quebrou numa VM limpa: em parte da faixa
`shell-version 45–50` o `Meta.Window.get_maximized()` **não existe** e lançava
`TypeError: ... is not a function` em loop, paralisando o relayout. O `_isMaximized` passa a detectar
o método em runtime (`get_maximized_state` → `get_maximized` → propriedades booleanas
`maximized_horizontally`/`maximized_vertically`), **preservando a semântica AMBOS os eixos** (`=== BOTH`,
nunca `!== 0`). O contrato `maximized` e o Unmaximize Recovery deste ADR não mudam. Detalhes e a regra
geral de acesso defensivo à API do Mutter em [0023](0023-compat-api-mutter-feature-detection.md).
Status permanece **✅ Aceita**.

