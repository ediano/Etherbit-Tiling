// main.rs — daemon roteador do Etherbit Tiling (Linux/GNOME).
//
// Sobe o serviço D-Bus `dev.ediano.etherbit.Tiling` no barramento de sessão e fica em background.
// A extensão GNOME conversa com este daemon para ler/alterar a configuração; o algoritmo
// agnóstico (Ether Flow, no crate `etherbit-tiling-core`) será plugado aqui em etapas futuras.

mod activation;
mod autostart;
mod config;
#[cfg(feature = "wgpu-ui")]
mod layer;
mod obs;
mod powermon;
mod protocol;
#[cfg(feature = "wgpu-ui")]
mod render;
mod service;
// Modelo + hit-testing da barra de abas (puro, sem GPU). Compilado com a UI wgpu ou em testes.
#[cfg(any(feature = "wgpu-ui", test))]
mod tabbar;

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

    // UI própria do daemon (wgpu) — opcional, atrás da feature `wgpu-ui`. Inicializa o pipeline
    // gráfico com fallback automático para software (LLVMpipe) quando não há GPU.
    #[cfg(feature = "wgpu-ui")]
    let render_ctx = match render::init_render().await {
        Ok(ctx) => {
            println!("Etherbit daemon — wgpu pronto: {}", ctx.describe());
            if ctx.is_software_fallback() {
                eprintln!(
                    "Etherbit daemon — wgpu em rasterização por software (sem aceleração 3D); \
                     operando em modo de degradação suave."
                );
            }
            Some(ctx)
        }
        Err(err) => {
            eprintln!("Etherbit daemon — wgpu indisponível: {err:#}");
            None
        }
    };

    let (connection, shared) = service::serve(config).await?;
    // `shared` (fila de ações de aba + receptor de barras) só é consumido pela UI wgpu; sem a feature
    // ele é intencionalmente ocioso.
    #[cfg(not(feature = "wgpu-ui"))]
    let _ = shared;

    println!(
        "Etherbit daemon — core {} — servindo {} em {}",
        etherbit_tiling_core::version(),
        service::BUS_NAME,
        service::OBJECT_PATH
    );

    // Monitor de energia (login1): ao acordar da suspensão, re-emite ConfigChanged para os clientes
    // re-sincronizarem; se o canal de sessão tiver morrido, sai para a ativação D-Bus subir um novo.
    powermon::spawn(connection.clone());

    // Barra de abas via overlay wgpu (KDE/wlr-layer-shell): monta a orquestração quando o wgpu
    // inicializou e sobe o event loop layer-shell em background. Fora de uma sessão com layer-shell
    // (CI/headless/GNOME) o loop encerra graciosamente — a barra do GNOME segue na extensão.
    #[cfg(feature = "wgpu-ui")]
    if let Some(ctx) = render_ctx {
        let overlay =
            layer::TabBarOverlay::new(ctx, connection.clone(), shared.pending_actions.clone());
        println!("Etherbit daemon — overlay de abas pronto (formato {:?}).", overlay.format());
        let bars_rx = shared.bars_rx.clone();
        let hud_rx = shared.hud_rx.clone();
        tokio::spawn(async move {
            if let Err(err) = layer::run_event_loop(overlay, bars_rx, hud_rx).await {
                eprintln!("Etherbit daemon — overlay de abas indisponível: {err:#}");
            }
        });
    }

    // Mantém o daemon vivo até SIGINT/SIGTERM (encerramento limpo pelo sistema).
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
    println!("Etherbit daemon — encerrando.");

    Ok(())
}
