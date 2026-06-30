// service.rs — interface D-Bus `dev.ediano.etherbit.Preview` do helper de preview.
//
// Contrato mínimo (só geometria, no espírito do ADR 0029): `ShowPreview(x, y, w, h)` mostra/reposiciona
// o retângulo translúcido; `HidePreview()` o esconde. Os métodos só empurram o último estado para o
// canal `watch`; o desenho acontece no event loop Wayland (`overlay`). IDs/coords em pixels físicos.

use anyhow::Result;
use tokio::sync::watch;
use zbus::interface;

use crate::overlay::PreviewRect;

pub const BUS_NAME: &str = "dev.ediano.etherbit.Preview";
pub const OBJECT_PATH: &str = "/dev/ediano/etherbit/Preview";

pub struct Preview {
    tx: watch::Sender<Option<PreviewRect>>,
}

#[interface(name = "dev.ediano.etherbit.Preview")]
impl Preview {
    /// Mostra (ou reposiciona) o retângulo translúcido de preview na geometria física dada. `w`/`h`
    /// ≤ 0 escondem (degenera para `HidePreview`).
    fn show_preview(&self, x: i32, y: i32, width: i32, height: i32) {
        let next = if width > 0 && height > 0 {
            Some(PreviewRect { x, y, width, height })
        } else {
            None
        };
        let _ = self.tx.send_replace(next);
    }

    /// Esconde o preview (fim do arrasto ou zona `none`).
    fn hide_preview(&self) {
        let _ = self.tx.send_replace(None);
    }
}

/// Sobe o serviço no barramento de sessão. O `Sender` alimenta o event loop Wayland.
pub async fn serve(tx: watch::Sender<Option<PreviewRect>>) -> Result<zbus::Connection> {
    let preview = Preview { tx };
    let connection = zbus::connection::Builder::session()?
        .name(BUS_NAME)?
        .serve_at(OBJECT_PATH, preview)?
        .build()
        .await?;
    Ok(connection)
}
