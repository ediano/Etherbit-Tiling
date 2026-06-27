// config.rs — estado persistente do daemon (gaps, borda ativa, lista de exclusão, autostart).
//
// A configuração é a fonte de verdade do Etherbit no Linux. É serializada em TOML em
// `~/.config/etherbit-tiling/config.toml` e exposta à extensão como JSON via D-Bus.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

/// Configuração do motor de tiling, espelhada 1:1 com os controles da extensão.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Espaçamento entre janelas vizinhas (px).
    pub inner_gap: u32,
    /// Espaçamento entre as janelas e as bordas da tela (px).
    pub outer_gap: u32,
    /// Desenhar a borda na janela focada.
    pub active_border: bool,
    /// Cor da borda ativa (ex.: "#5e81ac").
    pub border_color: String,
    /// Espessura da borda ativa (px).
    pub border_width: u32,
    /// Classes/app-ids ignorados pelo algoritmo (ex.: "obs", "microsoft-word").
    pub ignore_list: Vec<String>,
    /// Iniciar o Etherbit com o sistema (gerencia o `.desktop` em ~/.config/autostart).
    pub autostart: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            inner_gap: 8,
            outer_gap: 12,
            active_border: true,
            border_color: "#5e81ac".to_string(),
            border_width: 2,
            ignore_list: Vec::new(),
            autostart: false,
        }
    }
}

impl Config {
    /// Caminho do arquivo de configuração (`~/.config/etherbit-tiling/config.toml`).
    pub fn path() -> Result<PathBuf> {
        let dirs = ProjectDirs::from("org", "etherbit", "tiling")
            .context("não foi possível resolver os diretórios do projeto (XDG)")?;
        Ok(dirs.config_dir().join("config.toml"))
    }

    /// Carrega a configuração do disco; se ausente ou inválida, retorna o padrão.
    pub fn load_or_default() -> Result<Self> {
        let path = Self::path()?;
        match fs::read_to_string(&path) {
            Ok(raw) => toml::from_str(&raw)
                .with_context(|| format!("config inválida em {}", path.display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(err).with_context(|| format!("falha ao ler {}", path.display())),
        }
    }

    /// Persiste a configuração em TOML, criando o diretório se necessário.
    pub fn persist(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("falha ao criar {}", parent.display()))?;
        }
        let raw = toml::to_string_pretty(self).context("falha ao serializar a config")?;
        fs::write(&path, raw).with_context(|| format!("falha ao escrever {}", path.display()))?;
        Ok(())
    }

    /// Serializa em JSON para trafegar no contrato D-Bus.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}
