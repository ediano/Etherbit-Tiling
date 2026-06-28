// protocol.rs — fronteira de serialização entre o contrato D-Bus (JSON) e os tipos do core.
//
// A ponte (extensão GNOME / KWin script) envia o conjunto atual de janelas tileáveis e as áreas
// úteis dos monitores como JSON; o daemon converte para os tipos PUROS do `etherbit-tiling-core`,
// chama `compute_layout` e devolve os retângulos-alvo (também JSON). Manter os DTOs serde aqui
// preserva o core sem dependências (ver ADR 0002/0003) — o core não conhece serde nem D-Bus.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use etherbit_tiling_core::{
    compute_layout, detect_drop_zone, is_tileable, DropPreview, DropZone, LayoutOptions,
    WindowInfo, WindowRect, WorkArea,
};

/// Janela vinda da ponte. Espelha `windows_json` do contrato D-Bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowDto {
    pub id: u64,
    #[serde(default)]
    pub app_id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    #[serde(default)]
    pub normal: bool,
    #[serde(default)]
    pub resizable: bool,
    #[serde(default)]
    pub maximizable: bool,
    #[serde(default)]
    pub monitor: u32,
    #[serde(default)]
    pub workspace: u32,
}

/// Área útil de um monitor. Espelha `monitors_json` do contrato D-Bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorDto {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Retângulo-alvo devolvido à ponte. Espelha `layout_json` do contrato D-Bus.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RectDto {
    pub id: u64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Zona de drop resolvida + retângulo de preview. Espelha `preview_json` do contrato D-Bus.
/// A `zone` viaja como string snake_case (mantém o core sem serde e o contrato legível).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreviewDto {
    pub zone: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Rótulo estável (snake_case) da zona para o contrato D-Bus.
fn zone_label(zone: DropZone) -> &'static str {
    match zone {
        DropZone::Left => "left",
        DropZone::Right => "right",
        DropZone::Top => "top",
        DropZone::Bottom => "bottom",
        DropZone::TopLeft => "top_left",
        DropZone::TopRight => "top_right",
        DropZone::BottomLeft => "bottom_left",
        DropZone::BottomRight => "bottom_right",
        DropZone::Center => "center",
        DropZone::None => "none",
    }
}

impl From<DropPreview> for PreviewDto {
    fn from(p: DropPreview) -> Self {
        PreviewDto {
            zone: zone_label(p.zone).to_string(),
            x: p.rect.x,
            y: p.rect.y,
            width: p.rect.width,
            height: p.rect.height,
        }
    }
}

impl From<WindowDto> for WindowInfo {
    fn from(w: WindowDto) -> Self {
        WindowInfo {
            id: w.id,
            x: w.x,
            y: w.y,
            width: w.width,
            height: w.height,
            app_id: w.app_id,
            normal: w.normal,
            resizable: w.resizable,
            maximizable: w.maximizable,
            monitor: w.monitor,
            workspace: w.workspace,
        }
    }
}

impl From<&MonitorDto> for WorkArea {
    fn from(m: &MonitorDto) -> Self {
        WorkArea { index: m.index, x: m.x, y: m.y, width: m.width, height: m.height }
    }
}

impl From<&WindowRect> for RectDto {
    fn from(r: &WindowRect) -> Self {
        RectDto { id: r.id, x: r.x, y: r.y, width: r.width, height: r.height }
    }
}

/// Pipeline completo do `SyncWindows`: parseia o JSON da ponte, aplica o filtro cirúrgico com a
/// `ignore_list` da config, calcula o layout no core e devolve o `layout_json`.
///
/// `windows_json` e `monitors_json` são arrays JSON; `layout_json` é um array `[{id,x,y,w,h}]`.
pub fn sync_windows(
    windows_json: &str,
    monitors_json: &str,
    ignore_list: &[String],
    opts: LayoutOptions,
) -> Result<String> {
    let windows: Vec<WindowDto> =
        serde_json::from_str(windows_json).context("windows_json inválido")?;
    let monitors: Vec<MonitorDto> =
        serde_json::from_str(monitors_json).context("monitors_json inválido")?;

    let areas: Vec<WorkArea> = monitors.iter().map(WorkArea::from).collect();

    // Filtro cirúrgico centralizado no core; a ponte é burra e pode enviar tudo.
    let tileable: Vec<WindowInfo> =
        windows.into_iter().map(WindowInfo::from).filter(|w| is_tileable(w, ignore_list)).collect();

    let rects = compute_layout(&tileable, &areas, &opts);
    let dtos: Vec<RectDto> = rects.iter().map(RectDto::from).collect();

    serde_json::to_string(&dtos).context("falha ao serializar layout_json")
}

/// Resolve a zona de drop sob o ponto `(x, y)`. Reaproveita o parse de monitores do `sync_windows`,
/// escolhe a área útil que CONTÉM o ponto e delega ao core (`detect_drop_zone`). Sem área contendo
/// o ponto → zona `"none"` (retângulo zerado). O daemon permanece sem estado: a ponte envia os
/// monitores a cada chamada, como em `SyncWindows`.
///
/// `window_id` entra no contrato agora (estabilidade) mas é reservado — futuro: excluir a própria
/// janela arrastada do cálculo sensível à pilha.
pub fn resolve_drop_zone(
    monitors_json: &str,
    x: i32,
    y: i32,
    _window_id: u64,
    opts: LayoutOptions,
) -> Result<String> {
    let monitors: Vec<MonitorDto> =
        serde_json::from_str(monitors_json).context("monitors_json inválido")?;

    let preview = monitors
        .iter()
        .find(|m| x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
        .map(|m| {
            let area = WorkArea::from(m);
            PreviewDto::from(detect_drop_zone(&area, x, y, &opts))
        })
        .unwrap_or(PreviewDto { zone: "none".to_string(), x: 0, y: 0, width: 0, height: 0 });

    serde_json::to_string(&preview).context("falha ao serializar preview_json")
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREAS: &str = r#"[{"index":0,"x":0,"y":0,"width":1000,"height":800}]"#;
    const OPTS: LayoutOptions = LayoutOptions { inner_gap: 8, outer_gap: 12 };

    fn win_json(id: u64, app: &str) -> String {
        format!(
            r#"{{"id":{id},"app_id":"{app}","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}}"#
        )
    }

    #[test]
    fn sync_lays_out_two_windows() {
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let out = sync_windows(&windows, AREAS, &[], OPTS).expect("ok");
        let rects: Vec<RectDto> = serde_json::from_str(&out).unwrap();
        assert_eq!(rects.len(), 2);
        assert_eq!(rects[0], RectDto { id: 1, x: 12, y: 12, width: 484, height: 776 });
        assert_eq!(rects[1], RectDto { id: 2, x: 504, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn sync_applies_ignore_list() {
        let windows = format!("[{},{}]", win_json(1, "firefox"), win_json(2, "kitty"));
        let out = sync_windows(&windows, AREAS, &["firefox".to_string()], OPTS).expect("ok");
        let rects: Vec<RectDto> = serde_json::from_str(&out).unwrap();
        // firefox é filtrada; sobra 1 janela ocupando a área inteira.
        assert_eq!(rects, vec![RectDto { id: 2, x: 12, y: 12, width: 976, height: 776 }]);
    }

    #[test]
    fn sync_filters_non_tileable() {
        // janela não-normal é descartada pelo filtro cirúrgico.
        let dialog = r#"{"id":9,"app_id":"x","x":0,"y":0,"width":10,"height":10,"normal":false,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}"#;
        let windows = format!("[{},{}]", win_json(1, "a"), dialog);
        let out = sync_windows(&windows, AREAS, &[], OPTS).expect("ok");
        let rects: Vec<RectDto> = serde_json::from_str(&out).unwrap();
        assert_eq!(rects.len(), 1);
        assert_eq!(rects[0].id, 1);
    }

    #[test]
    fn sync_rejects_invalid_json() {
        assert!(sync_windows("not json", AREAS, &[], OPTS).is_err());
        assert!(sync_windows("[]", "nope", &[], OPTS).is_err());
    }

    #[test]
    fn sync_empty_windows_yields_empty_layout() {
        let out = sync_windows("[]", AREAS, &[], OPTS).expect("ok");
        assert_eq!(out, "[]");
    }

    #[test]
    fn resolve_left_zone_in_single_monitor() {
        let out = resolve_drop_zone(AREAS, 20, 400, 0, OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "left".into(), x: 12, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn resolve_center_zone_matches_single_window() {
        let out = resolve_drop_zone(AREAS, 500, 400, 0, OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p.zone, "center");
        // Idêntico ao single-window do layout (consistência preview ↔ destino real).
        let layout = sync_windows(&format!("[{}]", win_json(1, "a")), AREAS, &[], OPTS).unwrap();
        let rects: Vec<RectDto> = serde_json::from_str(&layout).unwrap();
        assert_eq!(
            (p.x, p.y, p.width, p.height),
            (rects[0].x, rects[0].y, rects[0].width, rects[0].height)
        );
    }

    #[test]
    fn resolve_point_outside_any_monitor_is_none() {
        let out = resolve_drop_zone(AREAS, 5000, 400, 0, OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "none".into(), x: 0, y: 0, width: 0, height: 0 });
    }

    #[test]
    fn resolve_picks_correct_monitor() {
        // Dois monitores lado a lado; ponto perto da borda esquerda do SEGUNDO → Left local dele.
        let areas = r#"[{"index":0,"x":0,"y":0,"width":1000,"height":800},{"index":1,"x":1000,"y":0,"width":1000,"height":800}]"#;
        let out = resolve_drop_zone(areas, 1020, 400, 0, OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "left".into(), x: 1012, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn resolve_rejects_invalid_json() {
        assert!(resolve_drop_zone("nope", 20, 400, 0, OPTS).is_err());
    }
}
