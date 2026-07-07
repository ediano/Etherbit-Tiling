<div align="center">

# Etherbit Tiling

**O tecido invisível que coloca suas janelas em órbita perfeita.**

Gerenciador automático de janelas (_tiling window manager_) com algoritmo agnóstico em Rust,
foco principal em **macOS** (Swift nativo) e suporte a **Linux / GNOME 45+ (Wayland)** e
**KDE Plasma 6 (Wayland)**. Inspirado no ambiente **COSMIC** do Pop!_OS.

</div>

---

## ✨ Visão geral

O **Etherbit Tiling** nasceu da falta, no Mac, de um gerenciador de janelas realmente automático,
fluido e resistente a atualizações do sistema. Em vez de arrastar janelas na mão, o Etherbit calcula
o espaço da tela e posiciona cada janela na sua "órbita" ideal automaticamente.

O coração do projeto é o algoritmo **Ether Flow** — uma divisão matemática de tela, **agnóstica de
plataforma**, escrita em Rust. Cada sistema operacional tem apenas uma fina camada nativa que captura
eventos de janela e aplica as decisões do core.

> 📖 A história e a filosofia do nome estão em [docs/NOMENCLATURA.md](docs/NOMENCLATURA.md).

### O que entrega

- **Tiling Dinâmico** — janelas organizadas automaticamente ao abrir/fechar apps, sem mouse.
- **Ether Flow** — preenchimento inteligente que elimina espaços mortos e se adapta em tempo real.
- **Arquitetura nativa e resiliente** — camada macOS em Swift sobre as APIs estáveis da Apple
  (Accessibility); não quebra a cada atualização do macOS.

---

## 🗂️ Estrutura do monorepo

```
Etherbit-Tiling/
├── core/                  # 🦀 Rust — algoritmo agnóstico "Ether Flow" (etherbit-tiling-core)
├── platform-macos/        # 🍎 Swift nativo (AppKit + Accessibility) — build no host macOS
├── etherbit-tiling-daemon/ # 🐧 Linux — daemon (Rust/D-Bus) compartilhado por GNOME e KDE
├── platform-linux-gnome/  # 🐧 Linux/GNOME — extension (Vite/TS); usa o daemon
├── platform-linux-kde/    # 🐧 Linux/KDE Plasma 6 (Wayland) — KWin Script (Vite/TS); reusa o daemon
├── web/                   # 🌐 Landing page global (Vite + CSS3 puro) — hub de downloads
├── .devcontainer/  docker/  # 🐳 Dev Container (imagem em docker/Dockerfile.core)
├── docs/  rules/          # 📚 Documentação e decisões de projeto (ADR)
└── Cargo.toml             # Workspace Rust raiz, agnóstico (só o core)
```

> Árvore detalhada e o papel de cada componente em [docs/ESTRUTURA.md](docs/ESTRUTURA.md).

---

## 🚀 Começando

O desenvolvimento do **core (Rust)** e da **extension (TypeScript/Vite)** roda dentro de um
**Dev Container**. O build do **macOS (Swift)** roda no **host macOS** (restrição do SDK da Apple).

```bash
# 1. Abra o projeto no VS Code e escolha: "Reopen in Container"
# 2. Build do core (workspace raiz, agnóstico):
cargo build
# 3. Build/execução do daemon Linux (workspace próprio, compartilhado por GNOME/KDE):
cd etherbit-tiling-daemon && cargo build                         # ou: cargo run -p etherbit-tiling-daemon (sobe o D-Bus dev.ediano.etherbit.Tiling)
# 4. Build/instalação da extensão GNOME (pnpm via corepack):
cd platform-linux-gnome/extension && pnpm install && pnpm run install:ext
# 5. Build/instalação do KWin Script KDE (Plasma 6/Wayland; reusa o daemon):
cd platform-linux-kde/kwin-script && pnpm install && pnpm run install:script
```

> **Ícone na bandeja (KDE):** o applet da System Tray vem no release
> (`packaging/build-kde-release.sh` + `install-kde.sh`). Ele fica _elegível_, não é forçado no painel —
> habilite em **Config. da Bandeja do Sistema → Entradas → Etherbit Tiling → Mostrar** ([ADR 0059](rules/0059-system-tray-applet-kde-via-kglobalaccel.md)).

> Guia completo em [docs/DESENVOLVIMENTO.md](docs/DESENVOLVIMENTO.md).

---

## 📚 Documentação

- **Índice completo + convenções:** [CLAUDE.md](CLAUDE.md)
- **Decisões de projeto (ADR):** [rules/](rules/README.md)
- **Aprofundar:** [estrutura](docs/ESTRUTURA.md) · [arquitetura](docs/ARQUITETURA.md) · [desenvolvimento](docs/DESENVOLVIMENTO.md) · [nomenclatura](docs/NOMENCLATURA.md)

---

## 🧱 Status

🚧 **Fundação inicial.** A estrutura do monorepo, o ambiente de desenvolvimento (Dev Container) e os
crates stub já estão no lugar. O algoritmo Ether Flow e as camadas de plataforma estão em construção.
