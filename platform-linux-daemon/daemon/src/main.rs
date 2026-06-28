// main.rs — daemon roteador do Etherbit Tiling (Linux/GNOME).
//
// Sobe o serviço D-Bus `dev.ediano.etherbit.Tiling` no barramento de sessão e fica em background.
// A extensão GNOME conversa com este daemon para ler/alterar a configuração; o algoritmo
// agnóstico (Ether Flow, no crate `etherbit-tiling-core`) será plugado aqui em etapas futuras.

mod autostart;
mod config;
mod protocol;
#[cfg(feature = "wgpu-ui")]
mod render;
mod service;

use anyhow::Result;
use config::Config;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::load_or_default()?;

    // Reaplica o autostart na inicialização para manter o `.desktop` coerente com a config.
    autostart::apply(config.autostart)?;

    // UI própria do daemon (wgpu) — opcional, atrás da feature `wgpu-ui`. Inicializa o pipeline
    // gráfico com fallback automático para software (LLVMpipe) quando não há GPU.
    #[cfg(feature = "wgpu-ui")]
    match render::init_render().await {
        Ok(ctx) => {
            println!("Etherbit daemon — wgpu pronto: {}", ctx.describe());
            if ctx.is_software_fallback() {
                eprintln!(
                    "Etherbit daemon — wgpu em rasterização por software (sem aceleração 3D); \
                     operando em modo de degradação suave."
                );
            }
        }
        Err(err) => eprintln!("Etherbit daemon — wgpu indisponível: {err:#}"),
    }

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
