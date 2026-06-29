# Diagnóstico de IPC (D-Bus) — quedas após ociosidade/suspensão

Se, após ~10 min de ociosidade ou após suspender/retomar, o tiling "congela" (fechar janela não
reorganiza, mudar o gap não surte efeito), use os comandos abaixo para confirmar **onde** o canal
D-Bus caiu. O Etherbit já se auto-recupera (ativação D-Bus + reconexão na ponte + handshake de wake —
ver [ADR 0020](../rules/0020-resiliencia-ipc-dbus.md)); estes comandos servem para confirmar o
diagnóstico e investigar regressões.

> Arquitetura: o **daemon** Rust serve `dev.ediano.etherbit.Tiling` no barramento de **sessão**; a
> **extensão GNOME** / **script KWin** são clientes. O daemon é **sem estado** — reiniciá-lo é seguro.

## 0. Tiling NUNCA inicia (KDE) ou parou de reagir a tudo (GNOME)

Sintoma diferente do anterior: a ponte (KWin Script / extensão GNOME) aparece **carregada/ativada**,
mas **nenhuma** janela é gerenciada — sem suspensão/ociosidade envolvidas. A ponte fala com o daemon
por D-Bus; se o daemon não responde, o `callDBus` do KWin **engole o erro em silêncio** e a extensão
recebe `null`. Isole o ramo nesta ordem:

```bash
# (KDE) O interpretador JS do KWin loga? Ver 'ponte carregando' SEM 'Ping OK' ⇒ daemon inacessível.
journalctl --user -f QT_CATEGORY=kwin_scripting | grep -i etherbit

# (GNOME) Erros de runtime da extensão e o round-trip do relayout:
journalctl --user -f -o cat /usr/bin/gnome-shell | grep -iE 'etherbit|JS ERROR|GDBus'

# O serviço do daemon está de pé? (a causa mais comum quando instalado pelo pacote completo)
systemctl --user status etherbit-tiling-daemon.service
journalctl --user -u etherbit-tiling-daemon.service -b 0

# Rodar o daemon em primeiro plano com log detalhado (vê nº de janelas recebidas / rects / PÂNICO):
systemctl --user stop etherbit-tiling-daemon.service 2>/dev/null
RUST_LOG=debug ~/.local/bin/etherbit-tiling-daemon     # ou: cargo run --manifest-path platform-linux-daemon/Cargo.toml

# O daemon responde? (a chamada também dispara a ativação D-Bus)
busctl --user call dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling \
  dev.ediano.etherbit.Tiling Ping                       # esperado: s "ok"

# Canal ao vivo: SyncWindows aparece como method call + (return | error)?
dbus-monitor --session "interface='dev.ediano.etherbit.Tiling'"
```

Leitura dos resultados:

- `Ping` não responde / serviço inativo ⇒ **daemon fora**: ver `systemctl`/`journalctl -u` (ex.:
  `ExecStart` apontando para binário inexistente, sessão sem systemd `--user`).
- `dbus-monitor` mostra `SyncWindows` com **error** (ou o `RUST_LOG` mostra `PÂNICO no core` /
  `windows_json inválido`) ⇒ **pânico/entrada degenerada no daemon** — agora é logado e recuperável
  (o guard devolve erro em vez de derrubar a task; valores como `monitor: -1` são tolerados).
- `SyncWindows` retorna mas a janela **não move** ⇒ erro ao APLICAR a geometria na ponte: ver o
  journal do gnome-shell (KDE: a chave `debug` no kwinrc liga o detalhamento por evento).

## 1. O daemon ainda detém o nome no barramento?

```bash
busctl --user status dev.ediano.etherbit.Tiling || echo "DAEMON FORA DO BARRAMENTO"
busctl --user list | grep -i etherbit
```

- **Nome ausente** → o daemon morreu/foi congelado. Com a ativação D-Bus instalada, a próxima
  chamada de um cliente o **relança** automaticamente. Confirme que existe o arquivo de ativação:
  ```bash
  cat ~/.local/share/dbus-1/services/dev.ediano.etherbit.Tiling.service
  ```
- Forçar a ativação manualmente (deve subir o daemon e responder `ok`):
  ```bash
  busctl --user call dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling \
    dev.ediano.etherbit.Tiling Ping
  ```

## 2. Logs do daemon

```bash
journalctl --user -b 0 | grep -iE 'etherbit|tiling'
# Procure: "monitor de energia (login1) ativo", "canal de sessão morto ao acordar; saindo para
# reativação", "ativação D-Bus indisponível".
```

## 3. Erros do lado da extensão (vão para o gnome-shell)

```bash
journalctl --user -b 0 /usr/bin/gnome-shell \
  | grep -iE 'Etherbit Tiling|GDBus|ServiceUnknown|NoReply|Disconnected|Timeout'
# "chamada D-Bus falhou, reconectando" = a reconexão automática entrou em ação.
```

Erros que **confirmam a queda do canal**: `Gio.DBusError: ...Error.ServiceUnknown`,
`...Error.NoReply`, `...Error.Disconnected`, `Timeout`.

## 4. Suspensão/retomada (logind — agnóstico de DE)

```bash
journalctl -b 0 -u systemd-logind | grep -iE 'sleep|suspend|resume|lid'
```

## 5. Acompanhar ao vivo um ciclo ocioso → acordar

```bash
journalctl --user -f                                               # deixe rodando e provoque idle/suspensão
dbus-monitor --session "interface='dev.ediano.etherbit.Tiling'"    # vê as chamadas/erros no canal
```

## 6. Reproduzir a falha e provar a cura

```bash
# Mata o daemon e age na UI: a ativação deve trazê-lo de volta.
pkill -f etherbit-tiling-daemon
#  → feche uma janela ou mude o gap; depois:
busctl --user status dev.ediano.etherbit.Tiling   # deve mostrar o daemon de volta

# Suspensão real:
systemctl suspend
#  → ao acordar, fechar janela reorganiza e o gap surte efeito;
#    journalctl --user -f mostra o tratamento de PrepareForSleep / reativação.
```
