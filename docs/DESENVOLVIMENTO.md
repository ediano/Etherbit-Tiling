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
cargo build         # compila etherbit-core
cargo test          # testes do core
```

**Daemon Linux (workspace próprio):**
```bash
cd platform-linux-gnome
cargo run -p etherbit-daemon     # => Etherbit daemon — core 0.1.0
cargo build                      # compila etherbit-daemon (puxa etherbit-core por path)
```

O daemon consome `etherbit-core` por path (`../../core`), então seu build valida a integração com o
core mesmo estando em outro workspace.

## Extension GNOME (TypeScript + Vite)

A extensão usa **pnpm** (habilitado via corepack no container):

```bash
cd platform-linux-gnome/extension
pnpm install
pnpm dev        # servidor de desenvolvimento Vite
pnpm build      # build de produção
```

> **Shell fish:** encadeie comandos com `; and` em vez de `&&`. Ex.: `corepack enable; and pnpm --version`.

## Plataforma macOS (Swift)

Os arquivos em [`platform-macos/`](../platform-macos/) ficam **visíveis e editáveis** dentro do
container (como texto), mas **o build é feito no host macOS** com Xcode/SwiftPM, pois dependem do
AppKit e da Accessibility API da Apple.

## Checklist de verificação

1. **Container builda** após "Reopen in Container" (libdbus/pkg-config instalados).
2. `cargo build` na raiz compila `etherbit-core` sem erros.
3. Em `platform-linux-gnome/`, `cargo run -p etherbit-daemon` imprime `Etherbit daemon — core 0.1.0`.
4. `corepack enable; and pnpm --version` funciona; `pnpm install` na `extension/` conclui.
5. `rust-analyzer`, `even-better-toml` e `eslint` aparecem instalados no container.

## Notas de versionamento

- **`Cargo.lock` é versionado** — cada workspace tem o seu (raiz/core e `platform-linux-gnome/`);
  como há um binário (`etherbit-daemon`), os lockfiles são commitados para builds reproduzíveis.
- **`.vscode/`** é parcialmente versionado: ignoramos arquivos locais, mas mantemos `settings.json`,
  `extensions.json`, `launch.json` e `tasks.json` para compartilhar a config do Dev Container.

> Veja também: [ESTRUTURA.md](ESTRUTURA.md) · [ARQUITETURA.md](ARQUITETURA.md)
