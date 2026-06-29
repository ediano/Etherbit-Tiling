# 0018 — Abas (StackNode), atalhos globais e agrupar por arraste

**Status:** 🔄 Topologia substituída por [#0026](0026-grid-fractal-3x3-elastico-e-hud.md) (a árvore BSP
deu lugar ao grid 3×3 elástico). Permanecem válidos: `Stack` (abas) como conceito, atalhos globais
(`Super+Y`/`Super+S`), agrupar por arraste (agora zona **centro** do jogo da velha) e o estado leve na
ponte.

## Contexto

O motor era exclusivamente uma grade BSP (uma janela por folha). Faltavam três recursos de
produtividade: **agrupar janelas em abas** (várias janelas num mesmo quadrante, só a ativa visível),
**atalhos globais** para ligar/desligar o tiling por workspace e para agrupar/desagrupar em abas, e
**agrupar por arraste** (soltar uma janela sobre o topo de outra a empilha). O ADR
[0016](0016-extensao-ponte-burra-render-no-daemon.md) firmou que sob Wayland um processo separado (o
daemon) não desenha sobre janelas alheias e que o daemon permanece **sem estado** — esses recursos
precisavam respeitar ambos.

## Decisão

- **A "árvore lógica" vive no core como ENTRADA pura.** `compute_layout_with(windows, areas, opts,
  stacks, disabled_groups)` estende o BSP: o espaço é dividido sobre *slots*, onde um slot é uma
  janela solta **ou** um `StackDescriptor` (conjunto de janelas que ocupam UMA folha). A aritmética
  do BSP é idêntica — um stack conta como 1; ele assume a posição de ordem do seu **primeiro membro**
  presente (determinismo preservado). `compute_layout` antigo vira um wrapper fino
  (`= compute_layout_with(..., &[], &[]).rects`), mantendo o comportamento e os testes históricos.
- **Só a aba ativa entra em `rects`** (com o retângulo de conteúdo, abaixo da faixa da barra); cada
  stack rende um `TabBarRect` (faixa + conteúdo + membros + ativa). As inativas **não** recebem
  retângulo — a ponte as oculta. Evitou-se um campo `visible` em `WindowRect` (mantém intactos os 16
  testes legados do core).
- **Tiling por workspace:** `disabled_groups: &[(monitor, workspace)]` faz o core PULAR esses grupos
  (janelas flutuam livres). O isolamento por `(monitor, workspace)` já existente garante que os
  demais grupos seguem intocados.
- **Agrupar por arraste:** o core ganha `detect_drop_target(area, target, x, y, opts)` e a zona
  `DropZone::Stack`. Se o cursor está na **faixa superior (~25%)** da janela-alvo, o destino é
  empilhar (preview = o retângulo da janela-alvo); fora disso, delega a `detect_drop_zone` (split,
  inalterado). A ponte resolve QUAL é a janela sob o cursor; o core resolve a fração.
- **Todo o estado novo vive na PONTE (o daemon segue sem estado).** Como a *ordem*, a ponte guarda os
  stacks, a aba ativa e os grupos desligados, e os envia em cada `SyncWindows` via `state_json`. O
  contrato D-Bus evolui (mudança de aridade, atualizada nas duas pontes em conjunto):
  - `SyncWindows(windows_json, monitors_json, state_json) -> layout_json` — `layout_json` passa a ser
    um **objeto** `{ rects, tab_bars }` (as pontes toleram o array legado);
  - `ResolveDropZone(x, y, monitors_json, target_json) -> preview_json` — `target_json` é o retângulo
    da janela sob o cursor (ou `""`); a zona `"stack"` é possível.
  Os DTOs novos usam `#[serde(default)]` (retrocompatíveis, como em `config.rs`).
- **A barra de abas é desenhada pela PONTE** (reafirma o 0016): o core/daemon só calculam a
  geometria. **GNOME:** um `St.BoxLayout` reativo (irmão do preview de drop) com um botão por aba —
  ícone (`Shell.WindowTracker`) + título (`Meta.Window.get_title()`); clicar troca a aba ativa. As
  inativas são minimizadas. **KDE (paridade funcional):** um KWin *Script* (QJSEngine sandboxed), ao
  contrário do `St.Widget`, **não instancia overlay QML posicionado** de forma confiável — isso seria
  um KWin *Effect*, fora do escopo do script. Então no KDE a aba ativa fica visível, as demais são
  **minimizadas** (afordância nativa: barra de tarefas/alt-tab) e **ativar** uma janela do stack a
  traz à frente (troca de aba **dirigida por ativação**). É a mesma família de "diferença de
  apresentação aceita" já registrada no 0016 (GNOME = caixa preenchida; KDE = primitivo nativo).
- **Atalhos globais, padrões `Super+Y` (toggle tiling no workspace) e `Super+S` (toggle abas):**
  - **GNOME:** chaves keybinding num gschema
    (`schemas/org.gnome.shell.extensions.etherbit-tiling.gschema.xml`, `settings-schema` no
    `metadata.json`) + `Main.wm.addKeybinding`/`removeKeybinding`. O `install.sh` já compila/copia o
    schema.
    - **KDE:** `registerShortcut('EtherbitToggle…', …, 'Meta+Y'/'Meta+S', cb)` (editável em
    Configurações do Sistema → Atalhos).
  - O atalho **muta o estado leve na ponte e dispara o relayout**; é o `SyncWindows` (com o
    `state_json` atualizado) que leva o disparo ao **core em Rust**, que de fato processa o resultado
    empilhado/desligado. Nenhum método D-Bus de toggle é necessário — o daemon segue sem estado.
- **KDE passa a usar o desktop virtual REAL** (`win.desktops`/`workspace.currentDesktop`) no lugar do
  `workspace: 0` fixo, para o toggle por workspace afetar só o desktop atual.

## Consequências

- **Daemon ainda sem estado, core ainda puro:** stacks e toggles são entrada/saída; nenhum estado de
  sessão no daemon. Reafirma 0002 e 0016.
- **Contrato espelhado em 6 pontos** (service.rs, protocol.rs, dbus.ts XML + interface, extension.ts,
  KWin main.ts) e nos dois `bridge.ts` espelhados. A mudança de aridade exige atualizar GNOME, KDE e
  daemon juntos — aceitável por viverem no mesmo monorepo.
- **Ids opacos no KDE:** os membros de um stack são `internalId` (string) na ponte e traduzidos para
  ids de transporte (números) no `serializeState` via o mapa do retile; a resposta é traduzida de
  volta por `byId`. Quem mexer no KWin script deve preservar esse de/para.
- **Limitação registrada:** uma barra de abas **clicável** no KDE exigiria um KWin *Effect* (C++/QML),
  fora do escopo do KWin *Script*. A paridade entregue é **funcional** (empilhar, trocar, agrupar,
  arrastar), com apresentação nativa de cada plataforma.
- **`Super+S` pode colidir** com um atalho padrão do Plasma — documentado; o usuário pode religar.

## Emenda (2026): Árvore persistente → ver [0019](0019-arvore-bsp-persistente-resize-elastico.md)

O [0019](0019-arvore-bsp-persistente-resize-elastico.md) troca o BSP função-da-ordem por uma **árvore
BSP persistente** (estabilidade i3/COSMIC + resize elástico). Os **stacks** deixam de ser uma lista
lateral (`StackDescriptor`/`StackGroup` paralelos) no caminho novo: cada stack ocupa a **folha do seu
id-âncora** (primeiro membro presente) na árvore e é materializado na geometria por `reconcile`/
`compute_geometry` (reusa a renderização de barra de abas deste ADR via `render_stack`). O
`detect_drop_target` foi corrigido para projetar o **sub-quadrante real da janela-alvo** no preview
(antes mostrava 50% do monitor). O estado de stacks/abas/grupos desligados **continua na ponte** e o
daemon **continua sem estado**. Status permanece **✅ Aceita** (o 0019 o estende, não o revoga).
