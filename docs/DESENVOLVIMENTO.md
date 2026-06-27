# Guia de Desenvolvimento

O ambiente de desenvolvimento do **core (Rust)** e da **extension (TypeScript/Vite)** é totalmente
isolado em um **VS Code Dev Container**. O build do **macOS (Swift)** acontece no **host macOS**.

## Pré-requisitos
- [Docker](https://www.docker.com/) em execução.
- [VS Code](https://code.visualstudio.com/) com a extensão **Dev Containers** (`ms-vscode-remote.remote-containers`).
- Para a camada macOS: um **Mac com Xcode** (o SDK da Apple não roda no container).

## Subindo o Dev Container

1. Abra a pasta do projeto no VS Code.
2. Aceite **"Reopen in Container"** (ou Command Palette → *Dev Containers: Reopen in Container*).

O que o container provê:
- Imagem base **`mcr.microsoft.com/devcontainers/rust:1`** (definida em
  [`docker/Dockerfile.core`](../docker/Dockerfile.core)), com `build-essential`, `libdbus-1-dev` e
  `pkg-config` para a comunicação D-Bus do daemon Linux.
- **Feature Node** (`ghcr.io/devcontainers/features/node:1`) para o TypeScript/Vite da extensão.
- **pnpm** habilitado via corepack no `postCreateCommand`.
- Extensões do VS Code pré-instaladas: `rust-analyzer`, `even-better-toml`, `eslint`.

> A configuração fica em [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json), que
> aponta o build para `../docker/Dockerfile.core` (Docker centralizado em `docker/`).

## Core e Daemon (Rust) — builds isolados

São **dois workspaces Cargo independentes** (ver [rules/0003](../rules/0003-monorepo-poliglota.md)).

**Core (workspace raiz, agnóstico):**
```bash
cargo build         # compila etherbit-tiling-core
cargo test          # testes do core
```

**Daemon Linux (workspace próprio):**
```bash
cd platform-linux-gnome
cargo build                          # compila etherbit-tiling-daemon (puxa etherbit-tiling-core por path)
cargo run -p etherbit-tiling-daemon  # sobe o serviço D-Bus org.etherbit.Tiling no barramento de sessão
```

O daemon registra a interface D-Bus `org.etherbit.Tiling` (ver
[rules/0009](../rules/0009-nomenclatura-dbus-uuid.md)) e fica em background até `Ctrl-C`. Ele exige um
**barramento de sessão** ativo: num host GNOME real isso já existe; no Dev Container use
`dbus-run-session -- cargo run -p etherbit-tiling-daemon` (instale `dbus` se necessário). Inspecione e
exercite com `busctl --user`:

```bash
busctl --user introspect org.etherbit.Tiling /org/etherbit/Tiling
busctl --user call org.etherbit.Tiling /org/etherbit/Tiling org.etherbit.Tiling SetGaps uu 8 12
busctl --user call org.etherbit.Tiling /org/etherbit/Tiling org.etherbit.Tiling GetConfig
```

A config persiste em `~/.config/etherbit-tiling/config.toml`; o autostart gerencia
`~/.config/autostart/tiling@etherbit.org.desktop`. O daemon consome `etherbit-tiling-core` por path
(`../../core`), então seu build valida a integração com o core mesmo estando em outro workspace.

## Extension GNOME (TypeScript + Vite)

A extensão usa **pnpm** (habilitado via corepack no container):

```bash
cd platform-linux-gnome/extension
pnpm install
pnpm typecheck      # checagem de tipos (tsc --noEmit)
pnpm build          # bundle ESM de produção em dist/extension.js
pnpm run install:ext  # build + copia para ~/.local/share/gnome-shell/extensions/tiling@etherbit.org/
```

O build usa Vite em modo *library* mantendo `gi://`/`resource:///` literais (ver
[rules/0010](../rules/0010-tooling-extensao-e-zbus.md)). O UUID é `tiling@etherbit.org`.

> **Shell fish:** encadeie comandos com `; and` em vez de `&&`. Ex.: `corepack enable; and pnpm --version`.

### Recarregar no Wayland
O GNOME Shell **não** recarrega extensões com `Alt+F2` `r` no Wayland (isso é só X11). Para aplicar:

- **Sessão real:** faça **logout/login** após `pnpm run install:ext`, depois
  `gnome-extensions enable tiling@etherbit.org`.
- **Loop de dev:** rode um Shell **aninhado** isolado, sem derrubar sua sessão:
  ```bash
  dbus-run-session -- gnome-shell --nested --wayland
  ```
  Logs: `journalctl -f -o cat /usr/bin/gnome-shell`. Console interativo: `Alt+F2` → `lg` (Looking Glass).

> O Dev Container compila e empacota a extensão, mas **não roda o GNOME Shell**. A execução/teste de
> runtime (indicador, eventos de janela, D-Bus) acontece num host GNOME 45+ sob Wayland.

## Plataforma macOS (Swift)

Os arquivos em [`platform-macos/`](../platform-macos/) ficam **visíveis e editáveis** dentro do
container (como texto), mas **o build é feito no host macOS** com Xcode/SwiftPM, pois dependem do
AppKit e da Accessibility API da Apple.

## Checklist de verificação

1. **Container builda** após "Reopen in Container" (libdbus/pkg-config instalados).
2. `cargo build` na raiz compila `etherbit-tiling-core` sem erros.
3. Em `platform-linux-gnome/`, `cargo build` compila `etherbit-tiling-daemon`; com um barramento de
   sessão (`dbus-run-session`), `cargo run -p etherbit-tiling-daemon` registra `org.etherbit.Tiling`.
4. Na `extension/`, `pnpm install`, `pnpm typecheck` e `pnpm build` concluem; `dist/extension.js`
   preserva os imports `gi://`/`resource:///`.
5. `rust-analyzer`, `even-better-toml` e `eslint` aparecem instalados no container.

## Notas de versionamento

- **`Cargo.lock` é versionado** — cada workspace tem o seu (raiz/core e `platform-linux-gnome/`);
  como há um binário (`etherbit-tiling-daemon`), os lockfiles são commitados para builds reproduzíveis.
- **`.vscode/`** é parcialmente versionado: ignoramos arquivos locais, mas mantemos `settings.json`,
  `extensions.json`, `launch.json` e `tasks.json` para compartilhar a config do Dev Container.

> Veja também: [ESTRUTURA.md](ESTRUTURA.md) · [ARQUITETURA.md](ARQUITETURA.md)
