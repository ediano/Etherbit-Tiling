# 0029 — Daemon sem framework visual: HUD nativo e core puramente geométrico

**Status:** ✅ Aceita
(estende [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md);
encerra a renderização `wgpu` no daemon iniciada em [0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md)/[0025](0025-barra-abas-clicavel-kde-entrega-por-pull.md))

## Contexto

Uma auditoria de desacoplamento (ver [docs/AUDITORIA-DESACOPLAMENTO.md](../docs/AUDITORIA-DESACOPLAMENTO.md))
buscou vazamentos de escopo entre o **core/daemon** e a **interface**. Resultado: a arquitetura já estava
~90% limpa — o `etherbit-tiling-core` é matemática pura e o `protocol.rs` é uma fronteira de DTOs. Os
únicos acoplamentos remanescentes:

1. **Um framework visual dentro do daemon.** O HUD de preview do KDE era desenhado pelo PRÓPRIO daemon
   com **`wgpu` + `wlr-layer-shell`** (`render.rs`, `layer.rs`, métodos D-Bus `ShowDropHud`/`HideDropHud`,
   canal `hud_tx`), atrás da feature opcional `wgpu-ui`. Mesmo desligado por padrão, isso punha pipeline
   gráfico (shaders WGSL, surfaces Wayland, event loop de pointer) no "cérebro geométrico", contrariando
   a regra "o daemon nunca instancia elementos visuais" e atrelando o core a libs específicas de Linux —
   um peso morto para a portabilidade (macOS não tem `wlr-layer-shell`).
2. **Campos de apresentação no contrato.** `WindowDto.title` e `TabBarDto.titles` viajavam no D-Bus
   apenas para rotular a barra wgpu clicável do KDE — já removida no [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md).
   O GNOME nunca os consumiu (lê o título via `window.get_title()` na própria extensão).
3. **Nome de UI num parâmetro geométrico.** `LayoutOptions.tab_bar_height` descrevia uma faixa que é
   **puramente geométrica** (espaço reservado no topo de um slot agrupado), mas o nome sugeria desenho.

## Decisão

### O daemon não contém NENHUM framework visual

- **Removidos** `render.rs` e `layer.rs`, a feature `wgpu-ui` e as 5 deps opcionais (`wgpu`,
  `smithay-client-toolkit`, `raw-window-handle`, `bytemuck`, `wayland-client`). O daemon volta a ser
  **só** zbus + tokio + serde: um motor de geometria e colisões de slots, sem GPU/Wayland.
- **Removidos** os métodos D-Bus `ShowDropHud`/`HideDropHud`, o canal `hud_tx`/`Shared` e
  `protocol::HudCellDto`/`parse_hud_cells`. O contrato deixa de ter qualquer verbo de UI.
- **O HUD de preview é 100% da camada nativa.** KDE usa o primitivo nativo
  `workspace.showOutline(rect)`/`hideOutline()` (já era o fallback); GNOME segue desenhando suas
  células com `St.Widget` dentro do Mutter. A matemática da zona (`resolveHotZone`) permanece um módulo
  puro espelhado na ponte ([0026](0026-grid-fractal-3x3-elastico-e-hud.md)/[0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md)).

### O contrato D-Bus carrega APENAS geometria

- **Removidos** `WindowDto.title`, `TabBarDto.titles` e a plumbing de títulos no daemon e nas pontes
  (GNOME nunca os lia; KDE não tem abas). O rótulo da aba é responsabilidade exclusiva da extensão.
- **`tab_bar_height` → `group_header_px`** em `LayoutOptions` e na `Config`. É um parâmetro geométrico:
  o core desconta a faixa do slot agrupado; **quem (e se) desenha algo nela é a camada nativa**. A chave
  TOML aceita o nome legado via `#[serde(alias = "tab_bar_height")]` (configs no disco não quebram).

### Agrupamento como contrato universal e stateless (blindagem para KDE/macOS)

- O estado de agrupamento ("abas") viaja como a estrutura **universal e agnóstica** `StackDto { members,
  active }` (no `state_json`/`tab_bars`), que é o equivalente de dados a `GroupWindow(id)`/`ActiveTab(id)`.
  O **daemon permanece sem estado**: recebe o snapshot da ponte e devolve geometria.
- Qualquer nova camada visual (reintrodução de abas no KDE, ou um port macOS) consome **essa mesma API
  matemática** para desenhar a interface, **sem alterar uma linha do core**. A apresentação (criar abas,
  desenhar guias, estilizar tags, botões de fechar, captura de clique) é **exclusiva da extensão**.

## Consequências

- **Core agnóstico de fato:** `cargo tree -p etherbit-tiling-daemon` não lista mais `wgpu`/`wayland`/
  `smithay`. O daemon fica mais leve, o build não toca GPU/libwayland e o produto fica portável por
  contrato (reafirma [0002](0002-arquitetura-core-agnostico.md)).
- **Paridade preservada:** GNOME mantém abas/merge e seu HUD `St.Widget`; KDE mantém tiling puro com
  preview por outline nativo e swap no centro ([0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md)).
  "Diferença de apresentação aceita" do [0016](0016-extensao-ponte-burra-render-no-daemon.md) segue valendo.
- **Reverte o "render no daemon" do título do 0016** para o caso do HUD: a renderização do daemon via
  `wgpu` (que o 0016 reservava às janelas próprias e o 0022/0025 usaram para a barra do KDE) deixa de
  existir. O 0016 é **emendado**, não revogado — "ponte burra + core puro + daemon sem estado" continua.
- **Painel de config próprio do daemon (futuro):** se um dia o daemon precisar de UI própria, será um
  **binário/crate separado** consumindo este mesmo contrato — nunca dentro do daemon de geometria.
- **Fora do escopo:** `platform-macos` (Swift). O core continua agnóstico; o consumo macóS deste
  contrato é trabalho futuro no host.
