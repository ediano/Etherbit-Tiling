// autostart.rs — gerencia o manifesto `.desktop` em ~/.config/autostart.
//
// "Iniciar com o sistema": quando ligado, criamos um `.desktop` que o GNOME executa no login;
// quando desligado, removemos o arquivo. O nome casa com o UUID da extensão para rastreabilidade.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use directories::BaseDirs;

/// Nome do manifesto, alinhado ao UUID da extensão (ver ADR de nomenclatura D-Bus/UUID).
const DESKTOP_FILE: &str = "tiling@etherbit.org.desktop";

/// Caminho completo do `.desktop` em `~/.config/autostart`.
fn desktop_path() -> Result<PathBuf> {
    let base = BaseDirs::new().context("não foi possível resolver o diretório base (HOME)")?;
    Ok(base.config_dir().join("autostart").join(DESKTOP_FILE))
}

/// Conteúdo do manifesto. `Exec` aponta para o próprio binário do daemon, resolvido em runtime.
fn desktop_contents() -> String {
    let exec = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| "etherbit-tiling-daemon".to_string());

    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Etherbit Tiling\n\
         Comment=O tecido invisível que coloca suas janelas em órbita perfeita.\n\
         Exec={exec}\n\
         X-GNOME-Autostart-enabled=true\n\
         NoDisplay=true\n"
    )
}

/// Cria (enabled=true) ou remove (enabled=false) o manifesto de autostart. Idempotente.
pub fn apply(enabled: bool) -> Result<()> {
    let path = desktop_path()?;

    if enabled {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("falha ao criar {}", parent.display()))?;
        }
        fs::write(&path, desktop_contents())
            .with_context(|| format!("falha ao escrever {}", path.display()))?;
    } else {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err).with_context(|| format!("falha ao remover {}", path.display()))
            }
        }
    }

    Ok(())
}
