# 0071 — Update sem logout: loader estável + impl versionada no GNOME e recarga explícita no KDE

**Status:** ✅ Aceita
(emenda a [0024](0024-instaladores-upgrade-idempotente-autostart.md): o "próximo login" deixa de ser
obrigatório para o código da extensão GNOME. Mantém a [0020](0020-resiliencia-ipc-dbus.md): o daemon
continua sendo reiniciado ao vivo e os clientes reconectam.)

## Contexto

Pela 0024, todo update do GNOME/Wayland pedia logout, porque o Shell cacheia módulos ES **por URL** e
não existe `Alt+F2 r` no Wayland. No KDE, o `reconfigure` do KWin não troca o código de um script
**já carregado**, o plasmashell mantinha o QML antigo do applet e o helper de preview seguia com o
binário velho em memória.

## Decisão

- **GNOME:** a extensão passa a ter duas saídas de build.
  - `extension.js` (`src/loader.ts`) é um **loader estável e fino** que importa dinamicamente
    `impl/<versão>/main.js` (`src/extension.ts`, o código de sempre).
  - O loader observa `impl/current` (`Gio.FileMonitor`). Quando o arquivo muda, faz `disable()` da
    impl antiga, `import()` do caminho novo e `enable()` da nova. Como o caminho é novo, o cache de
    módulos não interfere.
  - Os instaladores (pacote e dev) gravam a impl num diretório novo, trocam `current` de forma
    atômica e mantêm só as 2 versões mais novas.
  - Logout só é pedido na **instalação limpa** ou quando o **loader ou o `metadata.json` mudam**
    (comparação byte a byte).
  - GTypes registrados na impl recebem um `GTypeName` único por carga, para não colidir na reimportação.
  - O estado da árvore é refeito pelo boot settle normal do `enable()`. Nenhum snapshot é transferido.
- **KDE:** o instalador encerra o helper `etherbit-tiling-preview`, que a próxima chamada D-Bus reativa
  já com o binário novo. Em seguida faz `unloadScript` antes do `reconfigure`, para o KWin carregar o
  script novo. Se o applet foi atualizado, faz `try-restart` do `plasma-plasmashell`.
- **Script de dev GNOME:** passa a reiniciar o daemon se o serviço estiver ativo.

## Consequências

- Atualizações rotineiras no GNOME (Wayland e X11) e no KDE não exigem logout nem reboot.
- O loader deve mudar raramente. Toda mudança nele custa um logout aos usuários.
- Uma impl nova que falhe no `enable()` deixa o tiling parado até a próxima troca, com o erro no
  journal do gnome-shell.
- O macOS não é afetado: lá o update é só relançar o app.
