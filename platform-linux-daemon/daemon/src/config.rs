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
    /// Altura (px) da barra de abas desenhada no topo de um quadrante empilhado.
    pub tab_bar_height: u32,
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
            tab_bar_height: 28,
        }
    }
}

impl Config {
    /// Caminho do arquivo de configuração (`~/.config/etherbit-tiling/config.toml`).
    pub fn path() -> Result<PathBuf> {
        let dirs = ProjectDirs::from("dev", "ediano", "tiling")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_has_expected_values() {
        let cfg = Config::default();
        assert_eq!(cfg.inner_gap, 8);
        assert_eq!(cfg.outer_gap, 12);
        assert!(cfg.active_border);
        assert_eq!(cfg.border_color, "#5e81ac");
        assert_eq!(cfg.border_width, 2);
        assert!(cfg.ignore_list.is_empty());
        assert!(!cfg.autostart);
        assert_eq!(cfg.tab_bar_height, 28);
    }

    #[test]
    fn to_json_is_parseable_with_all_fields() {
        let json = Config::default().to_json();
        let value: serde_json::Value = serde_json::from_str(&json).expect("JSON válido");
        for field in [
            "inner_gap",
            "outer_gap",
            "active_border",
            "border_color",
            "border_width",
            "ignore_list",
            "autostart",
            "tab_bar_height",
        ] {
            assert!(value.get(field).is_some(), "campo ausente: {field}");
        }
    }

    #[test]
    fn toml_round_trip_preserves_config() {
        let cfg = Config {
            inner_gap: 4,
            outer_gap: 16,
            active_border: false,
            border_color: "#bf616a".to_string(),
            border_width: 3,
            ignore_list: vec!["obs".to_string(), "microsoft-word".to_string()],
            autostart: true,
            tab_bar_height: 32,
        };
        let raw = toml::to_string_pretty(&cfg).expect("serializa TOML");
        let back: Config = toml::from_str(&raw).expect("desserializa TOML");
        assert_eq!(back.inner_gap, cfg.inner_gap);
        assert_eq!(back.outer_gap, cfg.outer_gap);
        assert_eq!(back.active_border, cfg.active_border);
        assert_eq!(back.border_color, cfg.border_color);
        assert_eq!(back.border_width, cfg.border_width);
        assert_eq!(back.ignore_list, cfg.ignore_list);
        assert_eq!(back.autostart, cfg.autostart);
        assert_eq!(back.tab_bar_height, cfg.tab_bar_height);
    }

    #[test]
    fn json_round_trip_preserves_config() {
        let cfg = Config::default();
        let back: Config = serde_json::from_str(&cfg.to_json()).expect("desserializa JSON");
        assert_eq!(back.inner_gap, cfg.inner_gap);
        assert_eq!(back.border_color, cfg.border_color);
        assert_eq!(back.autostart, cfg.autostart);
    }

    #[test]
    fn partial_input_fills_missing_with_defaults() {
        // `#[serde(default)]` deve completar campos ausentes — espelha o parseConfig
        // defensivo da extensão e protege o contrato D-Bus.
        let cfg: Config = toml::from_str("inner_gap = 20").expect("desserializa parcial");
        let defaults = Config::default();
        assert_eq!(cfg.inner_gap, 20);
        assert_eq!(cfg.outer_gap, defaults.outer_gap);
        assert_eq!(cfg.border_color, defaults.border_color);
        assert_eq!(cfg.autostart, defaults.autostart);

        let from_json: Config =
            serde_json::from_str("{\"border_width\": 5}").expect("JSON parcial");
        assert_eq!(from_json.border_width, 5);
        assert_eq!(from_json.inner_gap, defaults.inner_gap);
    }
}
