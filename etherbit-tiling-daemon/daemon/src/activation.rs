// activation.rs — instala o arquivo de ATIVAÇÃO D-Bus de sessão do daemon.
//
// Sem ativação, o daemon só sobe no login (autostart `.desktop`); se ele morre/é congelado na
// suspensão, ninguém o traz de volta e o tiling "para até o reboot". Com um `.service` de ativação
// em ~/.local/share/dbus-1/services/, o `dbus-daemon` RELANÇA o daemon sob demanda: qualquer chamada
// ao nome `dev.ediano.etherbit.Tiling` o inicia se estiver fora. Vale para GNOME e KDE (ambos os
// clientes acionam a ativação ao chamar um método). Ver ADR rules/0020.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use directories::BaseDirs;

use crate::service::BUS_NAME;

/// Nome do arquivo de serviço (deve ser `<bus name>.service`).
const SERVICE_FILE: &str = "dev.ediano.etherbit.Tiling.service";

/// Caminho do `.service` em `~/.local/share/dbus-1/services/`.
fn service_path() -> Result<PathBuf> {
    let base = BaseDirs::new().context("não foi possível resolver o diretório base (HOME)")?;
    Ok(base.data_dir().join("dbus-1").join("services").join(SERVICE_FILE))
}

/// Conteúdo do `.service` para um `exec` dado. Função pura, testável.
fn service_contents_for(exec: &str) -> String {
    format!(
        "[D-BUS Service]\n\
         Name={BUS_NAME}\n\
         Exec={exec}\n"
    )
}

/// Conteúdo do `.service` apontando para o próprio binário do daemon (resolvido em runtime).
fn service_contents() -> String {
    let exec = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| "etherbit-tiling-daemon".to_string());
    service_contents_for(&exec)
}

/// Escreve (idempotente) o arquivo de ativação D-Bus. Best-effort: o chamador loga e segue se falhar
/// (a ativação é uma melhoria de resiliência, não um pré-requisito para o daemon rodar).
pub fn install() -> Result<()> {
    let path = service_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("falha ao criar {}", parent.display()))?;
    }
    fs::write(&path, service_contents())
        .with_context(|| format!("falha ao escrever {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_contents_has_required_keys() {
        let contents = service_contents_for("/usr/bin/etherbit-tiling-daemon");
        assert!(contents.starts_with("[D-BUS Service]\n"));
        assert!(contents.contains("Name=dev.ediano.etherbit.Tiling\n"));
        assert!(contents.contains("Exec=/usr/bin/etherbit-tiling-daemon\n"));
    }

    #[test]
    fn service_file_name_matches_bus_name() {
        // O nome do arquivo DEVE ser "<bus name>.service" para o dbus-daemon achar a ativação.
        assert_eq!(SERVICE_FILE, format!("{BUS_NAME}.service"));
    }
}
