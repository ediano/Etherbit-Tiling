// main.rs — helper de PREVIEW translúcido do Etherbit Tiling (KDE).
//
// Sobe o serviço D-Bus `dev.ediano.etherbit.Preview` no barramento de sessão e um event loop Wayland
// (wlr-layer-shell) que desenha UM retângulo translúcido (SHM, sem GPU) durante o arrasto. O KWin
// Script (ponte burra) o aciona por `ShowPreview`/`HidePreview`. Processo SEPARADO do daemon de
// geometria (ADR 0029: o daemon não contém framework visual — a apresentação vive na camada nativa).
// Fora de uma sessão Wayland com layer-shell (CI/headless/Mutter) o loop encerra GRACIOSO: o serviço
// D-Bus segue no ar (os comandos viram no-op), então nada quebra.

mod overlay;
mod service;

use anyhow::Result;
use tokio::sync::watch;

#[tokio::main]
async fn main() -> Result<()> {
    // Canal do ÚLTIMO estado do preview: Some(rect) = mostrar/reposicionar; None = esconder.
    let (tx, rx) = watch::channel::<Option<overlay::PreviewRect>>(None);

    let _connection = service::serve(tx).await?;
    println!(
        "Etherbit preview — servindo {} em {}",
        service::BUS_NAME,
        service::OBJECT_PATH
    );

    // O event loop Wayland é bloqueante (calloop): roda numa thread dedicada. É o ÚNICO ponto que
    // exige uma sessão Wayland real com wlr-layer-shell (KWin) — validado em hardware, não no CI.
    let wayland = tokio::task::spawn_blocking(move || overlay::run(rx));

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
        r = wayland => {
            if let Ok(Err(err)) = r {
                eprintln!("Etherbit preview — loop Wayland encerrou com erro: {err:#}");
            }
        }
    }
    println!("Etherbit preview — encerrando.");
    Ok(())
}
