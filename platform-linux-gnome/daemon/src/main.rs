// main.rs — daemon roteador do Etherbit Tiling (Linux/GNOME).
//
// Sobe o serviço D-Bus `org.etherbit.Tiling` no barramento de sessão e fica em background.
// A extensão GNOME conversa com este daemon para ler/alterar a configuração; o algoritmo
// agnóstico (Ether Flow, no crate `etherbit-tiling-core`) será plugado aqui em etapas futuras.

mod autostart;
mod config;
mod service;

use anyhow::Result;
use config::Config;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::load_or_default()?;

    // Reaplica o autostart na inicialização para manter o `.desktop` coerente com a config.
    autostart::apply(config.autostart)?;

    let _connection = service::serve(config).await?;

    println!(
        "Etherbit daemon — core {} — servindo {} em {}",
        etherbit_tiling_core::version(),
        service::BUS_NAME,
        service::OBJECT_PATH
    );

    // Mantém o daemon vivo até SIGINT/SIGTERM (encerramento limpo pelo sistema).
    tokio::signal::ctrl_c().await?;
    println!("Etherbit daemon — encerrando.");

    Ok(())
}
