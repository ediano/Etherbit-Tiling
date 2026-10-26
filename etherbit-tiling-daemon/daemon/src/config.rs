// config.rs — estado persistente do daemon (gaps, borda ativa, lista de exclusão, autostart).
//
// A configuração é a fonte de verdade do Etherbit no Linux. É serializada em TOML em
// `~/.config/etherbit-tiling/config.toml` e exposta à extensão como JSON via D-Bus.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

/// Um grupo `(monitor, workspace)` com o tiling DESLIGADO pelo usuário (Meta+Y). O monitor é o NOME
/// ESTÁVEL do output (conector, ex. "DP-1"), não o índice posicional — ADR 0056: o índice muda com
/// hotplug/reordenação e religaria o tiling no monitor errado. Persistido em `Config::disabled_groups`
/// (ADR 0057) para sobreviver ao reinício do KWin. Struct nomeada (não tupla) para serializar como
/// tabela TOML válida — TOML não aceita array heterogêneo `["DP-1", 0]`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DisabledGroup {
    pub monitor: String,
    pub workspace: u32,
}

/// Configuração do motor de tiling, espelhada 1:1 com os controles da extensão.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Chave geral do tiling. Quando `false`, as pontes (GNOME/KDE) param de enviar snapshots ao core
    /// e liberam as janelas para o comportamento flutuante do SO; o daemon segue vivo. `true` re-tila.
    pub enabled: bool,
    /// Espaçamento único (px): o mesmo valor controla o espaço entre janelas vizinhas E entre as
    /// janelas e as bordas da tela, em ambos os eixos. Aceita o nome legado `inner_gap` ao carregar
    /// configs antigas (o antigo `outer_gap` é ignorado).
    #[serde(alias = "inner_gap")]
    pub gap: u32,
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
    /// Altura (px) da faixa de cabeçalho reservada (geometricamente) no topo de um slot agrupado.
    /// O core a desconta do slot; quem desenha algo ali é a camada nativa. Aceita o nome legado
    /// `tab_bar_height` ao carregar configs antigas.
    #[serde(alias = "tab_bar_height")]
    pub group_header_px: u32,
    /// Arredondar os cantos das janelas gerenciadas (e do overlay/abas). No GNOME a extensão aplica
    /// um efeito; no KDE depende do efeito nativo de cantos arredondados do KWin.
    pub rounded_corners: bool,
    /// Raio (px) dos cantos arredondados.
    pub corner_radius: u32,
    /// Grupos `(monitor, workspace)` com o tiling DESLIGADO pelo usuário (Meta+Y no KDE). Preferência
    /// PERSISTIDA (ADR 0057) — como `gap`/`ignore_list` —, não estado transitório de layout: sobrevive
    /// ao reinício do KWin. A ponte hidrata o set em memória a partir daqui na carga e o reescreve via
    /// `SetDisabledGroups` a cada toggle. Vazio por padrão.
    pub disabled_groups: Vec<DisabledGroup>,
    /// Gap EXTERNO (px, entre janelas e bordas da tela) independente do interno. `None` = segue o
    /// `gap` único (comportamento histórico). ADR 0068.
    pub outer_gap: Option<u32>,
    /// Smart gaps (COSMIC): com uma única janela/stack no workspace, nenhum gap. ADR 0068.
    pub smart_gaps: bool,
    /// Política de inserção de janela nova: `"focus"` (COSMIC — racha a janela focada) ou `"cyclic"`
    /// (distribuição cíclica em quadrantes, ADR 0030). Valor desconhecido = `"focus"`. ADR 0068.
    pub insert_mode: String,
}

impl Config {
    /// `true` se a inserção segue a janela focada (default COSMIC).
    pub fn focus_insert(&self) -> bool {
        self.insert_mode != "cyclic"
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            gap: 8,
            active_border: true,
            border_color: "#5e81ac".to_string(),
            border_width: 2,
            ignore_list: Vec::new(),
            autostart: false,
            group_header_px: 28,
            rounded_corners: true,
            corner_radius: 12,
            disabled_groups: Vec::new(),
            outer_gap: None,
            smart_gaps: false,
            insert_mode: "focus".to_string(),
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
        assert!(cfg.enabled);
        assert_eq!(cfg.gap, 8);
        assert!(cfg.active_border);
        assert_eq!(cfg.border_color, "#5e81ac");
        assert_eq!(cfg.border_width, 2);
        assert!(cfg.ignore_list.is_empty());
        assert!(!cfg.autostart);
        assert_eq!(cfg.group_header_px, 28);
        assert!(cfg.rounded_corners);
        assert_eq!(cfg.corner_radius, 12);
        assert!(cfg.disabled_groups.is_empty());
    }

    #[test]
    fn to_json_is_parseable_with_all_fields() {
        let json = Config::default().to_json();
        let value: serde_json::Value = serde_json::from_str(&json).expect("JSON válido");
        for field in [
            "enabled",
            "gap",
            "active_border",
            "border_color",
            "border_width",
            "ignore_list",
            "autostart",
            "group_header_px",
            "rounded_corners",
            "corner_radius",
            "disabled_groups",
        ] {
            assert!(value.get(field).is_some(), "campo ausente: {field}");
        }
    }

    #[test]
    fn toml_round_trip_preserves_config() {
        let cfg = Config {
            enabled: false,
            gap: 4,
            active_border: false,
            border_color: "#bf616a".to_string(),
            border_width: 3,
            ignore_list: vec!["obs".to_string(), "microsoft-word".to_string()],
            autostart: true,
            group_header_px: 32,
            rounded_corners: false,
            corner_radius: 20,
            disabled_groups: vec![
                DisabledGroup { monitor: "DP-1".to_string(), workspace: 0 },
                DisabledGroup { monitor: "HDMI-A-1".to_string(), workspace: 2 },
            ],
            outer_gap: Some(16),
            smart_gaps: true,
            insert_mode: "cyclic".to_string(),
        };
        let raw = toml::to_string_pretty(&cfg).expect("serializa TOML");
        let back: Config = toml::from_str(&raw).expect("desserializa TOML");
        assert_eq!(back.enabled, cfg.enabled);
        assert_eq!(back.gap, cfg.gap);
        assert_eq!(back.rounded_corners, cfg.rounded_corners);
        assert_eq!(back.corner_radius, cfg.corner_radius);
        assert_eq!(back.outer_gap, Some(16));
        assert!(back.smart_gaps);
        assert!(!back.focus_insert());
        assert_eq!(back.active_border, cfg.active_border);
        assert_eq!(back.border_color, cfg.border_color);
        assert_eq!(back.border_width, cfg.border_width);
        assert_eq!(back.ignore_list, cfg.ignore_list);
        assert_eq!(back.autostart, cfg.autostart);
        assert_eq!(back.group_header_px, cfg.group_header_px);
        // ADR 0057: os grupos desligados (nome do output + workspace) sobrevivem ao round-trip TOML.
        assert_eq!(back.disabled_groups, cfg.disabled_groups);
    }

    #[test]
    fn loads_legacy_tab_bar_height_alias() {
        // Configs antigas no disco usam a chave `tab_bar_height`; o alias serde a aceita.
        let cfg: Config =
            toml::from_str("tab_bar_height = 40\n").expect("desserializa TOML legado");
        assert_eq!(cfg.group_header_px, 40);
    }

    #[test]
    fn json_round_trip_preserves_config() {
        let cfg = Config::default();
        let back: Config = serde_json::from_str(&cfg.to_json()).expect("desserializa JSON");
        assert_eq!(back.gap, cfg.gap);
        assert_eq!(back.border_color, cfg.border_color);
        assert_eq!(back.autostart, cfg.autostart);
    }

    #[test]
    fn partial_input_fills_missing_with_defaults() {
        // `#[serde(default)]` deve completar campos ausentes — espelha o parseConfig
        // defensivo da extensão e protege o contrato D-Bus.
        let cfg: Config = toml::from_str("gap = 20").expect("desserializa parcial");
        let defaults = Config::default();
        assert_eq!(cfg.gap, 20);
        assert_eq!(cfg.border_color, defaults.border_color);
        assert_eq!(cfg.autostart, defaults.autostart);

        let from_json: Config =
            serde_json::from_str("{\"border_width\": 5}").expect("JSON parcial");
        assert_eq!(from_json.border_width, 5);
        assert_eq!(from_json.gap, defaults.gap);
    }

    #[test]
    fn legacy_inner_gap_alias_migrates_to_gap() {
        // Configs antigas (inner_gap/outer_gap) ainda carregam: inner_gap → gap; outer_gap ignorado.
        let cfg: Config =
            toml::from_str("inner_gap = 20\nouter_gap = 30").expect("desserializa legado");
        assert_eq!(cfg.gap, 20);
    }
}
