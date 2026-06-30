# 0025 — Barra de abas clicável no KDE: entrega da ação por PULL e fila efêmera no daemon

**Status:** 🔄 **Barra clicável do KDE removida** por
[0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md) (o KDE virou tiling puro, sem abas; o daemon perdeu
`tabbar.rs`/glyphon/`pending_actions`/sinal `TabAction`). O **overlay de HUD wgpu** que ainda restava
foi removido por [0029](0029-daemon-sem-framework-visual.md): o daemon não tem mais NENHUM código gráfico.
Aceita em sua origem (estendia [0018](0018-abas-atalhos-globais-drag-to-group.md) e [0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md)).

## Contexto

O ADR [0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md) firmou que a barra de abas
**clicável** do KDE é o **daemon** desenhando com `wgpu` numa superfície `wlr-layer-shell` PRÓPRIA
(respeita o [0016](0016-extensao-ponte-burra-render-no-daemon.md): não é overlay sobre janelas
alheias) e deixou a **fundação** pronta atrás da feature `wgpu-ui` (`tabbar.rs` com hit-testing puro,
`render.rs` de quads, `layer.rs` de orquestração, e o sinal `TabAction`). Esse mesmo ADR registrou a
**restrição descoberta**: o KWin *Script* (QJSEngine) **só faz `callDBus`** — não assina sinais D-Bus
e não tem `setTimeout` (modelo *pull*, ver [0016](0016-extensao-ponte-burra-render-no-daemon.md)).
Logo o `TabAction` **não é consumível** pela ponte KDE, e a entrega da ação ficou em aberto ("resolver
na integração de hardware: um método tipo `PollTabActions` que a ponte drena **ou** migrar a barra
para um KWin *Effect*").

Era também tentador criar um **applet satélite** separado para desenhar as abas. Mas o core já é puro
(zero deps, sem código visual) e a barra já é renderizada pelo daemon na sua própria superfície — um
binário novo **duplicaria** a fundação do 0022 e contrariaria o 0016. A decisão (com o usuário) foi
**terminar no daemon**, não criar processo novo.

## Decisão

- **A ação de aba é entregue por PULL, embutida no `layout_json` do `SyncWindows`.** O `LayoutResultDto`
  ganha `pending_actions: Vec<TabActionDto>` (`#[serde(default)]`, retrocompatível). A ponte KDE já
  drena o callback do `SyncWindows` a cada evento de janela; ela passa a aplicar também as ações ali —
  **sem método D-Bus novo nem gatilho novo**. Preferida a um `PollTabActions` separado (que, sem timer
  no sandbox, só poderia ser chamado nos mesmos eventos de janela — colapsa neste desenho com um passo
  a mais) e ao KWin *Effect* (C++/QML, fora do escopo do KWin *Script*; fica como plano B se a latência
  virar requisito).
- **O daemon ganha UMA fila efêmera de ações** (`Arc<Mutex<VecDeque<TabActionDto>>>`): o overlay
  enfileira no clique (e mantém o sinal `TabAction` para diagnóstico/GNOME/futuro *Effect*); o
  `SyncWindows` **drena** a fila na própria resposta. **É a única exceção ao "daemon sem estado"**
  ([0016](0016-extensao-ponte-burra-render-no-daemon.md)) — e é deliberadamente contida: estado de UI
  **transitório** (cliques pendentes), **não** estado de janelas/layout, que continua vivendo na
  ponte. Sem a feature `wgpu-ui` não há produtor: a fila fica sempre vazia e o caminho de drenar é
  inerte.
- **A ponte KDE aplica as ações traduzindo TRANSPORTE → `internalId`** (via `transportToStable`/`byId`
  do retile corrente; lookup ausente = no-op defensivo, como o resto da ponte):
  - `activate` → `setActiveMember` + re-tila;
  - `ungroup` → `removeIdFromStacks` + re-tila (mesmo helper puro do GNOME);
  - `close` → `KWinWindow.closeWindow()`; o `windowRemoved` seguinte limpa o estado e re-tila sozinho.
- **Apresentação no KDE evolui** de "abas inativas minimizadas + troca dirigida por ativação"
  ([0018](0018-abas-atalhos-globais-drag-to-group.md)) para a **barra clicável real** (esquerdo na
  guia = ativar, "x" = fechar, direito = desagrupar). O 0018 **não** é revogado — aquela apresentação
  foi a paridade interina; este ADR a estende.
- **`wgpu-ui` permanece OFF por padrão; o release KDE a LIGA.** O `cargo test` (gate do
  [0012](0012-testes-isolados-por-plataforma.md)) roda sem a feature e sem GPU; a parte pura
  (`tabbar.rs`, conversões, serde de `pending_actions`) é coberta por testes. O **bind de hardware**
  está implementado em `layer.rs::run_event_loop` (uma `LayerSurface` `Overlay` por barra, ancorada no
  topo do quadrante; `wl_pointer` resolvido por `tabbar::hit_test`; barras alimentadas por um canal
  `tokio::watch` que só re-materializa superfícies quando o estado muda) sobre `smithay-client-toolkit`
  + `calloop`. Fora de uma sessão com `wlr-layer-shell` (Mutter/headless/CI) o `LayerShell::bind` falha
  e o loop **encerra gracioso**, então o binário é válido em qualquer ambiente. A `libwayland` é
  carregada em **runtime via `dlopen`** (feature `wayland-client/dlopen`), mantendo o CI/devcontainer
  **sem** dependência de build da `libwayland-client`. O `build-kde-release.sh` compila o daemon com
  `--features wgpu-ui` (o release GNOME não, pois o Mutter não tem layer-shell). Validação interativa
  real (clicar aba/X/desagrupar) é em hardware numa sessão KWin.
- **Texto das abas (título) via `glyphon`.** A barra rotula cada guia com o título da janela. O
  `caption` viaja da ponte no `windows_json` (`WindowDto.title`, `#[serde(default)]`); o daemon o
  reanexa às `tab_bars` (`TabBarDto.titles`, paralelo a `members`) — o **core continua sem conhecer
  título** (irrelevante ao layout). O `render_bar` desenha em dois passes: quads (faixa/guias/"x") e,
  por cima (`LoadOp::Load`), o texto com `glyphon` 0.6 (atlas de glifos compatível com o wgpu 22). O
  GNOME não usa (rotula na própria extensão a partir de `Meta.Window`), então **não** envia `title`.

## Consequências

- **Core ainda puro, ponte ainda dona do estado de janelas.** A única novidade de estado é a fila
  efêmera de UI no daemon — contida e justificada aqui. Reafirma 0002/0016.
- **Contrato espelhado em pontos novos:** `pending_actions` no `layout_json` (daemon `protocol.rs` +
  ponte KDE `bridge.ts`), `WindowDto.title` no `windows_json` (ponte KDE envia `win.caption`) e
  `TabBarDto.titles` no `layout_json`. Todos retrocompatíveis por `#[serde(default)]`/parse defensivo:
  daemon e pontes antigos ignoram os campos.
- **Limitação de latência registrada:** a ação chega no **próximo** `SyncWindows`. Na prática quase
  sempre coincide com atividade de janela (`close` → `windowRemoved`; `activate` → `windowActivated`;
  `ungroup` muda a geometria), então o atraso é imperceptível. Se latência zero virar requisito, o
  plano B é o KWin *Effect* (acesso pleno, sem o gargalo pull) — decisão e ADR próprios.
- **GNOME inalterado:** desenha e age na própria extensão (dentro do Mutter); não usa `pending_actions`
  nem a fila. O sinal `TabAction` segue disponível para diagnóstico.
