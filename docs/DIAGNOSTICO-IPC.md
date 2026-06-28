# Diagnóstico de IPC (D-Bus) — quedas após ociosidade/suspensão

Se, após ~10 min de ociosidade ou após suspender/retomar, o tiling "congela" (fechar janela não
reorganiza, mudar o gap não surte efeito), use os comandos abaixo para confirmar **onde** o canal
D-Bus caiu. O Etherbit já se auto-recupera (ativação D-Bus + reconexão na ponte + handshake de wake —
ver [ADR 0020](../rules/0020-resiliencia-ipc-dbus.md)); estes comandos servem para confirmar o
diagnóstico e investigar regressões.

> Arquitetura: o **daemon** Rust serve `dev.ediano.etherbit.Tiling` no barramento de **sessão**; a
> **extensão GNOME** / **script KWin** são clientes. O daemon é **sem estado** — reiniciá-lo é seguro.

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
