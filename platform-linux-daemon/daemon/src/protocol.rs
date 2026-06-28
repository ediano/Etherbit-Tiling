// protocol.rs — fronteira de serialização entre o contrato D-Bus (JSON) e os tipos do core.
//
// A ponte (extensão GNOME / KWin script) envia o conjunto atual de janelas tileáveis e as áreas
// úteis dos monitores como JSON; o daemon converte para os tipos PUROS do `etherbit-tiling-core`,
// chama `compute_layout` e devolve os retângulos-alvo (também JSON). Manter os DTOs serde aqui
// preserva o core sem dependências (ver ADR 0002/0003) — o core não conhece serde nem D-Bus.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use etherbit_tiling_core::{
    compute_geometry, detect_drop_target, is_tileable, move_window as core_move_window, reconcile,
    resize_window as core_resize_window, Axis, DropPreview, DropZone, Edge, LayoutOptions,
    LayoutTree, Node, PreviewRect, StackDescriptor, TabBarRect, WindowInfo, WindowRect, WorkArea,
    MIN_RATIO,
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
    /// Árvores BSP persistentes por grupo (estado da ponte). Vazio → reconstrói do zero (balanceado).
    #[serde(default)]
    pub trees: Vec<TreeDto>,
    /// Id da janela focada (foco de teclado); 0 = nenhuma. Define a folha a rachar ao abrir janela.
    #[serde(default)]
    pub focused_id: u64,
}

/// Nó da árvore BSP no contrato D-Bus (untagged): folha `{ "win": id }` ou divisão
/// `{ "split": { axis, ratio, first, second } }`. Espelha `etherbit_tiling_core::Node`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum NodeDto {
    Split { split: SplitDto },
    Win { win: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SplitDto {
    /// "h" = lado a lado (Horizontal); "v" = empilhado (Vertical).
    pub axis: String,
    pub ratio: f64,
    pub first: Box<NodeDto>,
    pub second: Box<NodeDto>,
}

/// Árvore persistente de um grupo `(monitor, workspace)`. `root: None`/ausente = grupo vazio.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TreeDto {
    #[serde(default)]
    pub monitor: u32,
    #[serde(default)]
    pub workspace: u32,
    #[serde(default)]
    pub root: Option<NodeDto>,
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

/// Saída do `SyncWindows`: retângulos visíveis + barras de abas + as ÁRVORES reconciliadas (para a
/// ponte persistir e reenviar no próximo `state_json`). Espelha `layout_json` (objeto).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LayoutResultDto {
    pub rects: Vec<RectDto>,
    pub tab_bars: Vec<TabBarDto>,
    #[serde(default)]
    pub trees: Vec<TreeDto>,
}

/// Inverso de `zone_label`: rótulo snake_case → zona do core (desconhecido → `None`).
fn parse_zone(s: &str) -> DropZone {
    match s {
        "left" => DropZone::Left,
        "right" => DropZone::Right,
        "top" => DropZone::Top,
        "bottom" => DropZone::Bottom,
        "top_left" => DropZone::TopLeft,
        "top_right" => DropZone::TopRight,
        "bottom_left" => DropZone::BottomLeft,
        "bottom_right" => DropZone::BottomRight,
        "center" => DropZone::Center,
        "stack" => DropZone::Stack,
        _ => DropZone::None,
    }
}

/// Rótulo (snake_case) → borda do core (desconhecido → `Right`).
fn parse_edge(s: &str) -> Edge {
    match s {
        "left" => Edge::Left,
        "top" => Edge::Top,
        "bottom" => Edge::Bottom,
        _ => Edge::Right,
    }
}

/// Saída de `move_window`/`resize_window`: só as árvores atualizadas (a ponte persiste e re-sincroniza
/// a geometria).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TreesDto {
    #[serde(default)]
    pub trees: Vec<TreeDto>,
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

/// Converte um nó do contrato D-Bus para o tipo do core (recursivo). Faz clamp defensivo do `ratio`.
fn node_to_core(dto: &NodeDto) -> Node {
    match dto {
        NodeDto::Win { win } => Node::Leaf(*win),
        NodeDto::Split { split } => Node::Split {
            axis: if split.axis == "v" { Axis::Vertical } else { Axis::Horizontal },
            ratio: split.ratio.clamp(MIN_RATIO, 1.0 - MIN_RATIO),
            first: Box::new(node_to_core(&split.first)),
            second: Box::new(node_to_core(&split.second)),
        },
    }
}

/// Converte um nó do core para o contrato D-Bus (recursivo).
fn node_to_dto(node: &Node) -> NodeDto {
    match node {
        Node::Leaf(id) => NodeDto::Win { win: *id },
        Node::Split { axis, ratio, first, second } => NodeDto::Split {
            split: SplitDto {
                axis: if *axis == Axis::Vertical { "v".to_string() } else { "h".to_string() },
                ratio: *ratio,
                first: Box::new(node_to_dto(first)),
                second: Box::new(node_to_dto(second)),
            },
        },
    }
}

/// Árvores persistentes vindas do `state_json`, indexadas por `(monitor, workspace)`.
fn parse_trees(state: &SyncStateDto) -> Vec<(u32, u32, LayoutTree)> {
    state
        .trees
        .iter()
        .map(|t| (t.monitor, t.workspace, LayoutTree { root: t.root.as_ref().map(node_to_core) }))
        .collect()
}

/// Empacota uma árvore do core de volta no `TreeDto` para a ponte persistir.
fn tree_to_dto(monitor: u32, workspace: u32, tree: &LayoutTree) -> TreeDto {
    TreeDto { monitor, workspace, root: tree.root.as_ref().map(node_to_dto) }
}

/// Stacks (descritores do core) de um grupo `(monitor, workspace)` a partir do `state_json`.
fn group_stacks(state: &SyncStateDto, monitor: u32, workspace: u32) -> Vec<StackDescriptor> {
    state
        .stacks
        .iter()
        .filter(|s| s.monitor == monitor && s.workspace == workspace)
        .map(|s| StackDescriptor { member_ids: s.members.clone(), active_id: s.active })
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

    // Ordem dos grupos `(monitor, workspace)` conforme a primeira janela descoberta em cada um.
    let mut group_order: Vec<(u32, u32)> = Vec::new();
    for w in &tileable {
        let key = (w.monitor, w.workspace);
        if !group_order.contains(&key) {
            group_order.push(key);
        }
    }

    let prev_trees = parse_trees(&state);
    let focused = state.focused_id;

    let mut rects: Vec<RectDto> = Vec::new();
    let mut tab_bars: Vec<TabBarDto> = Vec::new();
    let mut out_trees: Vec<TreeDto> = Vec::new();

    for (monitor, workspace) in group_order {
        let group_ids: Vec<u64> = tileable
            .iter()
            .filter(|w| w.monitor == monitor && w.workspace == workspace)
            .map(|w| w.id)
            .collect();
        let stacks = group_stacks(&state, monitor, workspace);
        let prev = prev_trees
            .iter()
            .find(|(m, w, _)| *m == monitor && *w == workspace)
            .map(|(_, _, t)| t.clone())
            .unwrap_or_default();
        let focused_opt =
            if focused != 0 && group_ids.contains(&focused) { Some(focused) } else { None };

        match areas.iter().find(|a| a.index == monitor) {
            Some(area) => {
                // Reconcilia a árvore mesmo se o grupo estiver desligado (mantém a topologia).
                let tree = reconcile(&prev, &group_ids, &stacks, focused_opt, area, &opts);
                if !state.disabled_groups.contains(&(monitor, workspace)) {
                    let res = compute_geometry(&tree, area, &opts, &stacks, &group_ids);
                    rects.extend(res.rects.iter().map(RectDto::from));
                    tab_bars.extend(res.tab_bars.iter().map(TabBarDto::from));
                }
                out_trees.push(tree_to_dto(monitor, workspace, &tree));
            }
            // Sem área conhecida para este monitor: não posiciona; preserva a árvore anterior.
            None => out_trees.push(tree_to_dto(monitor, workspace, &prev)),
        }
    }

    let dto = LayoutResultDto { rects, tab_bars, trees: out_trees };
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

/// Aplica um drag-to-tile: move `dragged_id` para junto de `target_id` no lado da `zone`, rachando a
/// folha do alvo na árvore do grupo que o contém. É tree-only: devolve apenas as árvores atualizadas
/// (`{"trees":[...]}`) — a ponte persiste e re-sincroniza a geometria via `SyncWindows`. Aplica a
/// todos os grupos; só o que contém o alvo muda (o core trata o resto como no-op).
pub fn move_window(
    state_json: &str,
    dragged_id: u64,
    target_id: u64,
    zone: &str,
) -> Result<String> {
    let state = parse_state(state_json)?;
    let zone = parse_zone(zone);
    let trees = parse_trees(&state);
    let dtos: Vec<TreeDto> = trees
        .iter()
        .map(|(m, w, t)| tree_to_dto(*m, *w, &core_move_window(t, dragged_id, target_id, zone)))
        .collect();
    serde_json::to_string(&TreesDto { trees: dtos }).context("falha ao serializar trees_json")
}

/// Redimensiona elasticamente a janela `id` arrastando a borda `edge` em `delta_px` (positivo = a
/// janela cresceu). Acha o split governante na árvore do grupo de `id` (usando a área do monitor
/// daquele grupo) e ajusta o ratio. Tree-only: devolve `{"trees":[...]}`; a geometria vem do
/// `SyncWindows` seguinte. Grupos que não contêm `id` (ou sem área) são no-op.
pub fn resize_window(
    monitors_json: &str,
    state_json: &str,
    id: u64,
    edge: &str,
    delta_px: i32,
    opts: LayoutOptions,
) -> Result<String> {
    let monitors: Vec<MonitorDto> =
        serde_json::from_str(monitors_json).context("monitors_json inválido")?;
    let areas: Vec<WorkArea> = monitors.iter().map(WorkArea::from).collect();
    let state = parse_state(state_json)?;
    let edge = parse_edge(edge);
    let trees = parse_trees(&state);
    let dtos: Vec<TreeDto> = trees
        .iter()
        .map(|(m, w, t)| {
            let resized = match areas.iter().find(|a| a.index == *m) {
                Some(area) => core_resize_window(t, area, &opts, id, edge, delta_px),
                None => t.clone(),
            };
            tree_to_dto(*m, *w, &resized)
        })
        .collect();
    serde_json::to_string(&TreesDto { trees: dtos }).context("falha ao serializar trees_json")
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

    #[test]
    fn sync_returns_trees_for_persistence() {
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let out = sync_windows(&windows, AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert_eq!(res.trees.len(), 1);
        assert_eq!((res.trees[0].monitor, res.trees[0].workspace), (0, 0));
        assert!(res.trees[0].root.is_some());
    }

    #[test]
    fn sync_with_tree_is_stable_on_insert() {
        // 1ª sync com [1,2]; reenvia as árvores + adiciona 3 focando 2 → janela 1 não se move.
        let w12 = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let first = sync_windows(&w12, AREAS, "", &[], OPTS).expect("ok");
        let r1 = layout_of(&first);
        let trees_json = serde_json::to_string(&r1.trees).expect("serializa trees");
        let state = format!(r#"{{"trees":{trees_json},"focused_id":2}}"#);
        let w123 = format!("[{},{},{}]", win_json(1, "a"), win_json(2, "b"), win_json(3, "c"));
        let second = sync_windows(&w123, AREAS, &state, &[], OPTS).expect("ok");
        let r2 = layout_of(&second);
        assert_eq!(r2.rects.len(), 3);
        let a1 = r1.rects.iter().find(|r| r.id == 1).expect("1 na 1ª");
        let b1 = r2.rects.iter().find(|r| r.id == 1).expect("1 na 2ª");
        assert_eq!(a1, b1, "janela 1 estável ao abrir a 3ª focando a 2");
    }

    #[test]
    fn move_window_mutates_tree_and_returns_trees() {
        // Constrói a árvore de [1,2,3], depois move 3 para a esquerda de 1 via move_window.
        let w = format!("[{},{},{}]", win_json(1, "a"), win_json(2, "b"), win_json(3, "c"));
        let first = sync_windows(&w, AREAS, "", &[], OPTS).expect("ok");
        let r1 = layout_of(&first);
        let trees_json = serde_json::to_string(&r1.trees).unwrap();
        let state = format!(r#"{{"trees":{trees_json}}}"#);
        let out = move_window(&state, 3, 1, "left").expect("move ok");
        let moved: TreesDto = serde_json::from_str(&out).expect("trees válidas");
        assert_eq!(moved.trees.len(), 1);
        // Re-sincroniza com as árvores movidas: 3 deve estar à esquerda de 1.
        let state2 = format!(r#"{{"trees":{}}}"#, serde_json::to_string(&moved.trees).unwrap());
        let second = sync_windows(&w, AREAS, &state2, &[], OPTS).expect("ok");
        let r2 = layout_of(&second);
        let a1 = r2.rects.iter().find(|r| r.id == 1).unwrap();
        let a3 = r2.rects.iter().find(|r| r.id == 3).unwrap();
        assert!(a3.x < a1.x, "3 à esquerda de 1 após move");
    }

    #[test]
    fn move_window_rejects_invalid_state() {
        assert!(move_window("{bad", 1, 2, "left").is_err());
    }

    #[test]
    fn resize_window_adjusts_tree_ratio() {
        // Árvore de [1,2] (lado a lado); resize borda direita de 1 em +100 → 1 mais larga depois.
        let w = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let first = sync_windows(&w, AREAS, "", &[], OPTS).expect("ok");
        let r1 = layout_of(&first);
        let trees_json = serde_json::to_string(&r1.trees).unwrap();
        let state = format!(r#"{{"trees":{trees_json}}}"#);
        let before = r1.rects.iter().find(|r| r.id == 1).unwrap().width;

        let out = resize_window(AREAS, &state, 1, "right", 100, OPTS).expect("resize ok");
        let resized: TreesDto = serde_json::from_str(&out).expect("trees");
        let state2 = format!(r#"{{"trees":{}}}"#, serde_json::to_string(&resized.trees).unwrap());
        let second = sync_windows(&w, AREAS, &state2, &[], OPTS).expect("ok");
        let after = layout_of(&second).rects.iter().find(|r| r.id == 1).unwrap().width;
        assert_eq!(after, before + 100);
    }

    #[test]
    fn resize_window_rejects_invalid_state() {
        assert!(resize_window(AREAS, "{bad", 1, "right", 50, OPTS).is_err());
    }

    #[test]
    fn sync_tolerates_malformed_tree_blob() {
        // Blob de árvore inválido não derruba: reconstrói do zero (balanceado).
        let windows = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let state = r#"{"trees":[{"monitor":0,"workspace":0,"root":{"bogus":true}}]}"#;
        // root inválido → erro de parse do state_json (rejeitado defensivamente pelo chamador).
        assert!(sync_windows(&windows, AREAS, state, &[], OPTS).is_err());
        // Já um blob ausente (trees vazio) reconstrói normalmente.
        let ok = sync_windows(&windows, AREAS, r#"{"trees":[]}"#, &[], OPTS).expect("ok");
        assert_eq!(layout_of(&ok).rects.len(), 2);
    }
}
