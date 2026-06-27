# Estrutura do Monorepo

O **Etherbit Tiling** é um monorepo poliglota: um núcleo agnóstico em Rust mais uma camada nativa por
plataforma. A organização separa **o que decide o layout** (core) de **o que aplica o layout** (cada SO).

```
Etherbit-Tiling/
├── .devcontainer/            # Config do VS Code Dev Containers
│   └── devcontainer.json     #   build → ../docker/Dockerfile.core, feature Node, extensões, pnpm
├── docker/
│   └── Dockerfile.core       # Imagem de dev: rust:1 + build-essential, libdbus-1-dev, pkg-config
├── core/                     # Crate Rust agnóstico (lib): etherbit-core
│   ├── Cargo.toml
│   └── src/lib.rs            #   algoritmo "Ether Flow"
├── platform-macos/           # Projeto Swift nativo (AppKit + Accessibility API)
│   └── README.md
├── platform-linux-gnome/     # Workspace Rust independente (isolamento de build)
│   ├── Cargo.toml            #   workspace do Linux (members: daemon)
│   ├── Cargo.lock            #   lockfile próprio do daemon
│   ├── daemon/               # Crate Rust (bin): etherbit-daemon — roteador D-Bus
│   │   ├── Cargo.toml        #   depende de etherbit-core por path (../../core)
│   │   └── src/main.rs
│   └── extension/            # Extensão-ponte Vite + TypeScript (ESM)
│       └── package.json      #   etherbit-gnome-extension
├── docs/                     # Documentação
├── Cargo.toml                # Workspace Rust raiz, agnóstico (members: core; exclude: platform-linux-gnome)
├── Cargo.lock                # Lockfile do core (versionado → builds reproduzíveis)
└── .gitignore
```

## Papel de cada componente

| Pasta | Linguagem / Stack | Responsabilidade |
|-------|-------------------|------------------|
| `core/` | Rust (lib) | **Ether Flow** — algoritmo agnóstico de divisão de tela e regras de filtragem de janelas. Sem dependências de SO. |
| `platform-macos/` | Swift (AppKit / Accessibility API) | Captura eventos de janela no macOS e aplica o layout decidido pelo core. **Build no host macOS.** |
| `platform-linux-gnome/daemon/` | Rust (bin) | Roteador de eventos **D-Bus**; ponte entre o GNOME Shell e o core. Depende de `etherbit-core` por path. |
| `platform-linux-gnome/extension/` | TypeScript + Vite (ESM) | Extensão-ponte do GNOME Shell que conversa com o daemon. |
| `.devcontainer/` + `docker/` | Docker | Ambiente de desenvolvimento isolado e reproduzível. |

## Workspaces Rust (builds isolados)

Para isolar os builds ao estilo monorepo, há **dois workspaces Cargo independentes**:

- **Raiz (`Cargo.toml`)** — agnóstico, com `resolver = "2"`, member único `core` e
  `exclude = ["platform-linux-gnome"]`. A raiz **não** enxerga crates de plataforma.
- **`platform-linux-gnome/Cargo.toml`** — workspace específico de Linux/GNOME, member `daemon`.

O `daemon` consome `etherbit-core` por **path** (`{ path = "../../core" }`); dependência de path
funciona entre workspaces. Cada workspace tem seu próprio `Cargo.lock`, garantindo builds
reproduzíveis e isolados.

O `platform-macos` (Swift) **não** faz parte de nenhum workspace Cargo — é editável como texto no
container, mas compilado por Xcode/SwiftPM no host macOS.

> Veja também: [ARQUITETURA.md](ARQUITETURA.md) · [DESENVOLVIMENTO.md](DESENVOLVIMENTO.md)
