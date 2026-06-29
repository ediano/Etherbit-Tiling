# Estrutura do Monorepo

O **Etherbit Tiling** é um monorepo poliglota: um núcleo agnóstico em Rust mais uma camada nativa por
plataforma. A organização separa **o que decide o layout** (core) de **o que aplica o layout** (cada SO).

```
Etherbit-Tiling/
├── .devcontainer/            # Config do VS Code Dev Containers
│   └── devcontainer.json     #   build → ../docker/Dockerfile.core, feature Node, extensões, pnpm
├── docker/
│   └── Dockerfile.core       # Imagem de dev: rust:1 + build-essential, libdbus-1-dev, pkg-config
├── core/                     # Crate Rust agnóstico (lib): etherbit-tiling-core
│   ├── Cargo.toml
│   └── src/lib.rs            #   algoritmo "Ether Flow"
├── platform-macos/           # Projeto Swift nativo (AppKit + Accessibility API)
│   └── README.md
├── etherbit-tiling-daemon/    # Workspace Rust independente (daemon compartilhado por GNOME/KDE)
│   ├── Cargo.toml            #   workspace do Linux (members: daemon)
│   ├── Cargo.lock            #   lockfile próprio do daemon
│   └── daemon/               # Crate Rust (bin): etherbit-tiling-daemon — serviço D-Bus
│       ├── Cargo.toml        #   zbus + tokio + serde/toml; depende de etherbit-tiling-core por path
│       └── src/
│           ├── main.rs       #     loop de background; sobe dev.ediano.etherbit.Tiling
│           ├── service.rs    #     interface D-Bus #[interface] (gaps, borda, ignore, autostart)
│           ├── config.rs     #     Config (serde) persistida em ~/.config/etherbit-tiling/config.toml
│           └── autostart.rs  #     manifesto .desktop em ~/.config/autostart
├── platform-linux-gnome/     # Camada GNOME (Wayland) — só a extension; usa o daemon
│   └── extension/            # Extensão-ponte Vite + TypeScript (ESM): etherbit-tiling-extension
│       ├── package.json      #   scripts: dev/build/typecheck/install:ext (pnpm)
│       ├── metadata.json     #   uuid etherbit.tiling@ediano.dev, shell-version 45–50
│       ├── vite.config.ts    #   modo library; externaliza gi://, resource:///
│       ├── tsconfig.json     #   ESM, tipos @girs/*
│       ├── scripts/install.sh#   copia o bundle para a pasta local de extensões do GNOME
│       └── src/
│           ├── extension.ts  #     enable/disable, indicador, filtro Mutter window-created
│           ├── indicator.ts  #     PanelMenu.Button (gaps, borda ativa, autostart)
│           └── dbus.ts       #     proxy D-Bus + tipos da config
├── platform-linux-kde/       # Camada KDE Plasma 6 (Wayland) — só o KWin Script; reusa o daemon
│   └── kwin-script/          # KPackage "KWin/Script" (Vite + TypeScript → bundle IIFE)
│       ├── metadata.json     #   KPackageStructure KWin/Script; Id etherbit-tiling
│       ├── vite.config.ts    #   bundle único IIFE (QJSEngine não tem ESM em runtime)
│       ├── kwin-globals.d.ts #   tipos ambientes da API de scripting do KWin
│       └── contents/
│           ├── code/         #     main.ts (ponte), config.ts/tiling.ts (puros, testáveis)
│           ├── config/main.xml #   KConfigXT (innerGap, outerGap, borda, autostart)
│           └── ui/config.ui  #     UI nativa (objectName = kcfg_<chave>)
├── web/                      # Landing page global (Vite + CSS3 puro): etherbit-tiling-web
│   ├── package.json          #   scripts dev/build/preview (pnpm)
│   ├── vite.config.js        #   SPA estática; base de GitHub Pages
│   ├── index.html            #   HTML5 semântico + SEO (canonical, OG, JSON-LD)
│   ├── public/favicon.svg    #   ícone vetorial
│   └── src/                  #   style.css (Dark Mode) + main.js (ano, copiar)
├── docs/                     # Documentação
├── Cargo.toml                # Workspace Rust raiz, agnóstico (members: core; exclude: etherbit-tiling-daemon)
├── Cargo.lock                # Lockfile do core (versionado → builds reproduzíveis)
└── .gitignore
```

## Papel de cada componente

| Pasta | Linguagem / Stack | Responsabilidade |
|-------|-------------------|------------------|
| `core/` | Rust (lib) | **Ether Flow** — algoritmo agnóstico de divisão de tela e regras de filtragem de janelas. Sem dependências de SO. |
| `platform-macos/` | Swift (AppKit / Accessibility API) | Captura eventos de janela no macOS e aplica o layout decidido pelo core. **Build no host macOS.** |
| `etherbit-tiling-daemon/daemon/` | Rust (bin) | Roteador de eventos **D-Bus** compartilhado por GNOME e KDE; ponte entre a camada nativa e o core. Depende de `etherbit-tiling-core` por path. |
| `platform-linux-gnome/extension/` | TypeScript + Vite (ESM) | Extensão-ponte do GNOME Shell que conversa com o daemon. |
| `platform-linux-kde/kwin-script/` | TypeScript + Vite (IIFE) | KWin Script (Plasma 6 / Wayland) que aplica o tiling e conversa com o daemon. **Reusa o daemon compartilhado** (ver ADR 0014). |
| `web/` | Vite + HTML5/CSS3 puro | Landing page global e agnóstica — hub oficial de distribuição (manifesto + downloads). Sem CDN. |
| `.devcontainer/` + `docker/` | Docker | Ambiente de desenvolvimento isolado e reproduzível. |

## Workspaces Rust (builds isolados)

Para isolar os builds ao estilo monorepo, há **dois workspaces Cargo independentes**:

- **Raiz (`Cargo.toml`)** — agnóstico, com `resolver = "2"`, member único `core` e
  `exclude = ["etherbit-tiling-daemon"]`. A raiz **não** enxerga crates de plataforma.
- **`etherbit-tiling-daemon/Cargo.toml`** — workspace do daemon Linux (compartilhado por GNOME/KDE), member `daemon`.

O `daemon` consome `etherbit-tiling-core` por **path** (`{ path = "../../core" }`); dependência de path
funciona entre workspaces. Cada workspace tem seu próprio `Cargo.lock`, garantindo builds
reproduzíveis e isolados.

O `platform-macos` (Swift) **não** faz parte de nenhum workspace Cargo — é editável como texto no
container, mas compilado por Xcode/SwiftPM no host macOS.

Tanto o `platform-linux-gnome` quanto o `platform-linux-kde` **não** têm workspace Cargo próprio:
entregam só a camada nativa (TypeScript) e **reaproveitam o daemon** compilado em
`etherbit-tiling-daemon` (o daemon é agnóstico de DE — ver
[ADR 0014](../rules/0014-daemon-linux-compartilhado.md)).

> Veja também: [ARQUITETURA.md](ARQUITETURA.md) · [DESENVOLVIMENTO.md](DESENVOLVIMENTO.md)
