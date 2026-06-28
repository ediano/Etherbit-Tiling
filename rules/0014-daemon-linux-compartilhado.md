# 0014 — Daemon Linux compartilhado entre GNOME e KDE

**Status:** ✅ Aceita

## Contexto
O ADR [0003](0003-monorepo-poliglota.md) estabelece workspaces Cargo isolados por plataforma. Ao
adicionar a camada KDE (ADR [0013](0013-camada-kde-kwin-script.md)) surgiu a questão: o daemon
(`etherbit-tiling-daemon`) deve ser **duplicado** num novo workspace `platform-linux-kde/daemon`, ou
**reaproveitado** do `platform-linux-gnome`?

O daemon já é **agnóstico de ambiente de desktop**: apenas persiste a config em TOML
(`~/.config/etherbit-tiling/config.toml`), expõe o serviço D-Bus `org.etherbit.Tiling` e gerencia o
autostart via `.desktop` + serviço `systemd --user`. Nada nele é específico do GNOME. Duplicá-lo
significaria manter duas cópias quase idênticas (código, `Cargo.lock`, testes) em sincronia.

## Decisão
- **O daemon é único e compartilhado entre GNOME e KDE.** A camada KDE **não** tem workspace Cargo
  próprio nem cópia do daemon: entrega apenas o KWin Script. O isolamento por plataforma do ADR 0003
  passa a valer para a **camada nativa de UI/eventos** (extension vs. KWin Script), não para o daemon,
  que é infraestrutura comum.
- **O binário continua fisicamente em `platform-linux-gnome/daemon`** por ora. Os scripts de
  empacotamento do KDE (`packaging/build-kde-release.sh`) **reusam** esse build
  (`cargo build --release --manifest-path platform-linux-gnome/Cargo.toml`) e empacotam o mesmo
  binário no `etherbit-tiling-kde.tar.gz`.
- **Instalação coerente:** ambos os instaladores colocam o daemon em `~/.local/bin` e a mesma unit
  `etherbit-tiling-daemon.service`. Se o usuário tem as duas camadas, o daemon é o mesmo serviço.

## Consequências
- **Trade-off de nomenclatura:** o binário compartilhado mora sob um caminho com "gnome" no nome, o
  que é levemente enganoso. Aceito por ora para não desestabilizar o release GNOME.
- **Evolução futura (opcional):** mover o daemon para um caminho neutro (ex.: `platform-linux/daemon`),
  com os dois empacotadores apontando para lá. Quando/se for feito, atualizar este ADR e o 0003.
- Menos duplicação: um só código, um só `Cargo.lock`, uma só suíte de testes do daemon.
- O desinstalador KDE avisa que, se a camada GNOME também estiver instalada, o daemon é compartilhado.
