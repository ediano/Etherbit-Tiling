# Diagnóstico de IPC (D-Bus) — quedas após ociosidade/suspensão

Se, após ~10 min de ociosidade ou após suspender/retomar, o tiling "congela" (fechar janela não
reorganiza, mudar o gap não surte efeito), use os comandos abaixo para confirmar **onde** o canal
D-Bus caiu. O Etherbit já se auto-recupera (ativação D-Bus + reconexão na ponte + handshake de wake —
ver [ADR 0020](../rules/0020-resiliencia-ipc-dbus.md)); estes comandos servem para confirmar o
diagnóstico e investigar regressões.

> Histórico da regressão "falha total" (v2.2.0 → v2.5.0) e do conserto (v2.5.1):
> [RELATORIO-REGRESSAO-v2.5.md](RELATORIO-REGRESSAO-v2.5.md).

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
RUST_LOG=debug ~/.local/bin/etherbit-tiling-daemon     # ou: ETHERBIT_LOG=debug; ou cargo run --manifest-path etherbit-tiling-daemon/Cargo.toml
# A linha-chave é: "sync_windows: N recebida(s) → M tileável(is) → R rect(s), …, D descartada(s)".
# Se recebidas (N) > rects (R), a CAUSA aparece no campo `descartada(s)` (D) e no log da extensão.

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
- **(GNOME) Log FIEL à tela.** A extensão loga, a cada relayout que muda o layout:
  `[etherbit] relayout: total=<N> aplicadas=<A> flutuantes=<F> descartadas=[id:motivo, …]` e
  `[etherbit] grid: id@x,y wxh | …` (geometria final de cada janela). Se `total > aplicadas` sem
  `flutuantes`, a janela "que some" está em `descartadas` com o motivo: `non_normal`/`non_resizable`/
  `non_maximizable`/`ignored` (reprovou em `is_tileable`, ex.: desktop/DING ou diálogo), `transient`
  (tem janela-pai — diálogo não modal, seletor de arquivos; ver a seção 7), `floating` (Super+G) ou
  `excluded_maximized` (nasceu maximizada e está fora do grid até desmaximizar — se persistir, ver o
  `JS WARNING` de `Meta.Window.unmaximize`, sintoma da API do Mutter mudar de assinatura).

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

## 7. 1ª janela não encaixa após reiniciar / diálogo entra no grid

Sintomas da [ADR 0072](../rules/0072-recusa-com-evidencia-e-transientes-flutuam.md): depois do boot a
1ª janela fica no tamanho natural, centralizada, até abrir a 2ª; ou um seletor de arquivos (ex.: "Abrir
Pasta" do VS Code) é tilado e racha a janela focada. Reinicie, reproduza e colete:

```bash
# GNOME (horário monotônico: compara com a linha "impl … ativa" do loader)
journalctl --user -b 0 -o short-monotonic /usr/bin/gnome-shell | grep etherbit

# KDE
journalctl --user -b 0 QT_CATEGORY=kwin_scripting | grep etherbit
```

Linhas novas (nenhuma traz o título da janela — o repositório é público):

- **GNOME** `[etherbit] enable: adotadas=N` — janelas que já existiam quando a extensão ativou.
- **GNOME** `[etherbit] janela: id=… via=first-frame|shown Δ=…ms adotada=0|1 classe=… wtype=…
transiente=<idPai|-> cliente=wayland|x11 frame=WxH@x,y` — uma por janela normal ou diálogo, no 1º
  quadro. `Δ` acima de ~80 ms quer dizer que o relayout de spawn pegou a janela antes da tela (o pedido
  feito antes do 1º quadro é esquecido e reenviado). `adotada=1` quer dizer que ela nasceu durante o
  carregamento assíncrono da extensão.
- **KDE** `[etherbit] janela: <id> classe=… normal=… dialog=… transiente=… modal=… frame=WxH @x,y` — no
  `windowAdded`.
- `[etherbit] recusa: sonda=[…] confirmada=[…]` (GNOME) / `recusa: sonda <id>` (KDE) — o cliente ficou
  menor que o slot. A sonda reenvia o slot uma vez; só se ele continuar menor (terminal com _size
  increments_, tamanho máximo) a janela é centralizada. Uma sonda seguida da janela no slot = era
  restauração do app, não recusa.
- `drop-detail: … transient=<idPai|->` (GNOME) — por que a janela ficou fora do grid.

Leitura:

- Seletor com `transiente=<id>` e o motivo `transient` em `descartadas` ⇒ flutua, como esperado.
- Seletor com `transiente=-` (sem pai) e tilado ⇒ o portal não conseguiu parentar o diálogo (ex.: app em
  XWayland). Anote a `classe` e abra uma ADR de acompanhamento com uma regra de exceção por classe.
- Ainda tilado com `transiente=<id>` ⇒ o daemon é antigo e ignora o campo. Reinstale o pacote, que
  reinicia o daemon.
- O seletor GTK memoriza o último tamanho. Se ele voltar pequeno depois da correção, redimensione uma
  vez (ou `gsettings reset` na chave `window-size` do `org.gtk.Settings.FileChooser`/
  `org.gtk.gtk4.Settings.FileChooser`).
