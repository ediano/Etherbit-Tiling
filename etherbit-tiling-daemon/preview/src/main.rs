// main.rs — helper de overlay do Etherbit Tiling (KDE). ADR 0029/0031/0039.
//
// Processo SEPARADO do daemon de geometria (ADR 0029: o daemon não contém framework visual). Sobe no
// barramento de sessão DUAS interfaces D-Bus — `dev.ediano.etherbit.Preview` (preview translúcido do
// drag) e `dev.ediano.etherbit.Tabs` (barras de abas clicáveis, ADR 0039) — e um event loop Wayland
// (wlr-layer-shell + SHM, sem GPU) que desenha ambos e captura o ponteiro sobre as abas. O KWin Script
// (ponte burra) aciona tudo por D-Bus.
//
// Fluxo das abas: ShowTabs/HideTabs → canal `watch` → desenho; clique → fila `actions` + wake →
// `invokeShortcut` (kglobalaccel) → o script chama `DrainTabActions` e aplica.
//
// Fora de uma sessão Wayland com layer-shell (CI/headless/Mutter) o loop encerra GRACIOSO: as interfaces
// D-Bus seguem no ar (os comandos viram no-op), então nada quebra.

mod kglobalaccel;
mod overlay;
mod service;
mod tabs;
mod text;

use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::{mpsc, watch};

use crate::overlay::OverlayState;
use crate::tabs::TabAction;

#[tokio::main]
async fn main() -> Result<()> {
    // Canal do estado do overlay: preview (drag) + barras de abas.
    let (tx, rx) = watch::channel::<OverlayState>(OverlayState::default());
    // Fila de ações dos cliques nas abas — compartilhada entre o overlay (enfileira) e o D-Bus (drena).
    let actions: Arc<Mutex<Vec<TabAction>>> = Arc::new(Mutex::new(Vec::new()));
    // Canal de wake: o overlay sinaliza um clique; a task do kglobalaccel dispara o invokeShortcut.
    let (wake_tx, wake_rx) = mpsc::unbounded_channel::<()>();

    let _connection = service::serve(tx, actions.clone()).await?;
    println!("Etherbit preview — servindo {} em {}", service::BUS_NAME, service::OBJECT_PATH);

    // Gatilho de retorno helper → KWin Script (best-effort; validado em sessão KDE real).
    tokio::spawn(kglobalaccel::run(wake_rx));

    // O event loop Wayland é bloqueante (calloop): roda numa thread dedicada. É o ÚNICO ponto que exige
    // uma sessão Wayland real com wlr-layer-shell (KWin) — validado em hardware, não no CI.
    let wayland = tokio::task::spawn_blocking(move || overlay::run(rx, actions, wake_tx));

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
