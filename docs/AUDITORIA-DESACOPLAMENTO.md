# Auditoria de Desacoplamento — Core/Daemon × Interface

> Relatório do Entregável 1 da refatoração de blindagem multiplataforma (junho/2026).
> Decisão correspondente: [rules/0029](../rules/0029-daemon-sem-framework-visual.md).
> Plano de execução: [docs/plans/auditoria-desacoplamento-daemon.md](plans/auditoria-desacoplamento-daemon.md).

## Objetivo

Varrer o core em Rust (`etherbit-tiling-core`) e o daemon compartilhado
(`etherbit-tiling-daemon`) à caça de **vazamentos de escopo**: lógica de interface (abas, tags,
renderização, widgets, captura de clique) acoplada ao "cérebro geométrico". A meta é um daemon que seja
**puramente um motor de geometria e colisões de slots**, expondo só estado geométrico bruto via um
contrato D-Bus agnóstico que GNOME (hoje) e KDE/macOS (futuro) consomem de forma independente.

## Veredito geral

A arquitetura já estava **~90% limpa**. O core não tem dependências, I/O nem D-Bus: recebe metadados de
janelas + áreas úteis e devolve retângulos. O `protocol.rs` é uma fronteira de DTOs JSON. Os
acoplamentos reais eram **poucos e concentrados** — listados abaixo com a classificação:

- **(A) Geometria legítima** → permanece no core.
- **(B) UI** → banida do daemon / migrada para a extensão.
- **(C) Borderline** → geométrico, mas com nome/semântica de UI → renomeado/documentado.

## Achados

| #   | Local                                  | Símbolo                                                                                                          | Classe | Problema                                           | Ação tomada                                         |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- | --------------------------------------------------- |
| 1   | `daemon/src/render.rs` (255 linhas)    | pipeline `wgpu` (shaders WGSL, `QuadRenderer`)                                                                   | **B**  | Renderização gráfica dentro do daemon              | **Arquivo deletado**                                |
| 2   | `daemon/src/layer.rs` (519 linhas)     | overlay `wlr-layer-shell` + event loop de pointer                                                                | **B**  | Superfícies Wayland + loop de eventos no daemon    | **Arquivo deletado**                                |
| 3   | `daemon/Cargo.toml`                    | feature `wgpu-ui` + 5 deps (`wgpu`, `smithay-client-toolkit`, `raw-window-handle`, `bytemuck`, `wayland-client`) | **B**  | Libs gráficas/Wayland atreladas ao core            | **Removidas**                                       |
| 4   | `daemon/src/service.rs`                | métodos `ShowDropHud`/`HideDropHud`, campo `hud_tx`, struct `Shared`                                             | **B**  | Verbos de UI no contrato D-Bus                     | **Removidos**; `serve()` devolve só a conexão       |
| 5   | `daemon/src/protocol.rs`               | `HudCellDto`, `parse_hud_cells`                                                                                  | **B**  | DTO/parse exclusivos do overlay wgpu               | **Removidos**                                       |
| 6   | `daemon/src/protocol.rs`               | `WindowDto.title`, `TabBarDto.titles`                                                                            | **B**  | Texto de aba (apresentação) trafegando no contrato | **Removidos** (GNOME usa `get_title()` local)       |
| 7   | `core/src/layout.rs`, `config.rs`      | `LayoutOptions.tab_bar_height` / `Config.tab_bar_height`                                                         | **C**  | Faixa geométrica com nome de widget                | **Renomeado** `group_header_px` (alias TOML legado) |
| 8   | `kwin-script/.../main.ts`, `bridge.ts` | `ShowDropHud`/`HideDropHud`, `serializeHudCells`, `HotZone.cells/hot`, `WindowSnapshot.title`                    | **B**  | Ponte KDE alimentando o overlay wgpu morto         | **Removidos**; preview vira `showOutline` nativo    |

### O que é geometria legítima e permaneceu (classe A)

- `core/src/layout.rs`: `StackDescriptor`, `StackGroup`, `TabBarRect`, `Node::Stack`, `render_stack*`,
  `compute_layout*`. O core calcula **onde** está cada slot (individual ou agrupado), o foco abstrato do
  grid e os mínimos elásticos em cascata. **Não** desenha, não conhece widgets, fontes, cores ou cliques.
- `protocol.rs`: `TabBarDto { stack_id, x, y, width, height, content, members, active }` — geometria pura
  da faixa de um grupo; **quem desenha algo nela é a extensão**.
- A configuração visual que o daemon apenas **persiste** (não renderiza) — `border_color`,
  `active_border`, `rounded_corners` — é armazenamento agnóstico de preferências, consumido pela camada
  nativa. Permanece.

## Contrato resultante (agnóstico, stateless)

O daemon expõe a interface `dev.ediano.etherbit.Tiling` com **apenas** geometria/config:

- **Geometria (request/response, sem estado):** `SyncWindows`, `ResolveDropZone`, `MoveWindow`,
  `ResizeWindow`.
- **Config (persistência + sinal):** `Ping`, `GetConfig`, `SetEnabled`, `SetGap`, `SetActiveBorder`,
  `SetIgnoreList`, `SetRoundedCorners`, `SetAutostart`, sinal `ConfigChanged`.

O **agrupamento de janelas** ("abas") viaja como a estrutura universal `StackDto { members, active }`
dentro do `state_json`/`tab_bars` — o equivalente de dados a `GroupWindow(id)`/`ActiveTab(id)`. O daemon
**não guarda estado**: recebe o snapshot da ponte e devolve geometria. Uma nova camada visual (abas no
KDE, port macOS) consome **essa mesma API matemática** sem alterar uma linha do core.

## Verificação

- `cargo tree -p etherbit-tiling-daemon | grep -E 'wgpu|wayland|smithay'` → **vazio**.
- `cargo test` (core + daemon), `pnpm test`/`typecheck` (GNOME e KDE) → **verdes**.
- `busctl --user introspect dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling` → **sem**
  `ShowDropHud`/`HideDropHud`.
