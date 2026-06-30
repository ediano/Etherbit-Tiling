# 0039 — Abas visuais e interativas no KDE via helper de overlay (paridade com o GNOME)

**Status:** ✅ Aceita
(reverte o "KDE sem abas" do [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md) — as abas voltam ao KDE,
agora **visíveis e clicáveis**; emenda o [0029](0029-daemon-sem-framework-visual.md)/[0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md)
— o helper nativo `etherbit-tiling-preview` ganha um **segundo papel** (barras de abas + ponteiro), sem
trazer framework visual de volta ao **daemon de geometria**; reafirma o
[0016](0016-extensao-ponte-burra-render-no-daemon.md)/[0013](0013-camada-kde-kwin-script.md): o KWin
Script é uma ponte burra que **não pinta nem captura ponteiro**)

## Contexto

O KDE agrupa janelas numa mesma célula (stacks via Merge Fallback / drag) e **minimiza as inativas sem
nenhum feedback visual** — o "comportamento fantasma": janelas somem atrás de um título invisível. O
[0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md) tornara o KDE "tiling puro" e removera a barra
clicável; o [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md) reintroduziu os **stacks de
dados** no KDE (sob overflow), mas **sem UI** — o que materializou o fantasma. Queremos **paridade com o
GNOME**: barra de abas visível por grupo, com título, troca de aba no clique, botão "x" por aba e
desagrupar no clique direito.

**Restrição que governa o desenho da solução:** um KWin _Script_ (QJSEngine) **não pinta superfícies
próprias nem captura eventos de ponteiro** — só `showOutline`/`hideOutline`, manipulação de janelas e
`callDBus` **fire-and-forget** (sem assinar sinais D-Bus, sem timers). Isso já estava registrado no
[0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) ("o QJSEngine não tem
QML/`Qt`/superfícies"). A barra clicável que existiu foi desenhada com **wgpu dentro do daemon** e
removida de propósito ([0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md)/[0029](0029-daemon-sem-framework-visual.md)).
Portanto, "renderizar abas em QML no script do KWin" é **inviável**; a renderização interativa no KDE
exige um **cliente Wayland próprio** (layer-shell) — exatamente o que o helper de preview
([0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md)) já é.

## Decisão

### A) O helper `etherbit-tiling-preview` ganha o papel de barra de abas

O processo nativo separado (`etherbit-tiling-daemon/preview/`, wlr-layer-shell + SHM, sem GPU) passa a
desenhar **também** as barras de abas e a capturar o ponteiro sobre elas. **Nada disso volta para o
daemon de geometria** — o [0029](0029-daemon-sem-framework-visual.md) segue valendo para o daemon. O
**core não muda**: ele já produz `TabBarRect`/`tab_bars` (faixa + membros + ativa, geometria pura).

- **Render (SHM):** uma `LayerSurface` (camada `Overlay`, `exclusive_zone = -1`) **por barra**, ancorada
  na geometria vinda do core. Reproduz o visual Nord do GNOME (fundo `#2e3440`, aba ativa `#5e81ac`,
  texto `#eceff4`/`#d8dee9`, "x" à direita). Largura por aba = `faixa / nº de membros`. A superfície do
  **preview** mantém input region **vazia** (click-through); as das **abas** recebem ponteiro.
- **Texto:** rasterização por software com `ab_glyph` (Rust puro, sem libs de sistema — compatível com o
  devcontainer, [0004](0004-docker-centralizado.md)). A fonte é **carregada em runtime** de caminhos
  padrão do Linux (DejaVu/Noto/Liberation), com degradação graciosa: **sem fonte → abas sem rótulo**
  (ainda funcionais). Optou-se por runtime em vez de `include_bytes!` para **não versionar um blob de
  fonte** no repo; sistemas KDE sempre têm uma fonte sans. Títulos CJK/emoji podem cair para caixa/elipse
  (limitação aceitável v1).
- **Hit-test:** portado do `tabbar.rs` legado (puro e testado): esquerdo no "x" → **Close**; esquerdo no
  corpo → **Activate**; direito → **Context (Desagrupar)**.

### B) Laço de ações helper → KWin Script (DrainTabActions + kglobalaccel)

Como o KWin Script não assina sinais nem tem timers, o retorno do clique usa **pull com gatilho**:

1. O helper enfileira a ação do clique (`{stack_id, member_id, kind}`) e expõe, na **segunda interface
   D-Bus** `dev.ediano.etherbit.Tabs` do mesmo processo, `DrainTabActions() → json`.
2. Logo após enfileirar, o helper chama `org.kde.kglobalaccel` `/component/kwin`
   `invokeShortcut("etherbit-tiling-tab-action")` para **acordar** o KWin Script.
3. O KWin Script registra esse atalho **oculto** (sem tecla) cujo callback **drena** as ações e as
   aplica: `activate` → `setActiveMember` + reativa a janela + retile; `close` → `closeWindow()`;
   `ungroup` → `removeIdFromStacks` + retile (o **core reinsere** a janela no grid cíclico via
   `reconcile`/`insert_cyclic`).

> **Risco/validação (hardware):** que `invokeShortcut` acorde um atalho registrado por KWin Script é o
> ponto a validar em sessão KDE real. Sem isso, o fallback é o KWin Script drenar de forma **oportunista**
> em eventos de janela (responsividade menor). O helper sempre **degrada gracioso** fora de uma sessão
> layer-shell (CI/headless → no-op), como o preview.

### C) Contrato D-Bus do helper (interface `Tabs`, no mesmo binário)

- `ShowTabs(tabs_json: s)` — o KWin Script publica **todas** as barras: por barra `{stack_id, x, y, w, h,
tabs:[{member_id, title, active}]}`. O **título** vem do KWin Script (`win.caption`) — o contrato do
  **daemon** segue **sem títulos** ([0029](0029-daemon-sem-framework-visual.md)).
- `HideTabs()` — limpa todas as barras.
- `DrainTabActions() → s` — devolve e esvazia a fila JSON de ações.

A interface `dev.ediano.etherbit.Preview` (`ShowPreview`/`HidePreview`) é mantida intacta. IDs viajam como
**string** no contrato com o KWin ([0009](0009-nomenclatura-dbus-uuid.md)); dentro do helper são `u64`.

### D) Drag-to-group no KDE (center = merge), revertendo o center=swap do 0028

No drop sobre o **miolo central** de uma janela (`center`/`local`), o KWin Script passa a **agrupar** as
duas em aba (`addToStack`), espelhando o intercepto do GNOME (que nunca manda `center` ao core) — em vez
do `swap` do [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md). Opcional, por paridade: atalho **Meta+S**
(`toggleStackGroup`) para agrupar/desagrupar o quadrante. Os helpers de stack (`addToStack`,
`removeIdFromStacks`, `setActiveMember`, `parseTabBars`) **já existem** no bridge do KDE (re-adicionados
pelo [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)).

## Consequências

- **Reafirma 0002/0016/0029:** core puro decide a geometria das barras (`TabBarRect`); o **daemon de
  geometria segue sem framework visual**; a apresentação vive na camada nativa (aqui, o helper). O KWin
  Script continua ponte burra.
- **Paridade GNOME ⇄ KDE:** ambos passam a ter abas clicáveis (o GNOME desenha com `St.Widget` no Mutter;
  o KDE, com o helper layer-shell). A "diferença de apresentação aceita" do
  [0016](0016-extensao-ponte-burra-render-no-daemon.md) segue valendo (mecanismos distintos, UX igual).
- **Contrato do daemon inalterado.** Toda a novidade é interface **própria** do helper (`Tabs`) + lógica
  no KWin Script. `Cargo.lock` do workspace `etherbit-tiling-daemon` ganha `ab_glyph` (+ serde no
  `preview`).
- **Dependência nova no helper:** `ab_glyph` (Rust puro) e `serde`/`serde_json` no crate `preview`.
- **Testes:** o módulo de hit-test/layout de abas do helper é **puro e testado** (port do `tabbar.rs`);
  o KWin Script cobre a montagem do JSON de `ShowTabs` e o `applyTabActions` como módulos puros
  (`bridge.test.ts`, padrão [0012](0012-testes-isolados-por-plataforma.md)). Render, ponteiro,
  `invokeShortcut` e a fonte são **validados em sessão real** (hardware), como o resto da camada nativa.
- **Fora do escopo:** `platform-macos` (Swift) — o core segue agnóstico; o helper é KDE-only
  (layer-shell). Ícone de app por aba (o GNOME mostra; a diretiva pede só o título) fica para v2.
