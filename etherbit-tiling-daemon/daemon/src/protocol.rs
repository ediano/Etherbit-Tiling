// protocol.rs — fronteira de serialização entre o contrato D-Bus (JSON) e os tipos do core.
//
// A ponte (extensão GNOME / KWin script) envia o conjunto atual de janelas tileáveis e as áreas
// úteis dos monitores como JSON; o daemon converte para os tipos PUROS do `etherbit-tiling-core`,
// chama `compute_layout` e devolve os retângulos-alvo (também JSON). Manter os DTOs serde aqui
// preserva o core sem dependências (ver ADR 0002/0003) — o core não conhece serde nem D-Bus.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use etherbit_tiling_core::{
    compute_constrained, detect_drop_target, is_tileable, move_window as core_move_window,
    reconcile, resize_window as core_resize_window, retain_tileable_when_maximized, DropPreview,
    DropScope, DropZone, Edge, GridChild, LayoutOptions, LayoutTree, Node, PreviewRect,
    StackDescriptor, TabBarRect, WindowInfo, WindowRect, WorkArea,
};

/// Desserializa um índice (monitor/workspace) de forma TOLERANTE: aceita inteiro e SATURA negativos a
/// 0. Uma ponte pode enviar `-1` (ex.: `Meta.Window.get_monitor()` numa janela sem monitor); sem isto,
/// o serde rejeitaria o ARRAY INTEIRO de janelas e TODO o `SyncWindows` falharia → tiling inerte (era
/// uma das causas candidatas da regressão do GNOME, ver ADR 0020).
fn de_index<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = i64::deserialize(deserializer)?;
    Ok(raw.max(0) as u32)
}

/// Desserializa uma coordenada/dimensão em PIXEL de forma TOLERANTE: aceita inteiro OU ponto flutuante
/// e ARREDONDA para `i32`. Uma ponte pode enviar coordenadas fracionárias em saídas com escala
/// fracionária/HiDPI (ex.: `frameGeometry` do KWin devolve `2649.06...`); sem isto o serde rejeitaria o
/// ARRAY INTEIRO de janelas/monitores e TODO o `SyncWindows` falharia → tiling inerte no monitor
/// afetado (era a causa da regressão multi-monitor/arraste no KDE, mesma classe de falha que `de_index`
/// já blindou para índices). O core segue operando só com inteiros.
fn de_px<'de, D>(deserializer: D) -> Result<i32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = f64::deserialize(deserializer)?;
    Ok(if raw.is_finite() { raw.round() as i32 } else { 0 })
}

/// Janela vinda da ponte. Espelha `windows_json` do contrato D-Bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowDto {
    pub id: u64,
    #[serde(default)]
    pub app_id: String,
    #[serde(deserialize_with = "de_px")]
    pub x: i32,
    #[serde(deserialize_with = "de_px")]
    pub y: i32,
    #[serde(deserialize_with = "de_px")]
    pub width: i32,
    #[serde(deserialize_with = "de_px")]
    pub height: i32,
    #[serde(default)]
    pub normal: bool,
    #[serde(default)]
    pub resizable: bool,
    #[serde(default)]
    pub maximizable: bool,
    #[serde(default, deserialize_with = "de_index")]
    pub monitor: u32,
    #[serde(default, deserialize_with = "de_index")]
    pub workspace: u32,
    /// Largura mínima (px) do app (geometry hint). Ausente/0 = sem restrição (retrocompat).
    #[serde(default, deserialize_with = "de_px")]
    pub min_width: i32,
    /// Altura mínima (px) do app (geometry hint). Ausente/0 = sem restrição (retrocompat).
    #[serde(default, deserialize_with = "de_px")]
    pub min_height: i32,
    /// Janela maximizada no momento (estado). Ausente = `false` (retrocompat). Dispara o tratamento
    /// de unmaximize no core (`retain_tileable_when_maximized`).
    #[serde(default)]
    pub maximized: bool,
}

/// Área útil de um monitor. Espelha `monitors_json` do contrato D-Bus.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorDto {
    #[serde(deserialize_with = "de_index")]
    pub index: u32,
    #[serde(deserialize_with = "de_px")]
    pub x: i32,
    #[serde(deserialize_with = "de_px")]
    pub y: i32,
    #[serde(deserialize_with = "de_px")]
    pub width: i32,
    #[serde(deserialize_with = "de_px")]
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
/// O `target_json` vem da ponte e pode chegar fracionário (escala HiDPI) → `de_px` tolera e arredonda.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct GeomDto {
    #[serde(deserialize_with = "de_px")]
    pub x: i32,
    #[serde(deserialize_with = "de_px")]
    pub y: i32,
    #[serde(deserialize_with = "de_px")]
    pub width: i32,
    #[serde(deserialize_with = "de_px")]
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

/// Nó da árvore no contrato D-Bus (untagged): folha `{ "win": id }`, grid
/// `{ "grid": { cols, rows, cells } }` ou stack (abas) `{ "stack": { members, active } }`. Espelha
/// `etherbit_tiling_core::Node` (ADR 0026: o `Grid` elástico 3×3 substitui o `Split` binário).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum NodeDto {
    Grid { grid: GridDto },
    Stack { stack: StackNodeDto },
    Win { win: u64 },
}

/// Matriz elástica de até 3 colunas × 3 linhas: frações por eixo + células posicionadas. Espelha
/// `etherbit_tiling_core::Node::Grid`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GridDto {
    pub cols: Vec<f64>,
    pub rows: Vec<f64>,
    pub cells: Vec<GridCellDto>,
}

/// Célula de um `GridDto`: o nó recursivo + posição `(col, row)` (0-based) e span em colunas/linhas.
/// `col_span`/`row_span` ausentes → 1 (retrocompat defensivo).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GridCellDto {
    pub node: Box<NodeDto>,
    #[serde(default)]
    pub col: u8,
    #[serde(default)]
    pub row: u8,
    #[serde(default = "one_u8")]
    pub col_span: u8,
    #[serde(default = "one_u8")]
    pub row_span: u8,
}

fn one_u8() -> u8 {
    1
}

/// Container empilhado (abas) na árvore: membros na ordem das abas + aba ativa. Espelha
/// `etherbit_tiling_core::Node::Stack`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StackNodeDto {
    pub members: Vec<u64>,
    pub active: u64,
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
/// ponte persistir e reenviar no próximo `state_json`). Espelha `layout_json` (objeto). As `tab_bars`
/// seguem viajando para o GNOME (a extensão as consome e desenha a barra ela mesma).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LayoutResultDto {
    pub rects: Vec<RectDto>,
    pub tab_bars: Vec<TabBarDto>,
    #[serde(default)]
    pub trees: Vec<TreeDto>,
    /// Sinal de OVERFLOW ("não cabe", ADR 0033): janelas cujo slot final ficou abaixo do mínimo
    /// mesmo após a cascata. A ponte usa para disparar o Merge Fallback (abas). Ausente = vazio
    /// (retrocompat com ponte/daemon antigos).
    #[serde(default)]
    pub floating: Vec<RectDto>,
    /// DIAGNÓSTICO: janelas RECEBIDAS que NÃO viraram rect, com o motivo. Permite à ponte logar fiel
    /// à tela (por que `recebidas` > `tiladas`) em vez de o off-by-one parecer bug. Ausente = vazio
    /// (retrocompat). Não afeta o layout.
    #[serde(default)]
    pub dropped: Vec<DroppedDto>,
}

/// Uma janela recebida que o daemon NÃO posicionou, com o motivo. Motivos: `ignored` (lista de
/// exclusão), `non_resizable`, `non_maximizable`, `non_normal` (reprovada em `is_tileable`), ou
/// `excluded_maximized` (tileável, mas "nasceu maximizada" e ainda sem folha →
/// `retain_tileable_when_maximized` a mantém fora do grid até desmaximizar).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DroppedDto {
    pub id: u64,
    pub reason: String,
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
        "eject" => DropZone::Eject,
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

/// Rótulo do escopo do drop → `DropScope` (ADR 0028). `"global"` = nó principal do workspace (50%);
/// qualquer outro (incl. `"local"`/ausente e o LEGADO `"grid"`) = subdivisão local 50/50 da
/// janela-alvo. Uma ponte antiga mandando `"grid"` degrada para `Local` (retrocompat, sem panic).
fn parse_scope(s: &str) -> DropScope {
    match s {
        "global" => DropScope::Global,
        _ => DropScope::Local,
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
        DropZone::Eject => "eject",
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
            min_width: w.min_width,
            min_height: w.min_height,
            maximized: w.maximized,
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

/// Normaliza frações de tracks (defensivo): vazio → `[1.0]`; soma ≤ 0 → uniforme; senão renormaliza
/// para somar 1 (e satura negativos a 0).
fn norm_fracs(f: &[f64]) -> Vec<f64> {
    if f.is_empty() {
        return vec![1.0];
    }
    let sum: f64 = f.iter().map(|x| x.max(0.0)).sum();
    if sum <= 0.0 {
        return vec![1.0 / f.len() as f64; f.len()];
    }
    f.iter().map(|x| x.max(0.0) / sum).collect()
}

/// Converte um nó do contrato D-Bus para o tipo do core (recursivo). Normaliza as frações e satura os
/// spans a `>= 1` (defensivo).
fn node_to_core(dto: &NodeDto) -> Node {
    match dto {
        NodeDto::Win { win } => Node::Leaf(*win),
        NodeDto::Stack { stack } => {
            Node::Stack { members: stack.members.clone(), active: stack.active }
        }
        NodeDto::Grid { grid } => Node::Grid {
            cols: norm_fracs(&grid.cols),
            rows: norm_fracs(&grid.rows),
            cells: grid
                .cells
                .iter()
                .map(|c| GridChild {
                    node: Box::new(node_to_core(&c.node)),
                    col: c.col,
                    row: c.row,
                    col_span: c.col_span.max(1),
                    row_span: c.row_span.max(1),
                })
                .collect(),
        },
    }
}

/// Converte um nó do core para o contrato D-Bus (recursivo).
fn node_to_dto(node: &Node) -> NodeDto {
    match node {
        Node::Leaf(id) => NodeDto::Win { win: *id },
        Node::Stack { members, active } => {
            NodeDto::Stack { stack: StackNodeDto { members: members.clone(), active: *active } }
        }
        Node::Grid { cols, rows, cells } => NodeDto::Grid {
            grid: GridDto {
                cols: cols.clone(),
                rows: rows.clone(),
                cells: cells
                    .iter()
                    .map(|c| GridCellDto {
                        node: Box::new(node_to_dto(&c.node)),
                        col: c.col,
                        row: c.row,
                        col_span: c.col_span,
                        row_span: c.row_span,
                    })
                    .collect(),
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
// O serviço usa `sync_windows_dto` (devolve o DTO e serializa ele mesmo); este wrapper que serializa
// direto permanece para os TESTES e diagnóstico — `dead_code` nos builds sem `cfg(test)`.
#[allow(dead_code)]
pub fn sync_windows(
    windows_json: &str,
    monitors_json: &str,
    state_json: &str,
    ignore_list: &[String],
    opts: LayoutOptions,
) -> Result<String> {
    let dto = sync_windows_dto(windows_json, monitors_json, state_json, ignore_list, opts)?;
    serde_json::to_string(&dto).context("falha ao serializar layout_json")
}

/// Motivo do descarte de uma janela NÃO tileável — espelha a ordem de `is_tileable` (core). Só é
/// chamada quando `is_tileable` já retornou `false`, então sempre acha um motivo (`unknown` é só uma
/// rede defensiva caso as regras divirjam). Puramente diagnóstica.
fn drop_reason(w: &WindowInfo, ignore_list: &[String]) -> String {
    let app = w.app_id.to_lowercase();
    if !app.is_empty() && ignore_list.iter().any(|e| e.to_lowercase() == app) {
        return "ignored".to_string();
    }
    if !w.resizable {
        return "non_resizable".to_string();
    }
    if !w.maximizable {
        return "non_maximizable".to_string();
    }
    if !w.normal {
        return "non_normal".to_string();
    }
    "unknown".to_string()
}

/// Núcleo do `SyncWindows` que devolve o DTO (sem serializar). O `service` usa esta variante e
/// serializa ela mesmo; o `sync_windows` acima é o wrapper que serializa direto (usado por testes e
/// diagnóstico). É puro/sem estado.
pub fn sync_windows_dto(
    windows_json: &str,
    monitors_json: &str,
    state_json: &str,
    ignore_list: &[String],
    opts: LayoutOptions,
) -> Result<LayoutResultDto> {
    let windows: Vec<WindowDto> =
        serde_json::from_str(windows_json).context("windows_json inválido")?;
    let monitors: Vec<MonitorDto> =
        serde_json::from_str(monitors_json).context("monitors_json inválido")?;
    let state = parse_state(state_json)?;

    let areas: Vec<WorkArea> = monitors.iter().map(WorkArea::from).collect();

    // Filtro cirúrgico centralizado no core; a ponte é burra e pode enviar tudo. `dropped` registra
    // quem foi descartado e por quê (diagnóstico fiel à tela) — não altera o layout.
    let n_windows = windows.len();
    let mut dropped: Vec<DroppedDto> = Vec::new();
    let mut tileable: Vec<WindowInfo> = Vec::new();
    for w in windows.into_iter().map(WindowInfo::from) {
        if is_tileable(&w, ignore_list) {
            tileable.push(w);
        } else {
            dropped.push(DroppedDto { id: w.id, reason: drop_reason(&w, ignore_list) });
        }
    }

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
    let mut floating: Vec<RectDto> = Vec::new();
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
        // Unmaximize: janelas que abriram MAXIMIZADAS e ainda não têm folha ficam fora do grid (o
        // compositor as mantém maximizadas) e só entram ao desmaximizar, pela maior folha. As que JÁ
        // eram folha permanecem (slot preservado → voltam à posição original).
        let maximized_ids: Vec<u64> = tileable
            .iter()
            .filter(|w| w.monitor == monitor && w.workspace == workspace && w.maximized)
            .map(|w| w.id)
            .collect();
        let kept_ids = retain_tileable_when_maximized(&prev, &group_ids, &maximized_ids);
        // Tileáveis que ficaram FORA do grid por terem nascido maximizadas sem folha prévia: registra
        // o motivo para a ponte logar (a janela "some" do relayout até desmaximizar).
        for id in &group_ids {
            if !kept_ids.contains(id) {
                dropped.push(DroppedDto { id: *id, reason: "excluded_maximized".to_string() });
            }
        }
        let group_ids = kept_ids;
        let focused_opt =
            if focused != 0 && group_ids.contains(&focused) { Some(focused) } else { None };

        match areas.iter().find(|a| a.index == monitor) {
            Some(area) => {
                // Reconcilia a árvore mesmo se o grupo estiver desligado (mantém a topologia).
                let tree = reconcile(&prev, &group_ids, &stacks, focused_opt, area, &opts);
                if !state.disabled_groups.contains(&(monitor, workspace)) {
                    // `compute_constrained` respeita os mínimos via esmagamento impositivo (ADR 0040):
                    // toda janela rígida recebe ≥ seu mínimo no grid e os vizinhos comprimem em cascata.
                    // `res.floating` é sempre vazio (não há mais auto-floating por overflow de min).
                    let res = compute_constrained(
                        &tree,
                        area,
                        &opts,
                        &stacks,
                        &group_ids,
                        &tileable,
                        focused_opt,
                    );
                    rects.extend(res.rects.iter().map(RectDto::from));
                    // Soberania do modo maximizado: uma janela maximizada ocupa o monitor inteiro e
                    // ocultaria qualquer barra de abas por baixo (Z-index do overlay). Enquanto houver
                    // janela maximizada no grupo, nenhuma barra é emitida; ela reaparece ao desmaximizar,
                    // no relayout seguinte. Agnóstico (vale p/ GNOME e KDE, ADR 0002/0016).
                    if maximized_ids.is_empty() {
                        tab_bars.extend(res.tab_bars.iter().map(TabBarDto::from));
                    }
                    floating.extend(res.floating.iter().map(RectDto::from));
                }
                // Persiste a árvore reconciliada (topologia + ratios): o relayout seguinte reproduz os
                // slots quando o espaço mudar, lembrando a posição de cada janela.
                out_trees.push(tree_to_dto(monitor, workspace, &tree));
            }
            // Sem área conhecida para este monitor: não posiciona; preserva a árvore anterior.
            None => out_trees.push(tree_to_dto(monitor, workspace, &prev)),
        }
    }

    crate::dlog!(
        "sync_windows: {n_windows} recebida(s) → {} tileável(is) → {} rect(s), {} barra(s), {} flutuante(s), {} descartada(s), {} grupo(s)",
        tileable.len(),
        rects.len(),
        tab_bars.len(),
        floating.len(),
        dropped.len(),
        out_trees.len()
    );

    Ok(LayoutResultDto { rects, tab_bars, trees: out_trees, floating, dropped })
}

/// Resolve o destino de um drop sob o ponto `(x, y)`. Escolhe a área útil que CONTÉM o ponto e
/// delega ao core (`detect_drop_target`), passando o retângulo da janela sob o cursor (`target_json`,
/// ou `""` se não há janela-alvo) para detectar empilhamento. `dragged_min` é o `(min_w, min_h)` da
/// janela ARRASTADA: o preview da metade local é esticado se o mínimo exigir (ADR 0028); `(0, 0)` =
/// metade pura. Sem área contendo o ponto → zona `"none"`. O daemon permanece sem estado.
pub fn resolve_drop_zone(
    monitors_json: &str,
    x: i32,
    y: i32,
    target_json: &str,
    dragged_min: (i32, i32),
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
            PreviewDto::from(detect_drop_target(&area, target, x, y, &opts, dragged_min))
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
    scope: &str,
) -> Result<String> {
    let state = parse_state(state_json)?;
    let zone = parse_zone(zone);
    let scope = parse_scope(scope);
    let trees = parse_trees(&state);
    let dtos: Vec<TreeDto> = trees
        .iter()
        .map(|(m, w, t)| {
            tree_to_dto(*m, *w, &core_move_window(t, dragged_id, target_id, zone, scope))
        })
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
    const OPTS: LayoutOptions = LayoutOptions { inner_gap: 8, outer_gap: 12, group_header_px: 28 };

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
    fn sync_suppresses_tab_bars_when_a_window_is_maximized() {
        // Bug B: uma janela maximizada no grupo ocuparia o monitor inteiro; nenhuma barra de abas
        // deve ser emitida enquanto ela existir (senão a barra flutua por cima). O par com o teste
        // `sync_parses_stack_and_emits_tab_bar` (mesmo stack, SEM maximizada → 1 barra) isola a guarda.
        let maximized = r#"{"id":3,"app_id":"c","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":0,"workspace":0,"maximized":true}"#;
        let windows = format!("[{},{},{}]", win_json(1, "a"), win_json(2, "b"), maximized);
        let state = r#"{"stacks":[{"monitor":0,"workspace":0,"members":[1,2],"active":2}]}"#;
        let out = sync_windows(&windows, AREAS, state, &[], OPTS).expect("ok");
        let res = layout_of(&out);
        // O stack [1,2] continua tilado (sua ativa 2 tem rect), mas a barra é suprimida pela maximizada.
        assert!(res.tab_bars.is_empty(), "barra de abas suprimida com janela maximizada no grupo");
        assert!(res.rects.iter().any(|r| r.id == 2), "o stack segue renderizando a aba ativa");
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
        let out = resolve_drop_zone(AREAS, 20, 400, "", (0, 0), OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "left".into(), x: 12, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn resolve_center_zone_matches_single_window() {
        let out = resolve_drop_zone(AREAS, 500, 400, "", (0, 0), OPTS).expect("ok");
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
        let out = resolve_drop_zone(AREAS, 5000, 400, "", (0, 0), OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "none".into(), x: 0, y: 0, width: 0, height: 0 });
    }

    #[test]
    fn resolve_picks_correct_monitor() {
        // Dois monitores lado a lado; ponto perto da borda esquerda do SEGUNDO → Left local dele.
        let areas = r#"[{"index":0,"x":0,"y":0,"width":1000,"height":800},{"index":1,"x":1000,"y":0,"width":1000,"height":800}]"#;
        let out = resolve_drop_zone(areas, 1020, 400, "", (0, 0), OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "left".into(), x: 1012, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn resolve_drop_target_stack_label() {
        // Janela-alvo (100,100,400,400); cursor no CENTRO (300,300) → zona "stack" = alvo (ADR 0046).
        let target = r#"{"x":100,"y":100,"width":400,"height":400}"#;
        let out = resolve_drop_zone(AREAS, 300, 300, target, (0, 0), OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_eq!(p, PreviewDto { zone: "stack".into(), x: 100, y: 100, width: 400, height: 400 });
    }

    #[test]
    fn resolve_empty_target_is_split() {
        // Mesmo ponto, sem alvo → comportamento de split (não "stack").
        let out = resolve_drop_zone(AREAS, 300, 150, "", (0, 0), OPTS).expect("ok");
        let p: PreviewDto = serde_json::from_str(&out).unwrap();
        assert_ne!(p.zone, "stack");
    }

    #[test]
    fn resolve_estica_metade_local_pelo_min_da_arrastada() {
        // ADR 0028: alvo (100,100,400,400); cursor à esquerda (x=120) → metade esquerda. Sem min → 196;
        // min_w 300 > metade → preview esticado para 300, ainda ancorado à esquerda.
        let target = r#"{"x":100,"y":100,"width":400,"height":400}"#;
        let pure = resolve_drop_zone(AREAS, 120, 300, target, (0, 0), OPTS).expect("ok");
        let pp: PreviewDto = serde_json::from_str(&pure).unwrap();
        assert_eq!((pp.zone.as_str(), pp.width), ("left", 196));
        let clamped = resolve_drop_zone(AREAS, 120, 300, target, (300, 0), OPTS).expect("ok");
        let pc: PreviewDto = serde_json::from_str(&clamped).unwrap();
        assert_eq!((pc.zone.as_str(), pc.x, pc.width), ("left", 100, 300));
    }

    #[test]
    fn resolve_rejects_invalid_json() {
        assert!(resolve_drop_zone("nope", 20, 400, "", (0, 0), OPTS).is_err());
        assert!(resolve_drop_zone(AREAS, 300, 150, "{bad", (0, 0), OPTS).is_err());
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
        let out = move_window(&state, 3, 1, "left", "local").expect("move ok");
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
        assert!(move_window("{bad", 1, 2, "left", "local").is_err());
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

    /// `win_json` com tamanho mínimo (geometry hint) explícito.
    fn win_json_min(id: u64, app: &str, min_width: i32, min_height: i32) -> String {
        format!(
            r#"{{"id":{id},"app_id":"{app}","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":0,"workspace":0,"min_width":{min_width},"min_height":{min_height}}}"#
        )
    }

    #[test]
    fn sync_window_dto_default_min_zero() {
        // JSON SEM min_width/min_height (ponte antiga) parseia: defaults 0 → sem restrição.
        let dto: WindowDto = serde_json::from_str(&win_json(1, "a")).expect("parse");
        assert_eq!(dto.min_width, 0);
        assert_eq!(dto.min_height, 0);
    }

    #[test]
    fn window_dto_negative_index_saturates_to_zero() {
        // `monitor: -1` (janela sem monitor) NÃO pode quebrar o parse: `de_index` satura a 0.
        let json = r#"{"id":1,"app_id":"a","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":-1,"workspace":-1}"#;
        let dto: WindowDto = serde_json::from_str(json).expect("parse tolerante");
        assert_eq!(dto.monitor, 0);
        assert_eq!(dto.workspace, 0);
    }

    #[test]
    fn window_dto_tolerates_fractional_pixels() {
        // Reproduz a linha real do log KDE (`floating point 2649.06... expected i32`): coordenadas
        // fracionárias de saída com escala HiDPI. `de_px` deve aceitar e arredondar em vez de rejeitar.
        let json = r#"{"id":1,"app_id":"a","x":2649.063230904885,"y":40.5,"width":1708.4,"height":1392.0,"normal":true,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}"#;
        let dto: WindowDto = serde_json::from_str(json).expect("frações toleradas");
        assert_eq!((dto.x, dto.y, dto.width, dto.height), (2649, 41, 1708, 1392));
    }

    #[test]
    fn sync_tolerates_fractional_coords_in_array() {
        // A regressão do log: um único `x` fracionário rejeitava o windows_json INTEIRO → 0 rects →
        // tiling inerte no monitor. Agora o array desserializa e o layout é computado normalmente.
        let frac = r#"{"id":1,"app_id":"a","x":8.0,"y":40.5,"width":2649.063230904885,"height":1392.0,"normal":true,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}"#;
        let out = sync_windows(&format!("[{frac}]"), AREAS, "", &[], OPTS)
            .expect("não deve falhar com coordenada fracionária");
        let res = layout_of(&out);
        assert_eq!(res.rects.len(), 1, "a janela é tilada apesar da coordenada fracionária");
        assert_eq!(res.rects[0].id, 1);
    }

    #[test]
    fn monitor_dto_tolerates_fractional_pixels() {
        // Área de monitor também pode vir fracionária (clientArea sob escala) — não pode derrubar o sync.
        let areas = r#"[{"index":0,"x":0.0,"y":0.0,"width":3440.9,"height":1439.6}]"#;
        let out = sync_windows(&format!("[{}]", win_json(1, "a")), areas, "", &[], OPTS)
            .expect("área fracionária tolerada");
        assert_eq!(layout_of(&out).rects.len(), 1);
    }

    #[test]
    fn sync_tolerates_negative_monitor_in_array() {
        // Um `monitor: -1` no array NÃO invalida o SyncWindows inteiro (era causa candidata de inércia
        // no GNOME): a janela é tratada como monitor 0 e tilada normalmente.
        let off = r#"{"id":1,"app_id":"a","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":-1,"workspace":0}"#;
        let out = sync_windows(&format!("[{off}]"), AREAS, "", &[], OPTS)
            .expect("não deve falhar com monitor -1");
        let res = layout_of(&out);
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 1);
    }

    #[test]
    fn sync_oversized_min_entrega_min_e_nao_floata() {
        // ADR 0040: janela com min_width maior que a área. O esmagamento impositivo entrega à rígida seu
        // mínimo EXATO e comprime a vizinha — NINGUÉM floata; as duas seguem no grid.
        let windows = format!("[{},{}]", win_json_min(1, "store", 2000, 0), win_json(2, "b"));
        let out = sync_windows(&windows, AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert!(res.floating.is_empty(), "esmagamento impositivo nunca floata por min");
        let r1 = res.rects.iter().find(|r| r.id == 1).expect("a restrita segue tilada");
        assert!(r1.width >= 2000, "a rígida recebe seu mínimo exato (got {})", r1.width);
        assert_eq!(res.rects.iter().filter(|r| r.id == 2).count(), 1);
    }

    #[test]
    fn layout_result_dto_floating_defaults_when_absent() {
        // Resposta de daemon ANTIGO (sem `floating`) desserializa com lista vazia (retrocompat).
        let legacy = r#"{"rects":[],"tab_bars":[],"trees":[]}"#;
        let dto: LayoutResultDto = serde_json::from_str(legacy).expect("parse");
        assert!(dto.floating.is_empty());
    }

    #[test]
    fn sync_oversized_min_nao_agrupa_sozinho() {
        // ADR 0046: duas rígidas cujos mínimos colapsam a célula NÃO viram abas sozinhas — o
        // esmagamento cooperativo (ADR 0040) as entrega no grid, sem barra de abas. Agrupar é só manual.
        let windows =
            format!("[{},{}]", win_json_min(1, "calc", 2000, 0), win_json_min(2, "store", 2000, 0));
        let out = sync_windows(&windows, AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert!(res.floating.is_empty(), "floating segue vazio (deprecated)");
        assert_eq!(res.rects.len(), 2, "as duas seguem tiladas (sem auto-agrupamento)");
        assert!(res.tab_bars.is_empty(), "nenhuma barra emerge por colisão");
    }

    #[test]
    fn sync_ignora_campo_title_desconhecido() {
        // Fronteira da Regra I (ADR 0029): o core nunca vê título. Um `windows_json` com um campo
        // "title" extra é IGNORADO pelo serde (`WindowDto` não tem o campo) — o layout sai idêntico ao
        // de uma janela sem título. O título vive 100% na ponte (renderização das abas).
        let com_title = r#"[{"id":1,"app_id":"a","title":"Janela Secreta","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}]"#;
        let sem_title = format!("[{}]", win_json(1, "a"));
        let a = sync_windows(com_title, AREAS, "", &[], OPTS).expect("ok");
        let b = sync_windows(&sem_title, AREAS, "", &[], OPTS).expect("ok");
        assert_eq!(layout_of(&a).rects, layout_of(&b).rects, "o título não influencia o layout");
    }

    // --- Diagnóstico de "N janelas → 0 rects": classifica cada caminho que esvazia o grid, separando
    // o COMPORTAMENTO ESPERADO (filtro / monitor desconhecido / grupo desligado) de uma REGRESSÃO
    // genuína (árvore reconciliada vazia apesar de haver janelas tileáveis). ---

    #[test]
    fn sync_all_oversized_min_entrega_min_a_ambas_sem_floatar() {
        // ADR 0040: TODAS as janelas com min maior que a área. O esmagamento impositivo entrega a cada
        // uma seu mínimo exato (Σ excede a tela → deslocamento compensatório), as duas seguem tiladas
        // (2 rects) e NINGUÉM floata.
        let windows =
            format!("[{},{}]", win_json_min(1, "a", 2000, 0), win_json_min(2, "b", 2000, 0));
        let out = sync_windows(&windows, AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert_eq!(res.rects.len(), 2, "min gigante comprime, não some do grid");
        assert!(res.floating.is_empty(), "esmagamento impositivo nunca floata por min");
        let w = |id: u64| res.rects.iter().find(|r| r.id == id).unwrap().width;
        assert!(w(1) >= 2000 && w(2) >= 2000, "cada rígida recebe seu mínimo exato");
    }

    #[test]
    fn sync_all_non_tileable_is_zero_rects_zero_floating() {
        // TODAS as janelas filtradas (não-normais): grid vazio É esperado e NÃO há flutuantes.
        // Documenta o "0/0 legítimo" pelo filtro `is_tileable` — descarta-o como suspeito ao diagnosticar.
        let d1 = r#"{"id":1,"app_id":"x","x":0,"y":0,"width":10,"height":10,"normal":false,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}"#;
        let d2 = r#"{"id":2,"app_id":"y","x":0,"y":0,"width":10,"height":10,"normal":false,"resizable":true,"maximizable":true,"monitor":0,"workspace":0}"#;
        let out = sync_windows(&format!("[{d1},{d2}]"), AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert!(res.rects.is_empty());
        assert!(res.floating.is_empty());
    }

    #[test]
    fn sync_unknown_positive_monitor_is_zero_rects_zero_floating() {
        // Janela tileável num monitor (índice 5) que NÃO consta em `areas` (só index 0): o ramo `None`
        // não posiciona nada. "0/0 legítimo" — a árvore é preservada e a culpa é da PONTE, que reportou
        // um `monitor` sem `areas[].index` correspondente (suspeito real fora do core).
        let off = r#"{"id":1,"app_id":"a","x":0,"y":0,"width":100,"height":100,"normal":true,"resizable":true,"maximizable":true,"monitor":5,"workspace":0}"#;
        let out = sync_windows(&format!("[{off}]"), AREAS, "", &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert!(res.rects.is_empty(), "monitor desconhecido → sem geometria");
        assert!(res.floating.is_empty());
        // A topologia é preservada para quando o monitor (re)aparecer.
        assert_eq!(res.trees.len(), 1);
    }

    #[test]
    fn sync_reconcile_divergent_tree_keeps_all_rects() {
        // REGRESSÃO-ALVO: árvore persistida só com ids ausentes (97,98) ao reconciliar janelas vivas
        // (1,2). O reconcile deve REMOVER os mortos e INSERIR os novos → 2 rects (NÃO 0/0). Se sair
        // vazio, é o bug genuíno de "0 rects" com janelas tileáveis.
        let stale = format!("[{},{}]", win_json(97, "old"), win_json(98, "old"));
        let first = sync_windows(&stale, AREAS, "", &[], OPTS).expect("ok");
        let stale_trees = serde_json::to_string(&layout_of(&first).trees).expect("trees");
        let state = format!(r#"{{"trees":{stale_trees}}}"#);

        let live = format!("[{},{}]", win_json(1, "a"), win_json(2, "b"));
        let out = sync_windows(&live, AREAS, &state, &[], OPTS).expect("ok");
        let res = layout_of(&out);
        assert_eq!(res.rects.len(), 2, "reconcile insere os novos apesar da árvore divergente");
        assert!(res.floating.is_empty());
        assert!(res.rects.iter().any(|r| r.id == 1));
        assert!(res.rects.iter().any(|r| r.id == 2));
    }
}
