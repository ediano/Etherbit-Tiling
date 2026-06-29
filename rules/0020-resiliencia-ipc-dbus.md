# 0020 — Resiliência de IPC (D-Bus): ativação, reconexão e wake handshake

**Status:** ✅ Aceita

## Contexto

Após ~10 min de ociosidade ou após suspender/retomar, o ecossistema parava de responder (fechar
janela não reorganizava, mudar gap não surtia efeito) e **só um reboot resolvia**. A investigação
mostrou por que nunca se recuperava:

- O **daemon** ([service.rs](../etherbit-tiling-daemon/daemon/src/service.rs)) abria **uma** conexão
  zbus de sessão e ficava vivo em `ctrl_c().await`; **sem reconexão** ao barramento, **sem ativação
  D-Bus** e lançado **só no login** (autostart `.desktop`). Se o processo morria/congelava na
  suspensão, ninguém o trazia de volta.
- A **extensão** ([extension.ts](../platform-linux-gnome/extension/src/extension.ts)) criava o
  `Gio.DBusProxy` uma vez e só fazia `try/catch`+log: **sem watch de nome, sem reconexão, sem
  re-sync**. O proxy ficava "vivo porém morto". Os listeners do Mutter persistem (o gnome-shell não
  suspende) — o que morria era o canal D-Bus.

## Decisão

Resiliência em **três camadas** que se reforçam (o daemon permanece **sem estado** — reiniciar é
seguro, reafirma 0016/0019):

- **Ativação D-Bus do daemon (correção central).** Novo [activation.rs](../etherbit-tiling-daemon/daemon/src/activation.rs)
  escreve, na inicialização (idempotente), `~/.local/share/dbus-1/services/dev.ediano.etherbit.Tiling.service`
  com `Exec=<current_exe>`. O `dbus-daemon` passa a **relançar o daemon sob demanda**: qualquer
  chamada ao nome o ativa se estiver fora. Transforma "morto até o reboot" em "revivido na próxima
  chamada" e cobre **GNOME e KDE** (ambos os clientes acionam ativação). Coexiste com o autostart
  `.desktop` (o toggle "iniciar com o sistema") — o dbus não relança se o nome já é detido.
- **Reconexão + watch de nome na extensão.** Toda chamada IPC passa por `_call(fn)`: garante o proxy
  e, em falha, **recria + tenta uma vez** (a recriação aciona a ativação). Um
  `Gio.bus_watch_name(SESSION, BUS_NAME)` faz o **re-sync automático**: ao daemon (re)aparecer
  (boot/reativação/wake), refaz o handshake (`Ping`), relê a config e dispara relayout; ao sumir,
  descarta o proxy. O `ResolveDropZone` do arrasto (60 Hz, cosmético) fica best-effort sem reconectar
  (recupera no relayout seguinte) para não gerar tempestade de reconexões.
- **Wake handshake no daemon via logind.** Novo [powermon.rs](../etherbit-tiling-daemon/daemon/src/powermon.rs)
  assina `PrepareForSleep(bool)` de `org.freedesktop.login1.Manager` (barramento de **sistema**;
  logind é **agnóstico de DE**, melhor que o `Mutter.IdleMonitor`, específico do GNOME). Ao **retomar**
  (`start=false`), re-emite `ConfigChanged` na sessão (a extensão já trata o sinal disparando
  relayout). Se a emissão falhar (canal de sessão morto), `std::process::exit(0)` → a ativação sobe
  uma instância nova e limpa. Best-effort: sem logind (containers), loga e desiste sem derrubar o
  daemon. O keep-alive do [main.rs](../etherbit-tiling-daemon/daemon/src/main.rs) virou
  `tokio::select!` sobre `ctrl_c` + `SIGTERM`.
- **Método `Ping() -> "ok"`** ([service.rs](../etherbit-tiling-daemon/daemon/src/service.rs)):
  handshake/health-check barato, usado pelo watch de nome e no diagnóstico.

> **Esclarecimento:** o **daemon não tem listeners do compositor** (Wayland/Mutter) — esses vivem na
> ponte/KWin e **persistem** (o shell não suspende). Portanto "re-registrar escutadores do
> compositor" é responsabilidade da **extensão** (camada 2). No daemon, o que importa é **revalidar o
> canal D-Bus**.

## Consequências

- **KDE:** coberto pela **ativação** (o `callDBus` a um nome ativável relança o daemon; os eventos do
  KWin seguem disparando `retile()` → revive e re-sincroniza). A reconexão fina do GNOME (watch de
  nome, recriação de proxy) **não se aplica** a um KWin *Script* sandbox — assimetria aceita, na mesma
  família das de 0016/0018/0019.
- **Nova dependência** no daemon: `futures-util` (iterar o stream de sinais do zbus).
- **Diagnóstico** documentado em [docs/DIAGNOSTICO-IPC.md](../docs/DIAGNOSTICO-IPC.md) (busctl,
  journalctl, dbus-monitor; como reproduzir a falha e provar a cura).
- **Daemon sem estado preservado:** como o estado leve (árvore/stacks/ordem) vive na ponte, reiniciar
  o daemon por ativação não perde nada — premissa que torna a estratégia "sair e reativar" segura.
- **Contrato:** `Ping` espelhado no XML/proxy da extensão ([dbus.ts](../platform-linux-gnome/extension/src/dbus.ts)).

## Emenda (2026-06): observabilidade + guard de pânico (falha silenciosa "nunca inicia")

A resiliência acima cobre o canal que **cai após estar de pé**. Um modo de falha distinto — "o tiling
**nunca** começou / parou de reagir a TUDO" — exigia tornar a falha **observável** e o core
**à prova de pânico**:

- **Guard de pânico no daemon** ([service.rs](../etherbit-tiling-daemon/daemon/src/service.rs)): cada
  handler D-Bus (`sync_windows`/`resolve_drop_zone`/`move_window`/`resize_window`) embrulha a chamada
  ao core em `catch_unwind`. Sem isso, um pânico (índice/`unwrap` em entrada degenerada) abortava a
  task em **silêncio** → cliente recebe `NoReply` → ponte inerte. Agora vira erro D-Bus recuperável +
  log; a próxima chamada volta a funcionar.
- **Tolerância a entrada degenerada** ([protocol.rs](../etherbit-tiling-daemon/daemon/src/protocol.rs)):
  `monitor`/`workspace` desserializam saturando negativos a 0 (`de_index`), para um `monitor: -1`
  (`Meta.Window.get_monitor()` sem monitor) **não** invalidar o array inteiro e derrubar o sync. O
  core clampa geometria degenerada (`inner_rect`/`split_axis` a `>= 0`) para gaps/mínimos extremos
  nunca esvaziarem o grid (reforça 0019).
- **Logs com prefixo estável:** daemon honra `RUST_LOG=debug` (`[etherbit-daemon] …`, nº de janelas/
  rects por `SyncWindows`); a extensão GNOME loga o round-trip do relayout e **isola a aplicação por
  janela** (um erro de runtime numa janela não paralisa o grid); o KWin Script faz o handshake `Ping`
  e loga `[etherbit]`. Regra: `ponte carregando` sem `Ping OK` ⇒ daemon inacessível.
- **Observabilidade no KDE não contradiz** o item acima sobre a reconexão fina não se aplicar ao
  sandbox: o handshake e os logs são apenas *diagnóstico* (não assinam sinais).
