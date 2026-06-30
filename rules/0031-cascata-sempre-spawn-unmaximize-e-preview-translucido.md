# 0031 — Cascata sempre (sem floating), desmaximização no nascimento + histórico, e preview KDE translúcido

**Status:** ✅ Aceita
(emenda [0021](0021-tamanhos-minimos-geometry-hints.md) — remove o auto-float;
torna o Merge Fallback de [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md) **dormente**;
emenda [0029](0029-daemon-sem-framework-visual.md) — a camada visual do preview KDE volta para um
**helper nativo separado**, nunca o daemon de geometria; reafirma o ciclo de Unmaximize de
[0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md); reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md))
A invariante "cascata sempre, `Σ tracks == avail`, nunca overflow" foi emendada por
[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md): a track rígida recebe sempre ≥ seu mínimo,
tolerando overflow (deslocamento compensatório).

## Contexto

Três frentes de lapidação convergiram a partir de testes em sessão real:

1. **Auto-float quebrava a UX sob mínimos rígidos.** Quando um app de mínimo rígido (GNOME Software,
   Configurações do Sistema) nascia como 5ª+ janela num sub-quadrante do ciclo
   ([0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)), o split 50/50 não comportava o
   mínimo. O [0021](0021-tamanhos-minimos-geometry-hints.md) então **isolava** uma folha (auto-float)
   ou, no GNOME, a **agrupava em aba** (Merge Fallback do [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)).
   A UX desejada é outra: a janela **nova/invasora** sempre recebe seu mínimo real e **todo o grid se
   deforma elasticamente em cascata**, empurrando os vizinhos — **nunca** jogando ninguém para fora.
   Além disso, descobriu-se que a **saturação de tracks tinha um bug latente de SOBREPOSIÇÃO**
   (`solve_tracks` somava os mínimos crus e estourava o nó), até então **escondido** pelo auto-float
   (que podava antes de chegar ao caso degenerado) — e que o **viés da focada** prometido pelo
   [0021](0021-tamanhos-minimos-geometry-hints.md) **nunca fora implementado** no modelo de grid do
   [0026](0026-grid-fractal-3x3-elastico-e-hud.md).

2. **O modo Tiling não era soberano sobre a maximização.** Janelas podiam **nascer maximizadas** (o app
   pede tela cheia) e ficar fora do grid; e não havia garantia explícita de que maximizar/desmaximizar
   **manualmente** devolvesse a janela à posição/proporção originais.

3. **O preview do KDE perdera a translucidez.** O [0029](0029-daemon-sem-framework-visual.md) removeu o
   HUD wgpu do daemon e deixou o preview como `workspace.showOutline` nativo — um **contorno opaco**.
   O desejado é uma **máscara translúcida** (alpha 0.3–0.4). Um KWin _Script_ (QJSEngine) **não pinta
   superfícies próprias** (só `showOutline`), e um KWin _Effect_ scriptado só anima janelas existentes —
   translucidez real exige um **cliente Wayland próprio** (layer-shell).

## Decisão

### A) Cascata sempre, NUNCA flutuar (`core/src/layout.rs`)

- **Auto-float REMOVIDO.** `enforce_min_sizes` e `floating_rect` são deletados; `compute_constrained`
  passa a tilar a **árvore COMPLETA** (sem poda) e devolver `floating` **sempre vazio**. O campo
  `LayoutResult.floating`/`LayoutResultDto.floating` é **mantido congelado** no contrato (por
  retrocompatibilidade `#[serde(default)]`).
- **`solve_tracks` satura SEM sobrepor.** Quando `Σ mínimos > avail`, em vez de fixar cada track no
  mínimo cru (que estourava o nó), comprime **proporcionalmente** de modo que `Σ tracks == avail` —
  ladrilho perfeito, **zero sobreposição geométrica** (o clamp final por janela, abaixo do mínimo real,
  fica a cargo do compositor). Isso era **obrigatório**: sem o auto-float, o caso degenerado passou a
  ser caminho normal.
- **Viés da focada (novo).** A(s) track(s) cobertas pela célula que contém a janela **focada/nova**
  (`focused_priority_tracks` → `node_contains`) recebem, sob pressão, o **mínimo CHEIO**; as vizinhas
  cedem proporcionalmente. `geom_leaves_min` deixa de **ignorar** o `focused` que já recebia. A
  propagação **global** em sub-quadrantes profundos do ciclo emerge por composição (`min_extent` é
  recursivo: o mínimo de um sub-nó vira o `min` da track no nível pai, e cascateia para cima).
- **Pontes:** com `floating` sempre vazio, o auto-float (KDE) e o **Merge Fallback** (GNOME,
  [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)) **nunca disparam**. O caminho GNOME
  (`parseFloating`/`mergeFallback`/`_mergeAttempted`) fica **DORMENTE** como rede defensiva (se um
  daemon ANTIGO ainda emitir `floating`), documentado — sem churn. KDE: nenhuma mudança (o float só
  vinha via `floating` do daemon).

### B) Tiling soberano sobre a maximização (pontes GNOME e KDE)

- **Desmaximização no nascimento (spawn-unmaximize).** Com o Tiling ativo, uma janela que está
  maximizada e que o core **ainda não tilou** "nasceu maximizada" → a ponte aplica `unmaximize`
  (`Meta.Window.unmaximize` no GNOME; `KWinWindow.setMaximize?(false,false)` no KDE) para ela entrar na
  Distribuição Cíclica. Distingue-se "nasceu maximizada" de "maximização manual" por um conjunto
  `everTiled` (ids que o core já posicionou): só os **não-tilados** são desmaximizados no nascimento.
- **Histórico = a árvore persistente.** Uma janela **já tilada** que o usuário maximiza manualmente é
  **preservada**: `retain_tileable_when_maximized` mantém sua folha enquanto maximizada, e ao
  desmaximizar o relayout **reaplica o slot exato** (topologia + `ratio` reproduzem coords/proporção;
  os vizinhos voltam por cascata sem quebrar a árvore). A "memória do estado geométrico anterior" pedida
  **é o slot persistido** — não há estado paralelo. Coberto por
  `maximizar_manual_round_trip_preserva_vizinhos`.
- **Bug de init correlato (GNOME).** O one-shot de `size-changed` em `_onWindowCreated` só **trava**
  quando a janela já é **tileável** (`_isTileable`: tipo NORMAL + redimensionável + maximizável). Um
  `size-changed` precoce (apps que assentam o tamanho antes do tipo/flags, ex.: a Loja) **não queima** o
  gatilho — corrige a 1ª/2ª janela com **apps mistos** (Nautilus + Loja) não auto-organizando.

### C) Preview KDE translúcido num helper nativo separado (emenda ao [0029](0029-daemon-sem-framework-visual.md))

- **Por que um helper:** o KWin Script só expõe `showOutline`/`hideOutline` (contorno opaco) e o
  QJSEngine não tem QML/`Qt`/superfícies; um KWin Effect scriptado só anima janelas. Translucidez real
  (alpha 0.3–0.4) **exige um cliente Wayland próprio** (wlr-layer-shell). Ele **não** volta para o
  daemon de geometria (o [0029](0029-daemon-sem-framework-visual.md) segue valendo para o daemon): vive
  num **crate/binário SEPARADO** `etherbit-tiling-preview`.
- **Implementação:** o helper desenha **um** retângulo translúcido via **SHM** (buffer ARGB
  pré-multiplicado — sem GPU/shaders; um retângulo plano não precisa de wgpu) numa `LayerSurface`
  (camada Overlay, `exclusive_zone = -1`, reusada entre passos do drag). Expõe D-Bus
  `dev.ediano.etherbit.Preview` com `ShowPreview(x,y,w,h)`/`HidePreview()`. **Lazy-start por ativação
  D-Bus** (o 1º `ShowPreview` o sobe; fica ocioso fora do arrasto).
- **Ponte KDE:** `updateOutline` aciona **duas camadas** — `showOutline` nativo (fallback, sempre
  disponível) **e** `ShowPreview` no helper (translúcido), deduplicado por retângulo. Se o helper não
  estiver no barramento, a chamada é no-op e o outline cobre o caso. **Best-effort**, como os cantos
  arredondados do [0019](0019-arvore-bsp-persistente-resize-elastico.md): nunca quebra o tiling.
- **Empacotamento:** `build-kde-release.sh` compila e inclui `bin/etherbit-tiling-preview`;
  `install-kde.sh` instala o binário + o `.service` de ativação D-Bus; `uninstall-kde.sh` os remove.

## Consequências

- **Reafirma 0002/0016:** core puro decide a cascata; daemon sem estado; a apresentação (preview) vive na
  camada nativa. O helper de preview é um processo à parte — o **daemon de geometria segue sem framework
  visual** (0029 intacto para o daemon).
- **Contrato inalterado:** `compute_constrained` mantém a assinatura; `floating` permanece no DTO
  (congelado). D-Bus do daemon não muda. O helper tem **seu próprio** nome de barramento.
- **Testes:** `layout.rs` troca os casos de auto-float por "comprime, não flutua, sem sobreposição"
  (`min_inviavel_comprime_e_nao_floata`, `nunca_floata_mesmo_no_impossivel`,
  `focada_satura_no_min_vizinho_comprime`, `focada_mantem_min_demais_comprimem`,
  `solve_tracks_satura_proporcional_no_impossivel`, `cascata_global_em_quadrante_profundo`) e ganha
  `maximizar_manual_round_trip_preserva_vizinhos`; `protocol.rs` ajusta os `sync_*` (floating sempre
  vazio, rects presentes). GNOME/KDE: `typecheck`/`build`/vitest. A translucidez/alpha do helper e o
  spawn-unmaximize são **validados em sessão real** (hardware), como o resto da camada nativa.
- **Limitação registrada (caso físico impossível):** se o mínimo total estoura a tela, a cascata
  comprime todos (a focada com prioridade); o clamp final por janela é do **compositor** (pode haver
  sobreposição **visual**, nunca geométrica no layout). É o preço de "nunca flutuar".
- **Fora do escopo:** `platform-macos` (Swift). O core segue agnóstico; o helper de preview é **KDE-only**
  (layer-shell); o GNOME desenha seu próprio HUD com `St.Widget` dentro do Mutter.
