# 0024 — Instaladores idempotentes: autostart imediato, upgrade com checagem de versão e parada segura do daemon

**Status:** ✅ Aceita

## Contexto

Os instaladores de pacote (`packaging/install-{gnome,kde}.sh`) já faziam **autostart blindado** (ADR
[0016](0016-extensao-ponte-burra-render-no-daemon.md)): serviço `systemd --user`, `enable --now`,
`gnome-extensions enable` / `kwriteconfig6 + qdbus6 reconfigure`. Faltava o **upgrade seguro**:
atualizar exigia desinstalar antes "para limpar", e re-rodar o instalador com o daemon no ar tinha
um defeito silencioso (abaixo). Ao desenhar a solução, três pressupostos do enunciado original se
mostraram **falsos** e ficam aqui registrados para não se repetirem:

1. **Não existe `etherbit-core`.** O binário/serviço reais são **`etherbit-tiling-daemon`** e
   **`etherbit-tiling-daemon.service`** (marca do projeto, ADR [0008](0008-nome-etherbit.md)). Qualquer
   script que invoque `etherbit-core(.service)` aponta para um alvo inexistente.
2. **O daemon não tem `--version`.** `etherbit-tiling-daemon` não faz parsing de argumentos — só sobe
   o serviço D-Bus. `etherbit-tiling-daemon --version` não devolve versão (tenta conectar ao bus).
3. **`install` não dá ETXTBSY, mas `enable --now` não reinicia daemon ativo.** Ver decisão abaixo.

## Decisão

- **Fonte de verdade da versão = arquivo `VERSION` do tarball** (semver gravado pelo semantic-release
  via `build-{gnome,kde}-release.sh`). Os `metadata.json` **não servem** para comparação: o do GNOME é
  um **inteiro** (`version: 3`) e o do KDE uma **string própria** (`KPlugin.Version: "2"`), ambos
  hardcoded e dessincronizados do semver. A versão instalada é persistida num **marcador agnóstico de
  DE** (o daemon é compartilhado, ADR [0014](0014-daemon-linux-compartilhado.md)):
  `${XDG_STATE_HOME:-$HOME/.local/state}/etherbit-tiling/version`. Os uninstall removem o marcador.
- **Matriz de decisão (antes de copiar/registrar qualquer coisa):**
  | Estado                                                                                       | Ação                                                             |
  | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
  | sem marcador                                                                                 | instalação limpa                                                 |
  | `VERSION` ausente no pacote                                                                  | reinstalação forçada (override de dev)                           |
  | nova `=` instalada                                                                           | **reaplica** (idempotente; cobre rebuild de dev na mesma versão) |
  | nova `>` instalada                                                                           | upgrade                                                          |
  | nova `<` instalada                                                                           | **recusa** e mantém a atual; só prossegue com `ETHERBIT_FORCE=1` |
  | A comparação usa `sort -V` (coreutils), que trata corretamente `1.9.0 < 1.10.0`. A recusa de |
  | downgrade sai com `exit 0` (não quebra `curl …                                               | bash`).                                                          |
- **Parada segura do daemon ANTES da sobrescrita** — a sequência por execução é
  **parar → sobrescrever → `daemon-reload` → start → hot-reload → gravar marcador**. O motivo NÃO é
  ETXTBSY (verificado): o `install` do coreutils faz **unlink + create** (novo inode), logo sobrescreve
  sem erro mesmo com o binário em execução. O risco real é que **`systemctl start` num unit já ativo é
  no-op**: sem o `stop` explícito, o `install` troca os bytes em disco mas o **daemon ANTIGO continua
  em memória** (código velho rodando) até um logout/restart manual. Parar antes garante que o
  `enable --now` adiante suba o binário **novo**. (Truncar-no-lugar — `cat > bin` — sim daria
  `Text file busy`, mas o `install` não faz isso.)
- **Hot-reload no limite de cada compositor:**
  - **KDE:** `qdbus6 org.kde.KWin /KWin reconfigure` recarrega o KWin Script **ao vivo**, sem logout
    (ADR [0013](0013-camada-kde-kwin-script.md)).
  - **GNOME/Wayland:** o **daemon** reinicia ao vivo e a extensão-cliente reconecta via D-Bus (ADR
    [0020](0020-resiliencia-ipc-dbus.md)) — a lógica de tiling atualiza na hora. Mas o **código** da
    extensão só recarrega no **próximo login** (limite físico do Mutter; nenhum script contorna). As
    mensagens dos instaladores comunicam isso honestamente.
- **Escopo:** apenas os instaladores de **pacote** (únicos que recebem `VERSION` e instalam o binário
  do daemon). Os `scripts/install.sh` de **dev** ficam intactos (não têm `VERSION` nem instalam o
  daemon). Os `build-*-release.sh` **não mudam** (o `VERSION` já é empacotado).

## Consequências

- **Idempotência real:** rodar o comando de instalação N vezes é seguro e converge; com o daemon ativo,
  o upgrade efetivamente troca o processo (sem deixar o antigo rodando).
- **Sem downgrade acidental:** um tarball antigo reaplicado por engano não regride a instalação sem
  `ETHERBIT_FORCE=1` explícito.
- **Estende o 0016 (autostart), não o revoga:** o autostart blindado continua; este ADR só acrescenta
  o ciclo de atualização. Cross-refs: [0013](0013-camada-kde-kwin-script.md) (qdbus6/reconfigure),
  [0014](0014-daemon-linux-compartilhado.md) (daemon único), [0020](0020-resiliencia-ipc-dbus.md)
  (ativação/reconexão tornam "parar e religar" uma recuperação segura).
- **Marcador é estado, não config:** vive em `XDG_STATE_HOME`, fora de `~/.config/etherbit-tiling`
  (que o uninstall preserva salvo `ETHERBIT_PURGE=1`).
