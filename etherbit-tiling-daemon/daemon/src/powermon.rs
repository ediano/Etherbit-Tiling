// powermon.rs — monitor de energia/sessão (logind) para o wake handshake.
//
// Após a suspensão, o canal D-Bus daemon↔ponte pode ficar corrompido/desconectado. Este módulo
// assina `PrepareForSleep(bool)` de `org.freedesktop.login1.Manager` (logind, AGNÓSTICO de DE — vale
// GNOME e KDE) no barramento de SISTEMA. Ao RETOMAR (start=false), re-emite `ConfigChanged` no
// barramento de sessão para cutucar os clientes a re-sincronizar (a extensão já trata esse sinal
// disparando um relayout). Se a emissão falhar, o canal de sessão morreu: o daemon sai e a ATIVAÇÃO
// D-Bus (ver activation.rs) sobe uma instância nova e limpa (o daemon é sem estado). Ver ADR 0020.
//
// O daemon NÃO tem listeners do compositor (Wayland/Mutter) — esses vivem na ponte e persistem; aqui
// só revalidamos o canal D-Bus.

use anyhow::Result;
use futures_util::stream::StreamExt;
use zbus::Connection;

use crate::service::{BUS_NAME, OBJECT_PATH};

/// Proxy mínimo do logind: só o sinal `PrepareForSleep`.
#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait LogindManager {
    /// `start=true` ao entrar em suspensão; `start=false` ao retomar.
    #[zbus(signal)]
    fn prepare_for_sleep(&self, start: bool) -> zbus::Result<()>;
}

/// Sobe o monitor num task. Best-effort: se o logind/sistema estiver indisponível (ex.: containers),
/// loga e desiste sem derrubar o daemon (a ativação D-Bus + o watch de nome da ponte já cobrem o caso).
pub fn spawn(session: Connection) {
    tokio::spawn(async move {
        if let Err(err) = run(session).await {
            eprintln!("Etherbit daemon — monitor de energia (login1) indisponível: {err:#}");
        }
    });
}

async fn run(session: Connection) -> Result<()> {
    let system = Connection::system().await?;
    let logind = LogindManagerProxy::new(&system).await?;
    let mut sleeps = logind.receive_prepare_for_sleep().await?;
    println!("Etherbit daemon — monitor de energia (login1) ativo.");

    while let Some(signal) = sleeps.next().await {
        let resuming = match signal.args() {
            Ok(args) => !args.start,
            Err(_) => continue,
        };
        if resuming {
            // Retomando: cutuca os clientes a re-sincronizar re-emitindo ConfigChanged.
            if let Err(err) = reemit_config_changed(&session).await {
                eprintln!(
                    "Etherbit daemon — canal de sessão morto ao acordar; \
                     saindo para reativação D-Bus: {err:#}"
                );
                std::process::exit(0);
            }
        }
    }
    Ok(())
}

/// Re-emite o sinal `ConfigChanged` (mesma assinatura do contrato) no barramento de sessão. Lê a
/// config do disco (igual à de memória — toda mutação persiste). Erro ⇒ canal de sessão morto.
async fn reemit_config_changed(session: &Connection) -> Result<()> {
    let json = crate::config::Config::load_or_default()
        .map(|c| c.to_json())
        .unwrap_or_else(|_| "{}".to_string());
    session
        .emit_signal(Option::<&str>::None, OBJECT_PATH, BUS_NAME, "ConfigChanged", &(json,))
        .await?;
    Ok(())
}
