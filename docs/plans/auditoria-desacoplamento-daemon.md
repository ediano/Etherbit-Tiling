# Auditoria, Desacoplamento e Blindagem Multiplataforma do Daemon

> Plano aprovado em 2026-06-30. Execução prevista para começar amanhã.

## Contexto

O Etherbit Tiling tem um core agnóstico em Rust (`core`) + um daemon compartilhado
(`etherbit-tiling-daemon`) que serve GNOME e KDE via D-Bus. A auditoria pedida buscou
vazamentos de escopo: lógica de UI (abas, tags, render, widgets) acoplada ao core.

**Resultado da auditoria (Entregável 1):** a arquitetura já está ~90% limpa.

- O `core` é matemática pura (sem deps, sem I/O, sem D-Bus): calcula retângulos e a
  geometria de slots agrupados (`StackDescriptor`, `Node::Stack`, `TabBarRect`). **Tudo legítimo.**
- O `protocol.rs` é uma fronteira JSON de DTOs. **Limpo**, salvo campos vestigiais (ver abaixo).
- **O único framework visual dentro do daemon** é o HUD de preview via **wgpu + wlr-layer-shell**
  (`render.rs`, `layer.rs`, métodos D-Bus `ShowDropHud`/`HideDropHud`, canal `hud_tx`). Já está
  atrás da feature opcional `wgpu-ui` (desligada por padrão), mas viola a regra "o daemon nunca
  deve instanciar elementos visuais". Foi introduzido pelo **ADR 0016** (render no daemon).
- Campos de **apresentação** vazaram para o contrato: `WindowDto.title` e `TabBarDto.titles`.
  São vestígios da barra wgpu clicável do KDE (removida no ADR 0028). O GNOME **não os usa** —
  pega o título localmente via `window.get_title()` em [extension.ts:1117](../../platform-linux-gnome/extension/src/extension.ts#L1117).

**Decisões aprovadas pelo usuário:**

1. **HUD wgpu → remover totalmente.** KDE passa a usar o `workspace.showOutline()` nativo (já existe
   como fallback). GNOME desenha em `St.Widget` (não afetado).
2. **Contrato → limpeza completa.** Remover `title`/`titles`; renomear `tab_bar_height` para nome
   geométrico; documentar DTOs como geometria pura.
3. **Modelo IPC → manter stateless + JSON universal.** Formalizar `StackDto {members, active}` como o
   contrato universal de agrupamento (equivale a `GroupWindow`/`ActiveTab`). Sem redesenho stateful.

**Resultado pretendido:** daemon-core = motor puramente geométrico, sem nenhuma referência a wgpu/
wayland/widgets; contrato D-Bus expõe só geometria bruta; GNOME (hoje) e KDE/macOS (futuro) consomem a
mesma API sem que o core mude uma linha.

---

## Entregável 2 — Remover o framework visual do daemon (wgpu)

Apagar/limpar todo o pipeline wgpu + layer-shell. Arquivos:

- **Deletar** `etherbit-tiling-daemon/daemon/src/render.rs` e
  `etherbit-tiling-daemon/daemon/src/layer.rs` (100% UI).
- `etherbit-tiling-daemon/daemon/Cargo.toml`: remover a feature `wgpu-ui` (linhas 6–17) e as
  5 deps opcionais: `wgpu`, `smithay-client-toolkit`, `raw-window-handle`, `bytemuck`, `wayland-client`.
- `etherbit-tiling-daemon/daemon/src/main.rs`: remover os `#[cfg(feature = "wgpu-ui")] mod
layer/render`, o bloco `render::init_render()`, o spawn de `layer::run_event_loop`, e o uso de `shared`
  (linhas 10–16, 35–53, 56–59, 72–85). O `serve` passa a devolver só a conexão.
- `etherbit-tiling-daemon/daemon/src/service.rs`: remover o campo `hud_tx` (L30–33), os
  métodos `show_drop_hud`/`hide_drop_hud` (L243–266), o `import use tokio::sync::watch` (L16–17), a struct
  `Shared` + os canais em `serve()` (L315–344). `serve()` passa a retornar `zbus::Connection`.
- `etherbit-tiling-daemon/daemon/src/protocol.rs`: remover `HudCellDto` (L640) e
  `parse_hud_cells()` (L649).

## Entregável 3 — Limpeza completa do contrato (DTOs como geometria pura)

- `etherbit-tiling-daemon/daemon/src/protocol.rs`: remover `WindowDto.title` (L41),
  `TabBarDto.titles` (L211) e toda a plumbing de títulos (L353, L495, L566–569) + o teste
  `sync_attaches_titles_to_tab_bar` (L805–817).
- **Renomear `tab_bar_height` → `group_header_px`** (geométrico: faixa reservada no topo do slot
  agrupado; segue legítimo pois o GNOME usa abas). Tocar:
  `core/src/layout.rs` (struct `LayoutOptions` L66–73 + usos L902/943/1069 + ~18
  literais de teste), `etherbit-tiling-daemon/daemon/src/config.rs` (campo L36, default L54,
  testes), e `etherbit-tiling-daemon/daemon/src/service.rs` (L43). Manter a chave TOML
  retrocompatível via `#[serde(alias = "tab_bar_height")]` para não quebrar configs já no disco.
- Documentar no topo de `protocol.rs` que os DTOs carregam **apenas geometria** e que o agrupamento viaja
  como `StackDto {members, active}` (universal, agnóstico de plataforma).

## Ajustes nas plataformas (consumo do HUD)

- **KDE** `platform-linux-kde/kwin-script/contents/code/main.ts`: remover as chamadas
  `callDBus(..., 'ShowDropHud', ...)` (L613) e `'HideDropHud'` (L626) e o estado `lastHudKey`
  (L128/548/607–608/627). **Manter** o `workspace.showOutline()`/`hideOutline()` (L516/519/624) — vira o
  único HUD. `platform-linux-kde/kwin-script/contents/code/bridge.ts`: remover
  `serializeHudCells` (L309) + comentários (L175/306) e atualizar o teste correspondente.
- **GNOME**: o contrato XML em `platform-linux-gnome/extension/src/dbus.ts` **não** declara
  `ShowDropHud`/`HideDropHud` (confirmado) — nenhuma mudança de XML. Remover apenas o campo `titles` da
  interface `TabBar` e do parser em `platform-linux-gnome/extension/src/bridge.ts` (L62–87,
  L150–185) e ajustar os testes que o referenciam. O HUD do GNOME (`St.Widget`) e as abas seguem intactos.

## Documentação (Entregáveis 1 e 3) — regra de ouro dos ADRs

- **Criar `rules/0029-daemon-sem-framework-visual.md`** (Status: ✅ Aceito): registra core puramente
  geométrico, remoção do wgpu do daemon, HUD nativo (showOutline/St.Widget), contrato só-geometria, e o
  mapeamento `StackDto {members,active}` como API universal de agrupamento para portabilidade (KDE/macOS).
- **Emendar** `rules/0016-extensao-ponte-burra-render-no-daemon.md` e a parte de HUD de
  `rules/0026-grid-fractal-3x3-elastico-e-hud.md` → Status `🔄 Render wgpu removido por [0029]`
  (decisões mudam de status, não são apagadas).
- Atualizar o índice `rules/README.md`.
- **Criar `docs/AUDITORIA-DESACOPLAMENTO.md`** (Entregável 1): relatório com a tabela de achados
  (onde a UI estava acoplada, classificação A/B, ações tomadas).

## Verificação (end-to-end)

1. **Daemon:** `cargo build` e `cargo test` na raiz e em `etherbit-tiling-daemon/` — sem a feature
   `wgpu-ui` não deve existir mais; o binário não linka wgpu/wayland. `cargo tree -p
etherbit-tiling-daemon | grep -E 'wgpu|wayland|smithay'` deve vir **vazio**.
2. **Contrato:** `busctl --user introspect dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling` não
   deve listar `ShowDropHud`/`HideDropHud`.
3. **Plataformas:** `pnpm test` em `platform-linux-gnome/extension/` e
   `platform-linux-kde/kwin-script/` (vitest, isolados — ADR 0012).
4. **Funcional (manual):** GNOME — abas/merge e HUD `St.Widget` seguem funcionando; KDE — drag-to-tile
   mostra o outline nativo e aplica split 50/50 / swap no centro.
