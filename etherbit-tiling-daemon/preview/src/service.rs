// service.rs — interfaces D-Bus do helper de overlay do KDE. ADR 0029/0039.
//
// `dev.ediano.etherbit.Preview` (papel 1): `ShowPreview(x,y,w,h)`/`HidePreview()` — o retângulo
// translúcido do drag (espírito do ADR 0029: só geometria).
//
// `dev.ediano.etherbit.Tabs` (papel 2, ADR 0039): `ShowTabs(json)` publica as barras de abas (geometria
// + título + ativa); `HideTabs()` limpa; `DrainTabActions() -> json` devolve e esvazia a fila de cliques
// (ativar/fechar/desagrupar). Ambas as interfaces vivem no MESMO processo/objeto e empurram para o mesmo
// canal `watch` (`OverlayState`); o desenho/ponteiro acontece no event loop Wayland (`overlay`).

use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::watch;
use zbus::interface;

use crate::overlay::{OverlayState, PreviewRect};
use crate::tabs::{TabAction, TabBarView};

pub const BUS_NAME: &str = "dev.ediano.etherbit.Preview";
pub const OBJECT_PATH: &str = "/dev/ediano/etherbit/Preview";

/// Papel 1 — preview translúcido do drag.
pub struct Preview {
    tx: watch::Sender<OverlayState>,
}

#[interface(name = "dev.ediano.etherbit.Preview")]
impl Preview {
    /// Mostra (ou reposiciona) o retângulo translúcido de preview. `w`/`h` ≤ 0 escondem.
    fn show_preview(&self, x: i32, y: i32, width: i32, height: i32) {
        let next =
            if width > 0 && height > 0 { Some(PreviewRect { x, y, width, height }) } else { None };
        self.tx.send_modify(|s| s.preview = next);
    }

    /// Esconde o preview (fim do arrasto ou zona `none`).
    fn hide_preview(&self) {
        self.tx.send_modify(|s| s.preview = None);
    }
}

/// Papel 2 — barras de abas clicáveis (ADR 0039).
pub struct Tabs {
    tx: watch::Sender<OverlayState>,
    actions: Arc<Mutex<Vec<TabAction>>>,
}

#[interface(name = "dev.ediano.etherbit.Tabs")]
impl Tabs {
    /// Publica TODAS as barras de abas. `tabs_json` = array de `{stack_id,x,y,w,h,tabs:[{member_id,
    /// title,active}]}`. JSON inválido é ignorado (no-op), preservando as barras atuais.
    fn show_tabs(&self, tabs_json: String) {
        match serde_json::from_str::<Vec<TabBarView>>(&tabs_json) {
            Ok(bars) => self.tx.send_modify(|s| s.bars = bars),
            Err(err) => eprintln!("Etherbit tabs — ShowTabs JSON inválido: {err}"),
        }
    }

    /// Esconde todas as barras de abas.
    fn hide_tabs(&self) {
        self.tx.send_modify(|s| s.bars.clear());
    }

    /// Devolve e ESVAZIA a fila de ações acumuladas por cliques. JSON: `[{stack_id,member_id,kind}]`.
    fn drain_tab_actions(&self) -> String {
        let drained: Vec<TabAction> = match self.actions.lock() {
            Ok(mut q) => std::mem::take(&mut *q),
            Err(_) => Vec::new(),
        };
        serde_json::to_string(&drained).unwrap_or_else(|_| "[]".to_string())
    }
}

/// Sobe as DUAS interfaces no barramento de sessão, no mesmo objeto. O `Sender` alimenta o event loop
/// Wayland; `actions` é compartilhado com o overlay (que enfileira) e drenado por `DrainTabActions`.
pub async fn serve(
    tx: watch::Sender<OverlayState>,
    actions: Arc<Mutex<Vec<TabAction>>>,
) -> Result<zbus::Connection> {
    let preview = Preview { tx: tx.clone() };
    let tabs = Tabs { tx, actions };
    let connection = zbus::connection::Builder::session()?
        .name(BUS_NAME)?
        .serve_at(OBJECT_PATH, preview)?
        .serve_at(OBJECT_PATH, tabs)?
        .build()
        .await?;
    Ok(connection)
}
