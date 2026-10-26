# Guia de Desenvolvimento

O ambiente de desenvolvimento do **core (Rust)** e da **extension (TypeScript/Vite)** é totalmente
isolado em um **VS Code Dev Container**. O build do **macOS (Swift)** acontece no **host macOS**.

## Pré-requisitos

- [Docker](https://www.docker.com/) em execução.
- [VS Code](https://code.visualstudio.com/) com a extensão **Dev Containers** (`ms-vscode-remote.remote-containers`).
- Para a camada macOS: um **Mac com Xcode** (o SDK da Apple não roda no container).

## Subindo o Dev Container

1. Abra a pasta do projeto no VS Code.
2. Aceite **"Reopen in Container"** (ou Command Palette → _Dev Containers: Reopen in Container_).

O que o container provê:

- Imagem base **`mcr.microsoft.com/devcontainers/rust:1`** (definida em
  [`docker/Dockerfile.core`](../docker/Dockerfile.core)), com `build-essential`, `libdbus-1-dev` e
  `pkg-config` para a comunicação D-Bus do daemon Linux.
- **Feature Node** (`ghcr.io/devcontainers/features/node:1`) para o TypeScript/Vite da extensão.
- **pnpm** habilitado via corepack no `postCreateCommand`, que também roda `pnpm install` na raiz
  (instala o dev-tooling de lint/format e ativa o hook de pre-commit).
- Extensões do VS Code pré-instaladas: `rust-analyzer`, `even-better-toml`, `eslint`, `prettier`.

> A configuração fica em [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json), que
> aponta o build para `../docker/Dockerfile.core` (Docker centralizado em `docker/`).

## Lint e formatação (global)

O estilo de **todo o repositório** é padronizado por **Prettier** (formatação) + **ESLint** (lint),
orquestrados por um `package.json` na **raiz** (ver [rules/0036](../rules/0036-padrao-lint-format-global.md)).
O Rust segue no `rustfmt` (integrado por conveniência); cada subprojeto JS/TS mantém seu próprio
`package.json`/lockfile (a raiz **não** é um pnpm workspace).

```bash
# na raiz do repo
pnpm install        # instala o tooling e ativa o hook de pre-commit (lefthook)
pnpm format         # Prettier --write em tudo (+ cargo fmt nos dois workspaces Rust)
pnpm run format:check  # só verifica (é o que o CI roda)
pnpm lint           # ESLint em todo JS/TS
pnpm run lint:fix   # ESLint --fix
```

O hook de **pre-commit** (lefthook) reformata/linta apenas os arquivos _staged_ e os re-staga, então
o commit já entra no padrão. O CI tem um job `lint` (`prettier --check` + `eslint`) que barra PRs e
releases fora do padrão.

> **Shell fish:** lembre que `pnpm format` invoca scripts encadeados com `&&` internamente (rodam em
> `sh`, não no seu fish) — chamar `pnpm format` direto funciona normalmente.

## Core e Daemon (Rust) — builds isolados

São **dois workspaces Cargo independentes** (ver [rules/0003](../rules/0003-monorepo-poliglota.md)).

**Core (workspace raiz, agnóstico):**

```bash
cargo build         # compila etherbit-tiling-core
cargo test          # testes do core
```

**Daemon Linux (workspace próprio, compartilhado por GNOME/KDE):**

```bash
cd etherbit-tiling-daemon
cargo build                          # compila etherbit-tiling-daemon (puxa etherbit-tiling-core por path)
cargo run -p etherbit-tiling-daemon  # sobe o serviço D-Bus dev.ediano.etherbit.Tiling no barramento de sessão
```

O daemon registra a interface D-Bus `dev.ediano.etherbit.Tiling` (ver
[rules/0009](../rules/0009-nomenclatura-dbus-uuid.md)) e fica em background até `Ctrl-C`. Ele exige um
**barramento de sessão** ativo: num host GNOME real isso já existe; no Dev Container use
`dbus-run-session -- cargo run -p etherbit-tiling-daemon` (instale `dbus` se necessário). Inspecione e
exercite com `busctl --user`:

```bash
busctl --user introspect dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling
busctl --user call dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling dev.ediano.etherbit.Tiling SetGaps uu 8 12
busctl --user call dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling dev.ediano.etherbit.Tiling GetConfig
```

A config persiste em `~/.config/etherbit-tiling/config.toml`; o autostart gerencia
`~/.config/autostart/etherbit.tiling@ediano.dev.desktop`. O daemon consome `etherbit-tiling-core` por path
(`../../core`), então seu build valida a integração com o core mesmo estando em outro workspace.

## Extension GNOME (TypeScript + Vite)

A extensão usa **pnpm** (habilitado via corepack no container):

```bash
cd platform-linux-gnome/extension
pnpm install
pnpm typecheck      # checagem de tipos (tsc --noEmit)
pnpm build          # dist/extension.js (loader estável) + dist/main.js (impl versionada)
pnpm run install:ext  # build + copia para ~/.local/share/gnome-shell/extensions/etherbit.tiling@ediano.dev/
```

O build usa Vite em modo _library_ mantendo `gi://`/`resource:///` literais (ver
[rules/0010](../rules/0010-tooling-extensao-e-zbus.md)). O UUID é `etherbit.tiling@ediano.dev`.

> **Shell fish:** encadeie comandos com `; and` em vez de `&&`. Ex.: `corepack enable; and pnpm --version`.

### Recarregar no Wayland

O GNOME Shell **não** recarrega extensões com `Alt+F2` `r` no Wayland (isso é só X11). Para contornar,
o `extension.js` é um loader estável que troca a impl ao vivo (ver [rules/0071](../rules/0071-update-sem-logout-hot-reload.md)):

- **Sessão real:** `pnpm run install:ext` recarrega a extensão **sem logout**. Logout é necessário só
  na primeira instalação ou quando `src/loader.ts`/`metadata.json` mudam (o script avisa).
- **Loop de dev:** rode um Shell **aninhado** isolado, sem derrubar sua sessão:
  ```bash
  dbus-run-session -- gnome-shell --nested --wayland
  ```
  Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. Console interativo: `Alt+F2` → `lg` (Looking Glass).

> O Dev Container compila e empacota a extensão, mas **não roda o GNOME Shell**. A execução/teste de
> runtime (indicador, eventos de janela, D-Bus) acontece num host GNOME 45+ sob Wayland.

## KWin Script KDE (TypeScript + Vite)

A camada KDE (Plasma 6 / **Wayland**) entrega apenas o **KWin Script**; o daemon é o mesmo do GNOME
(ver [rules/0013](../rules/0013-camada-kde-kwin-script.md) e [rules/0014](../rules/0014-daemon-linux-compartilhado.md)).
Usa **pnpm** (corepack) e espelha o tooling da extension, mas com bundle **IIFE** (o QJSEngine do KWin
não tem `import`/`export` em runtime):

```bash
cd platform-linux-kde/kwin-script
corepack enable
pnpm install
pnpm typecheck            # checagem de tipos (kwin-globals.d.ts)
pnpm test                 # vitest sobre os módulos puros (config.ts, tiling.ts)
pnpm build                # gera contents/code/main.js (IIFE)
pnpm run install:script   # build + kpackagetool6 -i/-u + habilita + qdbus reconfigure
```

### Aplicar no Wayland

`kpackagetool6 --type=KWin/Script -i .` instala em `~/.local/share/kwin/scripts/etherbit-tiling/`;
`kwriteconfig6 --file kwinrc --group Plugins --key etherbit-tilingEnabled true` habilita; e
`qdbus6 org.kde.KWin /KWin reconfigure` recarrega **sem logout** (substitui o `Alt+F2 r`, que é só X11).
Config: _Configurações do Sistema → KWin Scripts → Etherbit Tiling (⚙)_.
Logs: `journalctl -f QT_CATEGORY=kwin_scripting` (ou `QT_LOGGING_RULES="kwin_*.debug=true"`).

> O Dev Container compila/testa o KWin Script, mas **não roda o KWin**. O teste de runtime (geometria,
> eventos de janela, D-Bus) acontece numa sessão **KDE Plasma 6 sob Wayland**.

## Web (landing page global)

O módulo `web/` é a landing page única e agnóstica (hub de downloads), em **Vite + HTML5/CSS3 puro**
(ver [rules/0011](../rules/0011-web-landing-vite-css-puro.md)). Usa **pnpm**:

```bash
cd web
pnpm install
pnpm dev        # servidor de desenvolvimento Vite
pnpm build      # bundle estático em dist/ (HTML + CSS minificado, sem CDN)
pnpm preview    # serve o build de produção localmente
```

> **Regra estrita:** zero recursos externos em runtime (sem Tailwind/CDN; fontes via `system-ui`).
> **Deploy:** produção na **Vercel** (https://etherbit-tiling.vercel.app/); `base: '/'` em
> `vite.config.js`. Os downloads usam assets de Release do GitHub (`releases/latest/download/…`);
> `og-image.png` ainda é placeholder até haver o asset real.

## Plataforma macOS (Swift)

Os arquivos em [`platform-macos/`](../platform-macos/) ficam **visíveis e editáveis** dentro do
container (como texto), mas **o build é feito no host macOS** com Xcode/SwiftPM, pois dependem do
AppKit e da Accessibility API da Apple.

## Checklist de verificação

1. **Container builda** após "Reopen in Container" (libdbus/pkg-config instalados).
2. `cargo build` na raiz compila `etherbit-tiling-core` sem erros.
3. Em `etherbit-tiling-daemon/`, `cargo build` compila `etherbit-tiling-daemon`; com um barramento de
   sessão (`dbus-run-session`), `cargo run -p etherbit-tiling-daemon` registra `dev.ediano.etherbit.Tiling`.
4. Na `extension/`, `pnpm install`, `pnpm typecheck` e `pnpm build` concluem; `dist/extension.js`
   preserva os imports `gi://`/`resource:///`.
5. Em `platform-linux-kde/kwin-script/`, `pnpm install`, `pnpm typecheck`, `pnpm test` e `pnpm build`
   concluem; `contents/code/main.js` é IIFE (sem `import`/`export` de nível superior).
6. Em `web/`, `pnpm install` e `pnpm build` concluem; `dist/index.html` não referencia nenhum
   CSS/JS/fonte externo (sem CDN).
7. `rust-analyzer`, `even-better-toml`, `eslint` e `prettier` aparecem instalados no container.
8. Na raiz, `pnpm install` ativa o hook de pre-commit; `pnpm run format:check` e `pnpm lint` passam.

## Notas de versionamento

- **`Cargo.lock` é versionado** — cada workspace tem o seu (raiz/core e `etherbit-tiling-daemon/`);
  como há um binário (`etherbit-tiling-daemon`), os lockfiles são commitados para builds reproduzíveis.
- **`.vscode/`** é parcialmente versionado: ignoramos arquivos locais, mas mantemos `settings.json`,
  `extensions.json`, `launch.json` e `tasks.json` para compartilhar a config do Dev Container.

> Veja também: [ESTRUTURA.md](ESTRUTURA.md) · [ARQUITETURA.md](ARQUITETURA.md)
