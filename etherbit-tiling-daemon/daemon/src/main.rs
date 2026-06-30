// main.rs — daemon roteador do Etherbit Tiling (Linux/GNOME).
//
// Sobe o serviço D-Bus `dev.ediano.etherbit.Tiling` no barramento de sessão e fica em background.
// A extensão GNOME conversa com este daemon para ler/alterar a configuração; o algoritmo
// agnóstico (Ether Flow, no crate `etherbit-tiling-core`) será plugado aqui em etapas futuras.

mod activation;
mod autostart;
mod config;
mod obs;
mod powermon;
mod protocol;
mod service;

use anyhow::Result;
use config::Config;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::load_or_default()?;

    // Reaplica o autostart na inicialização para manter o `.desktop` coerente com a config.
    autostart::apply(config.autostart)?;

    // Instala (idempotente) o arquivo de ativação D-Bus, para o daemon ser RELANÇADO sob demanda se
    // morrer/congelar (ex.: após suspensão). Best-effort: nunca impede o daemon de subir.
    if let Err(err) = activation::install() {
        eprintln!("Etherbit daemon — ativação D-Bus indisponível: {err:#}");
    }

    let connection = service::serve(config).await?;

    println!(
        "Etherbit daemon — core {} — servindo {} em {}",
        etherbit_tiling_core::version(),
        service::BUS_NAME,
        service::OBJECT_PATH
    );

    // Monitor de energia (login1): ao acordar da suspensão, re-emite ConfigChanged para os clientes
    // re-sincronizarem; se o canal de sessão tiver morrido, sai para a ativação D-Bus subir um novo.
    powermon::spawn(connection.clone());

    // Mantém o daemon vivo até SIGINT/SIGTERM (encerramento limpo pelo sistema).
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
    println!("Etherbit daemon — encerrando.");

    Ok(())
}
