// protocol.rs — fronteira de serialização entre o contrato D-Bus (JSON) e os tipos do core.
//
// A ponte (extensão GNOME / KWin script) envia o conjunto atual de janelas tileáveis e as áreas
// úteis dos monitores como JSON; o daemon converte para os tipos PUROS do `etherbit-tiling-core`,
// chama `compute_layout` e devolve os retângulos-alvo (também JSON). Manter os DTOs serde aqui
// preserva o core sem dependências (ver ADR 0002/0003) — o core não conhece serde nem D-Bus.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use etherbit_tiling_core::{
    compute_layout_with, detect_drop_target, is_tileable, DropPreview, DropZone, LayoutOptions,
    PreviewRect, StackDescriptor, StackGroup, TabBarRect, WindowInfo, WindowRect, WorkArea,
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

/// Retângulo simples (sem id). Usado pelo `content` de uma barra de abas e pelo `target_json` do drag.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct GeomDto {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Estado leve enviado pela ponte em cada `SyncWindows`: os stacks (abas) e os grupos com tiling
/// desligado. Todos os campos com `#[serde(default)]` para o `state_json` ser retrocompatível.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncStateDto {
    #[serde(default)]
    pub stacks: Vec<StackDto>,
    /// Pares `(monitor, workspace)` com tiling desligado (janelas flutuam livres).
    #[serde(default)]
    pub disabled_groups: Vec<(u32, u32)>,
}

/// Um stack vindo da ponte: membros (ordem das abas) + aba ativa, no grupo `(monitor, workspace)`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StackDto {
    #[serde(default)]
    pub monitor: u32,
    #[serde(default)]
    pub workspace: u32,
    #[serde(default)]
    pub members: Vec<u64>,
    #[serde(default)]
    pub active: u64,
}

/// Barra de abas devolvida à ponte: faixa no topo + conteúdo da aba ativa + membros/ativa.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TabBarDto {
    pub stack_id: u64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub content: GeomDto,
    pub members: Vec<u64>,
    pub active: u64,
}

/// Saída do `SyncWindows`: retângulos visíveis + barras de abas. Espelha `layout_json` (objeto).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LayoutResultDto {
    pub rects: Vec<RectDto>,
    pub tab_bars: Vec<TabBarDto>,
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
        DropZone::Stack => "stack",
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

impl From<&TabBarRect> for TabBarDto {
    fn from(t: &TabBarRect) -> Self {
        TabBarDto {
            stack_id: t.stack_id,
            x: t.x,
            y: t.y,
            width: t.width,
            height: t.height,
            content: GeomDto {
                x: t.content.x,
                y: t.content.y,
                width: t.content.width,
                height: t.content.height,
            },
            members: t.member_ids.clone(),
            active: t.active_id,
        }
    }
}

/// Constrói os `StackGroup` do core a partir do `state_json`. Cada `StackDto` vira um grupo de um
/// único stack; o core concatena grupos do mesmo `(monitor, workspace)`.
fn stack_groups_from(state: &SyncStateDto) -> Vec<StackGroup> {
    state
        .stacks
        .iter()
        .map(|s| StackGroup {
            monitor: s.monitor,
            workspace: s.workspace,
            stacks: vec![StackDescriptor { member_ids: s.members.clone(), active_id: s.active }],
        })
        .collect()
}

/// Parseia o `state_json` (string vazia/ausente → estado padrão, sem stacks nem grupos desligados).
fn parse_state(state_json: &str) -> Result<SyncStateDto> {
    if state_json.trim().is_empty() {
        return Ok(SyncStateDto::default());
    }
    serde_json::from_str(state_json).context("state_json inválido")
}

/// Pipeline completo do `SyncWindows`: parseia o JSON da ponte, aplica o filtro cirúrgico com a
/// `ignore_list` da config, calcula o layout no core (com stacks e grupos desligados do `state_json`)
/// e devolve o `layout_json`.
///
/// `windows_json`/`monitors_json` são arrays JSON; `state_json` é um objeto (ou `""`); `layout_json`
/// é um objeto `{ "rects": [{id,x,y,w,h}], "tab_bars": [...] }`.
pub fn sync_windows(
    windows_json: &str,
    monitors_json: &str,
    state_json: &str,
    ignore_list: &[String],
    opts: LayoutOptions,
) -> Result<String> {
    let windows: Vec<WindowDto> =
        serde_json::from_str(windows_json).context("windows_json inválido")?;
    let monitors: Vec<MonitorDto> =
        serde_json::from_str(monitors_json).context("monitors_json inválido")?;
    let state = parse_state(state_json)?;

    let areas: Vec<WorkArea> = monitors.iter().map(WorkArea::from).collect();

    // Filtro cirúrgico centralizado no core; a ponte é burra e pode enviar tudo.
    let tileable: Vec<WindowInfo> =
        windows.into_iter().map(WindowInfo::from).filter(|w| is_tileable(w, ignore_list)).collect();

    let stacks = stack_groups_from(&state);
    let result = compute_layout_with(&tileable, &areas, &opts, &stacks, &state.disabled_groups);

    let dto = LayoutResultDto {
        rects: result.rects.iter().map(RectDto::from).collect(),
        tab_bars: result.tab_bars.iter().map(TabBarDto::from).collect(),
    };
    serde_json::to_string(&dto).context("falha ao serializar layout_json")
}

/// Resolve o destino de um drop sob o ponto `(x, y)`. Escolhe a área útil que CONTÉM o ponto e
/// delega ao core (`detect_drop_target`), passando o retângulo da janela sob o cursor (`target_json`,
/// ou `""` se não há janela-alvo) para detectar empilhamento. Sem área contendo o ponto → zona
/// `"none"`. O daemon permanece sem estado: a ponte envia monitores e alvo a cada chamada.
pub fn resolve_drop_zone(
    monitors_json: &str,
    x: i32,
    y: i32,
    target_json: &str,
    opts: LayoutOptions,
) -> Result<String> {
    let monitors: Vec<MonitorDto> =
        serde_json::from_str(monitors_json).context("monitors_json inválido")?;
    let target = parse_target(target_json)?;

    let preview = monitors
        .iter()
        .find(|m| x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
        .map(|m| {
            let area = WorkArea::from(m);
            PreviewDto::from(detect_drop_target(&area, target, x, y, &opts))
        })
        .unwrap_or(PreviewDto { zone: "none".to_string(), x: 0, y: 0, width: 0, height: 0 });

    serde_json::to_string(&preview).context("falha ao serializar preview_json")
}

/// Parseia o `target_json` (retângulo da janela sob o cursor; `""` → `None`).
fn parse_target(target_json: &str) -> Result<Option<PreviewRect>> {
    if target_json.trim().is_empty() {
        return Ok(None);
    }
    let g: GeomDto = serde_json::from_str(target_json).context("target_json inválido")?;
    Ok(Some(PreviewRect { x: g.x, y: g.y, width: g.width, height: g.height }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREAS: &str = r#"[{"index":0,"x":0,"y":0,"width":1000,"height":800}]"#;
    const OPTS: LayoutOptions = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };

    fn win_json(id: u64, app: &str) -> String {
        format!(
            r#"{{"id":{id},"app_id":"{app}","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}}"#
        )
    }

    fn layout_of(out: &str) -> LayoutResultDto {
        serde_json::from_str(out).expect("layout_json válido")
    }

    #[test]
    fn sync_lays_out_two_windows() {
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let out = sync_windows(&windows, AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert_eq!(res.rects.len(), 2);
        assert!(res.tab_bars.is_empty());
        assert_eq!(res.rects[0], RectDto { id: 1, x: 12, y: 12, width: 484, height: 776 });
        assert_eq!(res.rects[1], RectDto { id: 2, x: 504, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn sync_applies_ignore_list() {
        let windows = format!("[{},{}]", win_json(1, "firefox"), win_json(2, "kitty"));
        let out = sync_windows(&windows, AREAS, "", &["firefox".to_string()], OPTS).expect("ok");
        let res = layout_of(&out);
        // firefox é filtrada; sobra 1 janela ocupando a área inteira.
        assert_eq!(res.rects, vec![RectDto { id: 2, x: 12, y: 12, width: 976, height: 776 }]);
    }

    #[test]
    fn sync_filters_non_tileable() {
        // janela não-normal é descartada pelo filtro cirúrgico.
        let dialog = r#"{"id":9,"app_id":"x","x":0,"y":0,"width":10,"height":10,"normal":false,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}"#;
        let windows = format!("[{},{}]", win_json(1, "a"), dialog);
        let out = sync_windows(&windows, AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 1);
    }

    #[test]
    fn sync_rejects_invalid_json() {
        assert!(sync_windows("not json", AREAS, "", &[], OPTS).is_err());
        assert!(sync_windows("[]", "nope", "", &[], OPTS).is_err());
        assert!(sync_windows("[]", AREAS, "{bad", &[], OPTS).is_err());
    }

    #[test]
    fn sync_empty_windows_yields_empty_layout() {
        let out = sync_windows("[]", AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert!(res.rects.is_empty());
        assert!(res.tab_bars.is_empty());
    }

    #[test]
    fn sync_with_empty_state_matches_legacy() {
        // `state_json` vazio == sem stacks nem grupos desligados (só `rects`, `tab_bars` vazio).
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let out = sync_windows(&windows, AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert_eq!(res.rects.len(), 2);
        assert!(res.tab_bars.is_empty());
    }

    #[test]
    fn sync_parses_stack_and_emits_tab_bar() {
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let state = r#"{"stacks":[{"monitor":0,"workspace":0,"members":[1,2],"active":2}]}"#;
        let out = sync_windows(&windows, AREAS, state, &[], OPTS).expect("ok");
        let res = layout_of(&out);
        // Único slot (o stack): só a ativa (2) visível, abaixo da barra; 1 barra de abas.
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 2);
        assert_eq!(res.tab_bars.len(), 1);
        let bar = &res.tab_bars[0];
        assert_eq!(bar.members, vec![1, 2]);
        assert_eq!(bar.active, 2);
        assert_eq!(bar.stack_id, 1);
        assert_eq!((bar.x, bar.y, bar.width, bar.height), (12, 12, 976, 28));
        assert_eq!(bar.content, GeomDto { x: 12, y: 40, width: 976, height: 748 });
    }

    #[test]
    fn sync_skips_disabled_group() {
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let state = r#"{"disabled_groups":[[0,0]]}"#;
        let out = sync_windows(&windows, AREAS, state, &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert!(res.rects.is_empty());
        assert!(res.tab_bars.is_empty());
    }

    #[test]
    fn sync_state_json_is_backward_default() {
        // Campos ausentes em StackDto preenchem com default (espelha o config parcial).
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let state = r#"{"stacks":[{"members":[1,2]}]}"#; // sem monitor/workspace/active
        let out = sync_windows(&windows, AREAS, state, &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert_eq!(res.tab_bars.len(), 1);
        assert_eq!(res.tab_bars[0].members, vec![1, 2]);
        // active default (0) ausente dos membros → primeiro presente (1).
        assert_eq!(res.tab_bars[0].active, 1);
    }

    #[test]
    fn resolve_left_zone_in_single_monitor() {
        let out = resolve_drop_zone(AREAS, 20, 400, "", OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "left".into(), x: 12, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn resolve_center_zone_matches_single_window() {
        let out = resolve_drop_zone(AREAS, 500, 400, "", OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p.zone, "center");
        // Idêntico ao single-window do layout (consistência preview ↔ destino real).
        let layout =
            sync_windows(&format!("[{}]", win_json(1, "a")), AREAS, "", &[], OPTS).unwrap();
        let res = layout_of(&layout);
        assert_eq!(
            (p.x, p.y, p.width, p.height),
            (res.rects[0].x, res.rects[0].y, res.rects[0].width, res.rects[0].height)
        );
    }

    #[test]
    fn resolve_point_outside_any_monitor_is_none() {
        let out = resolve_drop_zone(AREAS, 5000, 400, "", OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "none".into(), x: 0, y: 0, width: 0, height: 0 });
    }

    #[test]
    fn resolve_picks_correct_monitor() {
        // Dois monitores lado a lado; ponto perto da borda esquerda do SEGUNDO → Left local dele.
        let areas = r#"[{"index":0,"x":0,"y":0,"width":1000,"height":800},{"index":1,"x":1000,"y":0,"width":1000,"height":800}]"#;
        let out = resolve_drop_zone(areas, 1020, 400, "", OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "left".into(), x: 1012, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn resolve_drop_target_stack_label() {
        // Janela-alvo (100,100,400,400); cursor na faixa superior (y=150) → zona "stack" = alvo.
        let target = r#"{"x":100,"y":100,"width":400,"height":400}"#;
        let out = resolve_drop_zone(AREAS, 300, 150, target, OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "stack".into(), x: 100, y: 100, width: 400, height: 400 });
    }

    #[test]
    fn resolve_empty_target_is_split() {
        // Mesmo ponto, sem alvo → comportamento de split (não "stack").
        let out = resolve_drop_zone(AREAS, 300, 150, "", OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_ne!(p.zone, "stack");
    }

    #[test]
    fn resolve_rejects_invalid_json() {
        assert!(resolve_drop_zone("nope", 20, 400, "", OPTS).is_err());
        assert!(resolve_drop_zone(AREAS, 300, 150, "{bad", OPTS).is_err());
    }
}
