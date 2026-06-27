# 0010 — Tooling da extensão (Vite/ESM) e D-Bus puro com zbus

**Status:** ✅ Aceita

## Contexto
A extensão alvo GNOME 45+ usa ESM (`gi://`, `resource:///`) resolvido em runtime pelo GJS
(SpiderMonkey). O daemon precisa falar D-Bus. Faltava fixar **como** a extensão é compilada (Vite)
e **como** o daemon implementa D-Bus, evitando armadilhas (bundlar módulos do Shell; FFI desnecessário).

## Decisão
- **Build da extensão com Vite em modo *library*, saída ESM única `extension.js`.** Os specifiers
  `gi://*`, `resource:///*` (e os builtins `system`/`gettext`) são marcados como **externos** por
  regex e **nunca** bundlados — permanecem literais no bundle. `minify: false` para não manglar
  nomes de classe usados por `GObject.registerClass`. Alvo `firefox115` (SM 115+, ES2022).
- **Tipos via `@girs/*` numa única geração ESTÁVEL e coerente.** `@girs/gnome-shell@48.0.4` fixa a
  baseline (GNOME 48, dentro da faixa suportada 45–48) e os pacotes de lib (`gobject-2.0`, `gio-2.0`,
  `glib-2.0`, `st-16`, `meta-16`, `clutter-16`, `shell-16`, `gjs`) são pinados em **versão exata** na
  geração estável **`-4.0.4`** (sem `alpha`/`beta`/`rc`). São apenas `devDependencies` (não vão no
  bundle). `@girs/shell-16` entra explicitamente (devDep + `tsconfig.json` `types`) porque a
  declaração ambiente de `global: Shell.Global` (`@girs/gnome-shell/extensions/global`) depende dele.
  - **Por que pin exato + overrides:** o esquema de versão dos `@girs` (`X.Y.Z-4.0.W`) confunde o
    caret do semver, e os ranges pré-lançamento do próprio `@girs/gnome-shell` faziam o pnpm resolver
    **várias gerações simultâneas** (`beta.36`/`beta.40`/`rc.17`/`4.0.4`). Isso quebra a **identidade
    de tipos** (ex.: `Shell.Global` deixa de casar e `global` colapsa para `globalThis`, falhando o
    `tsc`). A solução é pinar exato as libs declaradas e forçar **todo** o grafo transitivo `@girs/*`
    na geração `-4.0.4` via `overrides` no `pnpm-workspace.yaml`.
- **`tsc --noEmit` só faz type-check;** o build é do Vite. `pnpm run typecheck` e `pnpm run build`.
- **D-Bus no daemon com `zbus` puro (sem `libdbus-1-dev`).** A `zbus` fala o protocolo D-Bus em
  Rust, dispensando a FFI `libdbus`. Usamos a feature `tokio` para alinhar o runtime async, a macro
  `#[interface]` (zbus 5) e `serde`/`toml`/`directories` para persistência.

## Consequências
- O `libdbus-1-dev`/`pkg-config` no `docker/Dockerfile.core` deixou de ser estritamente necessário
  para o daemon. Mantido por ora (não faz mal); pode ser removido num passo futuro — registrar aqui
  se/quando for.
- Os números de versão dos `@girs/*` (geração) precisam evoluir juntos; ao subir
  `@girs/gnome-shell`, reavaliar as libs pinadas.
- Build reprodutível e instalável: `pnpm run install:ext` compila e copia para a pasta local de
  extensões. No Wayland, recarregar exige logout/login (ver [DESENVOLVIMENTO.md](../docs/DESENVOLVIMENTO.md)).
