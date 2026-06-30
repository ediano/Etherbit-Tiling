# 0014 — Daemon Linux compartilhado entre GNOME e KDE

**Status:** ✅ Aceita

## Contexto

O ADR [0003](0003-monorepo-poliglota.md) estabelece workspaces Cargo isolados por plataforma. Ao
adicionar a camada KDE (ADR [0013](0013-camada-kde-kwin-script.md)) surgiu a questão: o daemon
(`etherbit-tiling-daemon`) deve ser **duplicado** num novo workspace `platform-linux-kde/daemon`, ou
**reaproveitado** num único workspace compartilhado?

O daemon já é **agnóstico de ambiente de desktop**: apenas persiste a config em TOML
(`~/.config/tiling/config.toml`), expõe o serviço D-Bus `dev.ediano.etherbit.Tiling` e gerencia o
autostart via `.desktop` + serviço `systemd --user`. Nada nele é específico do GNOME. Duplicá-lo
significaria manter duas cópias quase idênticas (código, `Cargo.lock`, testes) em sincronia.

## Decisão

- **O daemon é único e compartilhado entre GNOME e KDE.** A camada KDE **não** tem workspace Cargo
  próprio nem cópia do daemon: entrega apenas o KWin Script. O isolamento por plataforma do ADR 0003
  passa a valer para a **camada nativa de UI/eventos** (extension vs. KWin Script), não para o daemon,
  que é infraestrutura comum.
- **O binário mora num caminho que espelha seu próprio nome: `etherbit-tiling-daemon/daemon`.** Ambos os scripts de
  empacotamento (`packaging/build-gnome-release.sh` e `packaging/build-kde-release.sh`) **reusam** esse
  build (`cargo build --release --manifest-path etherbit-tiling-daemon/Cargo.toml`) e empacotam o mesmo
  binário nos respectivos `.tar.gz`. A camada `platform-linux-gnome` passa a conter apenas a extension.
- **Instalação coerente:** ambos os instaladores colocam o daemon em `~/.local/bin` e a mesma unit
  `etherbit-tiling-daemon.service`. Se o usuário tem as duas camadas, o daemon é o mesmo serviço.

## Consequências

- **Nomenclatura honesta:** o diretório foi renomeado de `platform-linux-daemon/` para
  `etherbit-tiling-daemon/`, espelhando o nome do crate/binário compartilhado (agnóstico de DE). As
  camadas de UI seguem `platform-linux-gnome/` (extension) e `platform-linux-kde/` (KWin Script). Isso
  elimina o trade-off inicial de o binário compartilhado morar sob um caminho com "gnome" no nome — e
  reserva o prefixo `platform-linux-*` às camadas de fato específicas de plataforma. A dependência por
  path `etherbit-tiling-core = { path = "../../core" }` permanece válida (mesma profundidade).
- Menos duplicação: um só código, um só `Cargo.lock`, uma só suíte de testes do daemon.
- O desinstalador KDE avisa que, se a camada GNOME também estiver instalada, o daemon é compartilhado.
