// layout.rs — Ether Flow: decisão de layout agnóstica (matemática pura, sem deps, sem GL).
//
// Este módulo concentra TODA a decisão de posicionamento das janelas. As camadas nativas
// (extensão GNOME, KWin script) são "pontes burras": coletam metadados das janelas e das áreas
// úteis, enviam ao daemon, e apenas APLICAM os retângulos devolvidos por `compute_layout`.
//
// Centraliza o que antes vivia duplicado nas plataformas: o filtro cirúrgico (`is_tileable`,
// porta do `_shouldIgnore` do GNOME e do `shouldTile` do KDE) e a divisão do espaço.
//
// MOTOR: divisão binária (BSP) determinística e SEM ESTADO. Dado o conjunto ordenado de janelas
// de um grupo `(monitor, workspace)` e a área útil, o espaço é "rachado" recursivamente ao meio,
// sempre pelo lado MAIOR (aspect-aware, estilo COSMIC), distribuindo metade das janelas para cada
// subárea. Resultado: grades simétricas e proporcionais (2 = metades, 3 = metade + dois quartos,
// 4 = 2×2, N = subdivisão infinita), nunca sobrepostas. Como é função pura da ordem de entrada, a
// persistência de rearranjo/resize vive na ponte (a ordem) — o daemon permanece sem estado.

use std::collections::HashMap;

/// Tamanhos mínimos (px) por id de folha — `(min_width, min_height)`. Montado a partir dos hints
/// geométricos das janelas (no GNOME, `Meta.Window.get_min_size()`; no KDE, `Window.minSize`). Uma
/// folha-âncora de stack agrega o `max` dos mínimos dos membros (+ `tab_bar_height` na altura).
/// Ausente ou `(0, 0)` = sem restrição. Aplicado SÓ na geometria (não muta os ratios da árvore).
pub type MinSizes = HashMap<u64, (i32, i32)>;

/// Metadados brutos de uma janela, agnósticos do compositor. `id` é uma chave estável na
/// sessão (no GNOME, `Meta.Window.get_stable_sequence()`; no KDE, `internalId`/`windowId`),
/// usada pela ponte para resolver o retângulo de volta à janela real.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Classe/app-id (ex.: "firefox"), usado pelo filtro de exclusão.
    pub app_id: String,
    /// Janela "normal" (descarta dock/utility/splash/dialog).
    pub normal: bool,
    pub resizable: bool,
    pub maximizable: bool,
    /// Índice do monitor onde a janela está.
    pub monitor: u32,
    /// Workspace/desktop atual da janela.
    pub workspace: u32,
    /// Largura mínima (px) imposta pelo app (geometry hint); 0 = sem restrição.
    pub min_width: i32,
    /// Altura mínima (px) imposta pelo app (geometry hint); 0 = sem restrição.
    pub min_height: i32,
    /// Janela maximizada no momento (estado, não capacidade — `maximizable` é a capacidade). Usado
    /// pelo tratamento de unmaximize: uma janela que abriu maximizada fica fora do grid até voltar.
    pub maximized: bool,
}

/// Área útil de um monitor (já descontadas barras/docks do compositor).
#[derive(Debug, Clone, PartialEq)]
pub struct WorkArea {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Parâmetros de espaçamento, espelhando os controles da config.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutOptions {
    /// Espaço entre janelas vizinhas (px).
    pub inner_gap: u32,
    /// Espaço entre as janelas e as bordas da área útil (px).
    pub outer_gap: u32,
    /// Altura (px) da faixa reservada no topo de um quadrante empilhado para a barra de abas.
    /// A ponte desenha a barra aqui; o conteúdo da aba ativa ocupa o slot menos esta faixa.
    pub tab_bar_height: u32,
}

/// Retângulo-alvo de uma janela, pronto para a ponte aplicar.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowRect {
    pub id: u64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Zona de drop detectada sob o cursor durante um arrasto. Define qual região do monitor a janela
/// ocupará se for solta ali. Agnóstica do compositor — a ponte só recebe o retângulo já calculado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropZone {
    /// Metade esquerda / direita / superior / inferior.
    Left,
    Right,
    Top,
    Bottom,
    /// Quadrantes (proximidade de dois bordos ao mesmo tempo).
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    /// Miolo central → maximizar (área útil inteira menos `outer_gap`).
    Center,
    /// Faixa superior de uma janela existente → empilhar nela (vira aba de um `StackNode`).
    Stack,
    /// Cursor fora da área útil → sem preview.
    None,
}

/// Retângulo de preview (sem `id` — a janela arrastada é referenciada à parte). Em px absolutos do
/// monitor, prontos para a ponte desenhar o overlay.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreviewRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Resultado da detecção: a zona sob o cursor e o retângulo-alvo já com gaps aplicados.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DropPreview {
    pub zone: DropZone,
    pub rect: PreviewRect,
}

/// Descritor de um stack (conjunto de janelas empilhadas que dividem um único slot do BSP). É
/// construído pela ponte a partir do seu estado leve (quais janelas estão na mesma pilha). A ordem
/// de `member_ids` é a ordem das abas (esquerda→direita na barra) e é determinística.
#[derive(Debug, Clone, PartialEq)]
pub struct StackDescriptor {
    /// Ids dos membros, na ordem das abas. Só os presentes no grupo participam do layout.
    pub member_ids: Vec<u64>,
    /// Id da aba ativa. Se ausente de `member_ids`, cai no primeiro membro presente.
    pub active_id: u64,
}

/// Stacks de um grupo `(monitor, workspace)`. A ponte envia um destes por grupo que contém pilhas.
#[derive(Debug, Clone, PartialEq)]
pub struct StackGroup {
    pub monitor: u32,
    pub workspace: u32,
    pub stacks: Vec<StackDescriptor>,
}

/// Faixa da barra de abas de um stack + o retângulo de conteúdo da aba ativa. A ponte desenha a
/// barra em `{x,y,width,height}` (título/ícone vêm da ponte) e posiciona a janela ativa em `content`.
#[derive(Debug, Clone, PartialEq)]
pub struct TabBarRect {
    /// Identidade do stack para a ponte: o primeiro `member_id` (id de janela real, traduzível pela
    /// ponte KDE). Não é uma chave nova fora do espaço de ids das janelas.
    pub stack_id: u64,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Retângulo do conteúdo (slot menos a faixa da barra), onde fica a janela ATIVA.
    pub content: PreviewRect,
    /// Membros presentes na ordem das abas, e a aba ativa resolvida.
    pub member_ids: Vec<u64>,
    pub active_id: u64,
}

/// Resultado completo do layout: os retângulos das janelas VISÍVEIS (a aba ativa de cada stack já
/// vem aqui com o `content`) + as barras de abas. As janelas inativas de um stack NÃO aparecem em
/// `rects` — a ponte as oculta (minimiza) a partir de `member_ids`/`active_id` de `tab_bars`.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutResult {
    pub rects: Vec<WindowRect>,
    pub tab_bars: Vec<TabBarRect>,
    /// Janelas removidas do tiling por AUTO-FLOATING: quando os mínimos não cabem na árvore, a
    /// janela mais restritiva é isolada e centralizada sobre o grid. A ponte aplica estes
    /// retângulos e ELEVA a janela acima das tiladas (não a oculta). Vazio no caso comum.
    pub floating: Vec<WindowRect>,
}

// ---- Árvore BSP PERSISTENTE (estado da ponte; o core só a transforma) ----
//
// Diferente do BSP balanceado de `compute_layout_with` (função pura da ordem, que reembaralha tudo
// a cada janela), a árvore persiste a topologia e as PROPORÇÕES (ratio por nó), dando layout
// ESTÁVEL (abrir a N+1 racha só um nó) e resize elástico. As folhas são ids de janela simples; um
// STACK ocupa a folha do seu id-âncora (primeiro membro presente) e é resolvido na geometria — assim
// as operações de árvore (inserir/colapsar/mover/redimensionar) lidam só com `u64`.

/// Eixo de uma divisão interna.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    /// Lado a lado (corte no eixo X).
    Horizontal,
    /// Empilhado (corte no eixo Y).
    Vertical,
}

/// Nó da árvore de tiling (GRID FRACTAL — ver ADR 0026, substitui o `Node::Split` do 0019):
///  - `Leaf` — uma janela ocupando um slot (100% se for a raiz);
///  - `Stack` — um CONTAINER EMPILHADO (abas) ocupando UM slot: `members` na ordem das abas (todos
///    presentes no grupo) e `active` é a aba visível. Todas as `members` herdam o mesmo `(X,Y,W,H)` do
///    slot (a barra come o topo); só a `active` entra em `rects`. A âncora/identidade é `members[0]`.
///  - `Grid` — uma MATRIZ ELÁSTICA de até 3 colunas × 3 linhas. `cols`/`rows` são frações (somam ~1,
///    elásticas) e cada `GridChild` posiciona um filho recursivo numa faixa de células
///    `[col..col+col_span) × [row..row+row_span)`. Um split binário é o caso de **2 tracks** num eixo
///    (`split_h`/`split_v`), então a geometria de 2 janelas é IDÊNTICA ao BSP legado. A subdivisão
///    fractal vem de aninhar grids (a célula-alvo vira um sub-`Grid`); o `span` cobre o min-size.
///
/// A lógica de TOPOLOGIA do `reconcile` (inserir/colapsar/balancear) opera sobre uma forma
/// "desmaterializada" (cada `Stack` vira `Leaf(âncora)`), e o resultado é "materializado" de volta em
/// `Stack` conforme o comando da ponte — mantendo a aritmética e a máquina de mínimos/auto-floating.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Leaf(u64),
    Stack { members: Vec<u64>, active: u64 },
    Grid { cols: Vec<f64>, rows: Vec<f64>, cells: Vec<GridChild> },
}

/// Filho posicionado de um `Node::Grid`: o nó recursivo + sua célula de origem `(col, row)` (0-based) e
/// o `span` em colunas/linhas (1..=3). `span > 1` = a célula ocupa várias tracks (usado pelo min-size).
#[derive(Debug, Clone, PartialEq)]
pub struct GridChild {
    pub node: Box<Node>,
    pub col: u8,
    pub row: u8,
    pub col_span: u8,
    pub row_span: u8,
}

impl Node {
    /// Célula simples (span 1×1) na posição `(col, row)`.
    fn cell(node: Node, col: u8, row: u8) -> GridChild {
        GridChild { node: Box::new(node), col, row, col_span: 1, row_span: 1 }
    }

    /// `Grid` de 2 colunas (lado a lado): `first` ocupa a coluna esquerda com fração `ratio`. Equivale
    /// ao antigo `Split { axis: Horizontal, ratio, .. }` — mesma geometria.
    fn split_h(ratio: f64, first: Node, second: Node) -> Node {
        Node::Grid {
            cols: vec![ratio, 1.0 - ratio],
            rows: vec![1.0],
            cells: vec![Node::cell(first, 0, 0), Node::cell(second, 1, 0)],
        }
    }

    /// `Grid` de 2 linhas (empilhado): `first` ocupa a linha superior com fração `ratio`. Equivale ao
    /// antigo `Split { axis: Vertical, ratio, .. }`.
    fn split_v(ratio: f64, first: Node, second: Node) -> Node {
        Node::Grid {
            cols: vec![1.0],
            rows: vec![ratio, 1.0 - ratio],
            cells: vec![Node::cell(first, 0, 0), Node::cell(second, 0, 1)],
        }
    }

    /// Constrói um split binário no `axis` dado (helper de topologia).
    fn split_on(axis: Axis, ratio: f64, first: Node, second: Node) -> Node {
        match axis {
            Axis::Horizontal => Node::split_h(ratio, first, second),
            Axis::Vertical => Node::split_v(ratio, first, second),
        }
    }
}

/// Árvore de um grupo `(monitor, workspace)`. `root: None` = grupo vazio.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LayoutTree {
    pub root: Option<Node>,
}

/// Borda de uma janela arrastada num resize manual.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

/// Escopo de um drop (ADR 0026): `Local` subdivide DENTRO da submatriz da janela-alvo (faixa de 1/3 no
/// eixo); `Global` insere a arrastada como NÓ PRINCIPAL do workspace (bloco de 50%). A ponte decide o
/// escopo (cursor sobre o corpo de uma janela = local; perto das bordas da tela ou em gap = global).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropScope {
    Local,
    Global,
}

/// Proporção mínima de um nó (evita folhas degeneradas); o resize faz clamp a isto.
pub const MIN_RATIO: f64 = 0.05;

/// Um slot do BSP: uma janela solta OU um stack inteiro ocupando uma folha. O BSP conta um stack
/// como 1 — a matemática de divisão é idêntica à de janelas soltas.
enum Slot<'a> {
    Single(u64),
    Stack(&'a StackDescriptor),
}

/// Filtro cirúrgico: decide se a janela participa do tiling. Espelha 1:1 a regra que vivia em
/// `_shouldIgnore` (GNOME) e `shouldTile` (KDE):
///  1) não está na `ignore_list` (por `app_id`, case-insensitive — só se houver app_id);
///  2) é redimensionável e maximizável (descarta diálogos rígidos);
///  3) é uma janela normal (descarta dock/utility/splash/dialog).
pub fn is_tileable(window: &WindowInfo, ignore_list: &[String]) -> bool {
    let id = window.app_id.to_lowercase();
    if !id.is_empty() && ignore_list.iter().any(|entry| entry.to_lowercase() == id) {
        return false;
    }
    if !window.resizable || !window.maximizable {
        return false;
    }
    if !window.normal {
        return false;
    }
    true
}

/// Retângulo em ponto-flutuante usado internamente pela recursão do BSP (evita acumular erro de
/// arredondamento entre os níveis da árvore — só arredonda nas folhas).
#[derive(Debug, Clone, Copy)]
struct Rectf {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Calcula o layout-alvo (sem stacks nem grupos desligados). Wrapper fino e RETROCOMPATÍVEL sobre
/// `compute_layout_with`: preserva a assinatura e o comportamento históricos (uma janela por folha).
/// Devolve só os retângulos; quem precisa de barras de abas usa `compute_layout_with`.
pub fn compute_layout(
    windows: &[WindowInfo],
    areas: &[WorkArea],
    opts: &LayoutOptions,
) -> Vec<WindowRect> {
    compute_layout_with(windows, areas, opts, &[], &[]).rects
}

/// Calcula o layout-alvo: agrupa as janelas por `(monitor, workspace)` e distribui cada grupo via
/// divisão binária (BSP) dentro da área útil do seu monitor, aplicando `outer_gap` ao redor e
/// `inner_gap` em cada costura. Preserva a ordem de descoberta das janelas (a ordem é o que torna
/// o rearranjo persistente sem estado no daemon). Janelas cujo monitor não tem área correspondente
/// são ignoradas (não há onde posicioná-las).
///
/// Extensões sobre o BSP base:
///  - `stacks`: um conjunto de janelas pode formar um `StackDescriptor` que ocupa UM único slot
///    (folha) do BSP. Só a aba ativa entra em `rects` (com o retângulo de conteúdo, abaixo da barra);
///    as inativas saem da grade e são ocultadas pela ponte. Cada stack rende um `TabBarRect`.
///  - `disabled_groups`: grupos `(monitor, workspace)` com tiling desligado são PULADOS — suas
///    janelas flutuam livres (a ponte não aplica retângulo).
///
/// O isolamento por workspace é estrito: grupos de `(monitor, workspace)` distintos nunca
/// interferem entre si.
pub fn compute_layout_with(
    windows: &[WindowInfo],
    areas: &[WorkArea],
    opts: &LayoutOptions,
    stacks: &[StackGroup],
    disabled_groups: &[(u32, u32)],
) -> LayoutResult {
    let mut rects = Vec::new();
    let mut tab_bars = Vec::new();

    // Ordem dos grupos `(monitor, workspace)` conforme a primeira janela descoberta em cada um.
    let mut group_order: Vec<(u32, u32)> = Vec::new();
    for w in windows {
        let key = (w.monitor, w.workspace);
        if !group_order.contains(&key) {
            group_order.push(key);
        }
    }

    for (monitor, workspace) in group_order {
        // Grupo com tiling desligado: não posiciona nada (janelas ficam flutuando livres).
        if disabled_groups.contains(&(monitor, workspace)) {
            continue;
        }
        let area = match areas.iter().find(|a| a.index == monitor) {
            Some(a) => a,
            None => continue, // sem área útil conhecida para este monitor → não posiciona
        };
        let ids: Vec<u64> = windows
            .iter()
            .filter(|w| w.monitor == monitor && w.workspace == workspace)
            .map(|w| w.id)
            .collect();

        // Stacks deste grupo, na ordem em que a ponte os enviou.
        let group_stacks: Vec<&StackDescriptor> = stacks
            .iter()
            .filter(|sg| sg.monitor == monitor && sg.workspace == workspace)
            .flat_map(|sg| sg.stacks.iter())
            .collect();

        // Sequência de slots preservando a ordem: um stack ocupa a posição do seu primeiro membro
        // presente; os demais membros saem da sequência (existem só dentro do stack).
        let slots = build_slots(&ids, &group_stacks);

        // Área interna: aplica `outer_gap` uma vez ao redor da área útil (clampada a `>= 0`).
        let inner = inner_rect(area, opts.outer_gap as f64);

        let slot_rects = bsp_rects(inner, slots.len(), opts.inner_gap as f64);
        for (slot, srect) in slots.iter().zip(slot_rects) {
            match slot {
                Slot::Single(id) => rects.push(WindowRect {
                    id: *id,
                    x: round(srect.x),
                    y: round(srect.y),
                    width: round(srect.w),
                    height: round(srect.h),
                }),
                Slot::Stack(desc) => {
                    render_stack(desc, srect, &ids, opts, &mut rects, &mut tab_bars)
                }
            }
        }
    }

    LayoutResult { rects, tab_bars, floating: Vec::new() }
}

/// Monta a sequência de slots de um grupo a partir dos `ids` (na ordem do grupo) e dos `stacks`.
/// Um stack ocupa a posição do seu PRIMEIRO membro presente; ao reencontrar outros membros do mesmo
/// stack, eles são pulados (já representados pelo slot do stack). Ids fora de qualquer stack viram
/// `Slot::Single`. Determinístico: depende só da ordem dos ids e da composição dos stacks.
fn build_slots<'a>(ids: &[u64], stacks: &[&'a StackDescriptor]) -> Vec<Slot<'a>> {
    // Índice do stack que contém um id presente (o primeiro que o lista), se houver.
    let stack_of =
        |id: u64| -> Option<usize> { stacks.iter().position(|s| s.member_ids.contains(&id)) };
    let mut emitted: Vec<usize> = Vec::new();
    let mut slots = Vec::new();
    for &id in ids {
        match stack_of(id) {
            Some(si) => {
                if !emitted.contains(&si) {
                    emitted.push(si);
                    slots.push(Slot::Stack(stacks[si]));
                }
                // Membro de um stack já emitido → não vira slot próprio.
            }
            None => slots.push(Slot::Single(id)),
        }
    }
    slots
}

/// Divisão binária recursiva sobre uma CONTAGEM de slots: "racha" `rect` ao meio pelo lado MAIOR,
/// distribuindo a primeira metade dos slots à primeira subárea e o restante à segunda, deixando
/// `inner_gap` na costura. Devolve um retângulo por slot, NA ORDEM (slot i → rects[i]). Convergência
/// garantida; folhas (1 slot) ocupam o retângulo inteiro; subáreas disjuntas (separadas pelo gap).
fn bsp_rects(rect: Rectf, count: usize, inner_gap: f64) -> Vec<Rectf> {
    match count {
        0 => Vec::new(),
        1 => vec![rect],
        n => {
            let left_count = n.div_ceil(2);
            let (a, b) = if rect.w >= rect.h {
                split_axis(rect, inner_gap, true)
            } else {
                split_axis(rect, inner_gap, false)
            };
            let mut out = bsp_rects(a, left_count, inner_gap);
            out.extend(bsp_rects(b, n - left_count, inner_gap));
            out
        }
    }
}

/// Divide `rect` em dois subretângulos iguais separados por `gap`. `vertical=true` divide no eixo
/// X (lado a lado); `vertical=false` divide no eixo Y (empilhado).
fn split_axis(rect: Rectf, gap: f64, vertical: bool) -> (Rectf, Rectf) {
    if vertical {
        // Clampa a `>= 0`: se o gap exceder a largura (área minúscula), a metade não fica NEGATIVA.
        let w = ((rect.w - gap) / 2.0).max(0.0);
        (
            Rectf { x: rect.x, y: rect.y, w, h: rect.h },
            Rectf { x: rect.x + w + gap, y: rect.y, w, h: rect.h },
        )
    } else {
        let h = ((rect.h - gap) / 2.0).max(0.0);
        (
            Rectf { x: rect.x, y: rect.y, w: rect.w, h },
            Rectf { x: rect.x, y: rect.y + h + gap, w: rect.w, h },
        )
    }
}

/// Detecta a zona de drop sob o ponto `(x, y)` dentro de `area` e devolve o retângulo de preview
/// (já com gaps aplicados, casando visualmente com o destino real do layout). Os limiares são
/// FRAÇÕES da área, então escalam com a resolução. Ordem de prioridade: fora da área → cantos →
/// centro → bordas → metade mais próxima (garante que qualquer ponto do miolo proponha um split).
pub fn detect_drop_zone(area: &WorkArea, x: i32, y: i32, opts: &LayoutOptions) -> DropPreview {
    /// Largura das faixas de borda/canto (fração da dimensão).
    const EDGE: f64 = 0.10;
    /// Limites da caixa central (fração da dimensão) → maximizar.
    const CENTER_LO: f64 = 0.33;
    const CENTER_HI: f64 = 0.67;

    if area.width <= 0 || area.height <= 0 {
        return DropPreview {
            zone: DropZone::None,
            rect: PreviewRect { x: 0, y: 0, width: 0, height: 0 },
        };
    }

    let fx = (x - area.x) as f64 / area.width as f64;
    let fy = (y - area.y) as f64 / area.height as f64;

    // Fora da área útil → sem preview.
    if !(0.0..=1.0).contains(&fx) || !(0.0..=1.0).contains(&fy) {
        return DropPreview {
            zone: DropZone::None,
            rect: PreviewRect { x: 0, y: 0, width: 0, height: 0 },
        };
    }

    let near_left = fx < EDGE;
    let near_right = fx > 1.0 - EDGE;
    let near_top = fy < EDGE;
    let near_bottom = fy > 1.0 - EDGE;

    let zone = if near_left && near_top {
        DropZone::TopLeft
    } else if near_right && near_top {
        DropZone::TopRight
    } else if near_left && near_bottom {
        DropZone::BottomLeft
    } else if near_right && near_bottom {
        DropZone::BottomRight
    } else if (CENTER_LO..=CENTER_HI).contains(&fx) && (CENTER_LO..=CENTER_HI).contains(&fy) {
        DropZone::Center
    } else if near_left {
        DropZone::Left
    } else if near_right {
        DropZone::Right
    } else if near_top {
        DropZone::Top
    } else if near_bottom {
        DropZone::Bottom
    } else if fx < 0.5 {
        DropZone::Left
    } else {
        DropZone::Right
    };

    DropPreview { zone, rect: zone_rect(area, zone, opts) }
}

/// Retângulo-alvo de uma zona: `outer_gap` na borda externa da área e `inner_gap` completo na
/// costura entre metades — idêntico ao que o BSP produziria para o destino real (consistência
/// visual entre o preview e o layout aplicado).
fn zone_rect(area: &WorkArea, zone: DropZone, opts: &LayoutOptions) -> PreviewRect {
    let outer = opts.outer_gap as f64;
    let inner = opts.inner_gap as f64;

    // Área interna (idêntica ao single-window de `compute_layout`).
    let ix = area.x as f64 + outer;
    let iy = area.y as f64 + outer;
    let iw = area.width as f64 - 2.0 * outer;
    let ih = area.height as f64 - 2.0 * outer;

    // Metades com `inner_gap` completo na costura (mesma fórmula do `split_axis`).
    let half_w = (iw - inner) / 2.0;
    let half_h = (ih - inner) / 2.0;
    let right_x = ix + half_w + inner;
    let bottom_y = iy + half_h + inner;

    let (x, y, w, h) = match zone {
        DropZone::Left => (ix, iy, half_w, ih),
        DropZone::Right => (right_x, iy, half_w, ih),
        DropZone::Top => (ix, iy, iw, half_h),
        DropZone::Bottom => (ix, bottom_y, iw, half_h),
        DropZone::TopLeft => (ix, iy, half_w, half_h),
        DropZone::TopRight => (right_x, iy, half_w, half_h),
        DropZone::BottomLeft => (ix, bottom_y, half_w, half_h),
        DropZone::BottomRight => (right_x, bottom_y, half_w, half_h),
        DropZone::Center => (ix, iy, iw, ih),
        // `Stack` é resolvida por `detect_drop_target` (preview = a própria janela-alvo), nunca por
        // `zone_rect`; o braço existe só para a exaustividade do match.
        DropZone::Stack => (0.0, 0.0, 0.0, 0.0),
        DropZone::None => (0.0, 0.0, 0.0, 0.0),
    };

    PreviewRect { x: round(x), y: round(y), width: round(w), height: round(h) }
}

/// Detecta o destino de um drop CONSIDERANDO a janela sob o cursor. Quando há janela-alvo e o cursor
/// está DENTRO dela:
///  - faixa superior (`STACK_BAND` da altura) → `DropZone::Stack` (empilhar nela), preview = a própria
///    janela-alvo;
///  - caso contrário → o sub-quadrante REAL da janela-alvo (metade esquerda/direita/superior/inferior
///    DELA, conforme o lado mais próximo do cursor), casando pixel a pixel com o split que `move_window`
///    produzirá (ratio 0.5 + `inner_gap` na costura). Isto corrige o preview que antes mostrava 50% do
///    MONITOR em grids povoados.
/// Só quando NÃO há janela sob o cursor (ponto solto na área) delega a `detect_drop_zone` (split do
/// monitor). A ponte resolve QUAL é a janela sob o cursor; o core resolve a fração.
pub fn detect_drop_target(
    area: &WorkArea,
    target: Option<PreviewRect>,
    x: i32,
    y: i32,
    opts: &LayoutOptions,
) -> DropPreview {
    /// Fração superior da janela-alvo que dispara o empilhamento.
    const STACK_BAND: f64 = 0.25;

    if let Some(t) = target {
        if t.width > 0 && t.height > 0 {
            let fx = (x - t.x) as f64 / t.width as f64;
            let fy = (y - t.y) as f64 / t.height as f64;
            if (0.0..1.0).contains(&fx) && (0.0..1.0).contains(&fy) {
                if fy < STACK_BAND {
                    return DropPreview { zone: DropZone::Stack, rect: t };
                }
                let (zone, rect) = sub_rect_of_target(t, fx, fy, opts);
                return DropPreview { zone, rect };
            }
        }
    }
    detect_drop_zone(area, x, y, opts)
}

/// Metade da janela-alvo `t` que o drop vai ocupar, escolhida pelo lado mais próximo do cursor
/// (fração `(fx, fy)` dentro de `t`). Usa `inner_gap` na costura, espelhando `split_axis` — assim o
/// preview casa pixel a pixel com o split real produzido por `move_window` (ratio 0.5). Empates de
/// distância resolvem na ordem esquerda → direita → topo → base (determinístico).
fn sub_rect_of_target(
    t: PreviewRect,
    fx: f64,
    fy: f64,
    opts: &LayoutOptions,
) -> (DropZone, PreviewRect) {
    let gap = opts.inner_gap as f64;
    let (tx, ty, tw, th) = (t.x as f64, t.y as f64, t.width as f64, t.height as f64);
    let half_w = (tw - gap) / 2.0;
    let half_h = (th - gap) / 2.0;

    // Distância do cursor a cada borda da janela-alvo; a menor define o lado.
    let (left, right, top, bottom) = (fx, 1.0 - fx, fy, 1.0 - fy);
    let nearest = left.min(right).min(top).min(bottom);

    if nearest == left {
        (
            DropZone::Left,
            PreviewRect { x: round(tx), y: round(ty), width: round(half_w), height: round(th) },
        )
    } else if nearest == right {
        (
            DropZone::Right,
            PreviewRect {
                x: round(tx + half_w + gap),
                y: round(ty),
                width: round(half_w),
                height: round(th),
            },
        )
    } else if nearest == top {
        (
            DropZone::Top,
            PreviewRect { x: round(tx), y: round(ty), width: round(tw), height: round(half_h) },
        )
    } else {
        (
            DropZone::Bottom,
            PreviewRect {
                x: round(tx),
                y: round(ty + half_h + gap),
                width: round(tw),
                height: round(half_h),
            },
        )
    }
}

/// Área interna de um monitor: a área útil menos `outer` em cada borda. Largura/altura clampadas a
/// `>= 0`: um `outer_gap` maior que metade da área (config degenerada) jamais gera dimensão NEGATIVA,
/// que viraria retângulo inválido e a ponte descartaria — esvaziando o grid (ver ADR 0019).
fn inner_rect(area: &WorkArea, outer: f64) -> Rectf {
    Rectf {
        x: area.x as f64 + outer,
        y: area.y as f64 + outer,
        w: (area.width as f64 - 2.0 * outer).max(0.0),
        h: (area.height as f64 - 2.0 * outer).max(0.0),
    }
}

/// Limites `(offset, size)` de cada track ao distribuir `total` por `fracs` (somam ~1) com `gap` entre
/// tracks, a partir de `start`. Replica `split_axis`/o split binário no caso de 2 tracks iguais
/// (geometria idêntica ao BSP de 2 janelas).
fn track_bounds(start: f64, total: f64, fracs: &[f64], gap: f64) -> Vec<(f64, f64)> {
    let n = fracs.len();
    if n == 0 {
        return Vec::new();
    }
    let sum: f64 = fracs.iter().sum::<f64>().max(1e-9);
    let avail = (total - gap * (n.saturating_sub(1)) as f64).max(0.0);
    let mut out = Vec::with_capacity(n);
    let mut cursor = start;
    for f in fracs {
        let size = avail * (f / sum);
        out.push((cursor, size));
        cursor += size + gap;
    }
    out
}

/// Resolve os tamanhos das tracks RESPEITANDO os mínimos por track (cascata elástica): parte das
/// frações desejadas e SATURA as tracks que ficariam abaixo do mínimo, redistribuindo o restante às
/// demais proporcionalmente à fração. Se nem os mínimos cabem, satura todas no mínimo (overflow tratado
/// a montante por auto-float). Com `mins` todos 0, é idêntico a `track_bounds`.
fn solve_tracks(start: f64, total: f64, fracs: &[f64], mins: &[f64], gap: f64) -> Vec<(f64, f64)> {
    let n = fracs.len();
    if n == 0 {
        return Vec::new();
    }
    let sum: f64 = fracs.iter().sum::<f64>().max(1e-9);
    let avail = (total - gap * (n.saturating_sub(1)) as f64).max(0.0);
    let mut size: Vec<f64> = fracs.iter().map(|f| avail * (f / sum)).collect();
    let mut fixed = vec![false; n];
    // Itera saturando as tracks abaixo do mínimo; converge em no máximo `n` passos.
    for _ in 0..n {
        let fixed_sum: f64 = (0..n).filter(|&i| fixed[i]).map(|i| size[i]).sum();
        let free_frac: f64 =
            (0..n).filter(|&i| !fixed[i]).map(|i| fracs[i]).sum::<f64>().max(1e-9);
        let free_avail = (avail - fixed_sum).max(0.0);
        for i in 0..n {
            if !fixed[i] {
                size[i] = free_avail * (fracs[i] / free_frac);
            }
        }
        let mut changed = false;
        for i in 0..n {
            if !fixed[i] && size[i] < mins[i] {
                size[i] = mins[i];
                fixed[i] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut out = Vec::with_capacity(n);
    let mut cursor = start;
    for s in size {
        out.push((cursor, s));
        cursor += s + gap;
    }
    out
}

/// Retângulo de uma célula que cobre `[col..col+col_span) × [row..row+row_span)`, dados os limites de
/// coluna `xb` e de linha `yb`. Inclui os gaps internos ao span (as posições já os embutem).
fn cell_rect(xb: &[(f64, f64)], yb: &[(f64, f64)], c: &GridChild) -> Rectf {
    let c0 = (c.col as usize).min(xb.len().saturating_sub(1));
    let c1 = ((c.col + c.col_span.max(1)) as usize).clamp(1, xb.len());
    let r0 = (c.row as usize).min(yb.len().saturating_sub(1));
    let r1 = ((c.row + c.row_span.max(1)) as usize).clamp(1, yb.len());
    let x = xb[c0].0;
    let xend = xb[c1 - 1].0 + xb[c1 - 1].1;
    let y = yb[r0].0;
    let yend = yb[r1 - 1].0 + yb[r1 - 1].1;
    Rectf { x, y, w: (xend - x).max(0.0), h: (yend - y).max(0.0) }
}

/// Atribui um `Rectf` a cada folha da árvore, aplicando as frações das tracks e o `gap` em cada costura.
fn geom_leaves(node: &Node, rect: Rectf, gap: f64, out: &mut Vec<(u64, Rectf)>) {
    match node {
        Node::Leaf(id) => out.push((*id, rect)),
        // Um stack ocupa um único slot, reportado sob sua âncora (primeiro membro).
        Node::Stack { members, .. } => {
            if let Some(anchor) = members.first() {
                out.push((*anchor, rect));
            }
        }
        Node::Grid { cols, rows, cells } => {
            let xb = track_bounds(rect.x, rect.w, cols, gap);
            let yb = track_bounds(rect.y, rect.h, rows, gap);
            for c in cells {
                geom_leaves(&c.node, cell_rect(&xb, &yb, c), gap, out);
            }
        }
    }
}

/// Extensão MÍNIMA (px) que a subárvore `node` exige ao longo de `axis`, dados os mínimos por folha.
/// Como num BSP os eixos são independentes (split horizontal divide a largura; vertical, a altura), o
/// mínimo se propaga: split no MESMO eixo soma os filhos (+ gap na costura); split PERPENDICULAR usa o
/// `max`. Uma folha contribui só com seu mínimo na direção consultada.
fn min_extent(node: &Node, axis: Axis, gap: f64, min: &MinSizes) -> f64 {
    match node {
        Node::Leaf(id) => {
            let (mw, mh) = min.get(id).copied().unwrap_or((0, 0));
            match axis {
                Axis::Horizontal => mw.max(0) as f64,
                Axis::Vertical => mh.max(0) as f64,
            }
        }
        // O mínimo do slot do stack está agregado sob a âncora (ver `build_min_sizes`: `max` dos
        // membros + `tab_bar_height` na altura).
        Node::Stack { members, .. } => {
            let anchor = members.first().copied().unwrap_or(0);
            let (mw, mh) = min.get(&anchor).copied().unwrap_or((0, 0));
            match axis {
                Axis::Horizontal => mw.max(0) as f64,
                Axis::Vertical => mh.max(0) as f64,
            }
        }
        // Num grid, o mínimo ao longo de um eixo é a SOMA dos mínimos por track (+ gaps) nesse eixo.
        // Generaliza o split binário: para 2 tracks, soma os dois mínimos + 1 gap (idêntico ao antigo
        // `f + gap + s`); no eixo PERPENDICULAR (1 track) é o `max` dos filhos (idêntico a `f.max(s)`).
        Node::Grid { cols, rows, cells } => {
            let ntracks = match axis {
                Axis::Horizontal => cols.len(),
                Axis::Vertical => rows.len(),
            };
            let tmins = track_mins(ntracks, cells, gap, min, axis);
            tmins.iter().sum::<f64>() + gap * (ntracks.saturating_sub(1)) as f64
        }
    }
}

/// Mínimo por track (coluna se `axis == Horizontal`, linha se `Vertical`) de um grid: para cada track,
/// o MAIOR entre os filhos que a cobrem do `min_extent` do filho no eixo, dividido pelo span do filho
/// naquele eixo (distribui o mínimo de um filho com span entre as tracks que ele ocupa).
fn track_mins(
    ntracks: usize,
    cells: &[GridChild],
    gap: f64,
    min: &MinSizes,
    axis: Axis,
) -> Vec<f64> {
    let mut out = vec![0.0; ntracks.max(1)];
    for c in cells {
        let (start, span) = match axis {
            Axis::Horizontal => (c.col as usize, c.col_span.max(1) as usize),
            Axis::Vertical => (c.row as usize, c.row_span.max(1) as usize),
        };
        let me = min_extent(&c.node, axis, gap, min);
        let internal_gap = gap * (span.saturating_sub(1)) as f64;
        let per = ((me - internal_gap).max(0.0)) / span as f64;
        for t in start..(start + span).min(out.len()) {
            if per > out[t] {
                out[t] = per;
            }
        }
    }
    out
}

/// Como `geom_leaves`, mas em cada grid CLAMPA as tracks aos mínimos das subárvores (via `min_extent`
/// → `solve_tracks`). Com `min` vazio (todos os mínimos 0) o resultado é idêntico ao `geom_leaves` puro.
fn geom_leaves_min(
    node: &Node,
    rect: Rectf,
    gap: f64,
    min: &MinSizes,
    focused: Option<u64>,
    out: &mut Vec<(u64, Rectf)>,
) {
    match node {
        Node::Leaf(id) => out.push((*id, rect)),
        Node::Stack { members, .. } => {
            if let Some(anchor) = members.first() {
                out.push((*anchor, rect));
            }
        }
        Node::Grid { cols, rows, cells } => {
            // Mínimos por track (cascata elástica): a track de um filho restrito recebe seu mínimo e
            // as vizinhas maleáveis encolhem; quando o espaço cresce, tudo volta às frações.
            let col_mins = track_mins(cols.len(), cells, gap, min, Axis::Horizontal);
            let row_mins = track_mins(rows.len(), cells, gap, min, Axis::Vertical);
            let xb = solve_tracks(rect.x, rect.w, cols, &col_mins, gap);
            let yb = solve_tracks(rect.y, rect.h, rows, &row_mins, gap);
            for c in cells {
                geom_leaves_min(&c.node, cell_rect(&xb, &yb, c), gap, min, focused, out);
            }
        }
    }
}

/// Renderiza um stack (conjunto de abas) num slot `srect`: barra no topo + conteúdo da aba ativa em
/// `rects`; as inativas ficam de fora (a ponte as oculta). `group_ids` filtra os membros presentes.
/// Compartilhado entre o BSP legado (`compute_layout_with`) e a árvore (`compute_geometry`).
fn render_stack(
    desc: &StackDescriptor,
    srect: Rectf,
    group_ids: &[u64],
    opts: &LayoutOptions,
    rects: &mut Vec<WindowRect>,
    tab_bars: &mut Vec<TabBarRect>,
) {
    let present: Vec<u64> =
        desc.member_ids.iter().copied().filter(|m| group_ids.contains(m)).collect();
    if present.is_empty() {
        return;
    }
    let bar_h = (opts.tab_bar_height as f64).min(srect.h.max(0.0));
    let content = PreviewRect {
        x: round(srect.x),
        y: round(srect.y + bar_h),
        width: round(srect.w),
        height: round((srect.h - bar_h).max(0.0)),
    };
    let active = if present.contains(&desc.active_id) { desc.active_id } else { present[0] };
    rects.push(WindowRect {
        id: active,
        x: content.x,
        y: content.y,
        width: content.width,
        height: content.height,
    });
    tab_bars.push(TabBarRect {
        stack_id: present[0],
        x: round(srect.x),
        y: round(srect.y),
        width: round(srect.w),
        height: round(bar_h),
        content,
        member_ids: present,
        active_id: active,
    });
}

/// Renderiza um stack a partir do NÓ `Node::Stack` da árvore (membros já presentes no grupo): barra
/// no topo + conteúdo da aba ativa em `rects`; as inativas ficam de fora (a ponte as oculta). Espelha
/// `render_stack`, mas lê `members`/`active` direto do nó (sem `StackDescriptor` lateral).
fn render_stack_node(
    members: &[u64],
    active: u64,
    srect: Rectf,
    opts: &LayoutOptions,
    rects: &mut Vec<WindowRect>,
    tab_bars: &mut Vec<TabBarRect>,
) {
    if members.is_empty() {
        return;
    }
    let bar_h = (opts.tab_bar_height as f64).min(srect.h.max(0.0));
    let content = PreviewRect {
        x: round(srect.x),
        y: round(srect.y + bar_h),
        width: round(srect.w),
        height: round((srect.h - bar_h).max(0.0)),
    };
    let active = if members.contains(&active) { active } else { members[0] };
    rects.push(WindowRect {
        id: active,
        x: content.x,
        y: content.y,
        width: content.width,
        height: content.height,
    });
    tab_bars.push(TabBarRect {
        stack_id: members[0],
        x: round(srect.x),
        y: round(srect.y),
        width: round(srect.w),
        height: round(bar_h),
        content,
        member_ids: members.to_vec(),
        active_id: active,
    });
}

/// Mapa âncora→(membros, aba ativa) de todos os `Node::Stack` da árvore — base para renderizar cada
/// slot de stack a partir do seu nó (a âncora é `members[0]`, o id que `geom_leaves` reporta).
fn collect_stack_nodes(node: &Node, out: &mut HashMap<u64, (Vec<u64>, u64)>) {
    match node {
        Node::Stack { members, active } => {
            if let Some(anchor) = members.first() {
                out.insert(*anchor, (members.clone(), *active));
            }
        }
        Node::Grid { cells, .. } => {
            for c in cells {
                collect_stack_nodes(&c.node, out);
            }
        }
        Node::Leaf(_) => {}
    }
}

/// Calcula a geometria a partir da ÁRVORE persistente (aplicando ratios), materializando cada
/// `Node::Stack` numa barra de abas + conteúdo e aplicando os `outer/inner` gaps. Espelha visualmente
/// o `compute_layout_with`, mas guiado pela topologia/proporções da árvore em vez da ordem. Os
/// parâmetros `stacks`/`group_ids` são mantidos por compatibilidade — os stacks agora vivem na própria
/// árvore (`Node::Stack`), então não são mais necessários aqui.
pub fn compute_geometry(
    tree: &LayoutTree,
    area: &WorkArea,
    opts: &LayoutOptions,
    stacks: &[StackDescriptor],
    group_ids: &[u64],
) -> LayoutResult {
    let _ = (stacks, group_ids);
    geometry_from_tree(tree, area, opts, &MinSizes::new(), None)
}

/// Núcleo de `compute_geometry`: percorre a árvore aplicando ratios e CLAMPANDO aos mínimos de `min`
/// (com `min` vazio, geometria proporcional pura). Cada `Node::Stack` rende sua barra de abas. Não
/// decide auto-floating — só tila o que recebe.
fn geometry_from_tree(
    tree: &LayoutTree,
    area: &WorkArea,
    opts: &LayoutOptions,
    min: &MinSizes,
    focused: Option<u64>,
) -> LayoutResult {
    let mut rects = Vec::new();
    let mut tab_bars = Vec::new();
    let root = match &tree.root {
        Some(r) => r,
        None => return LayoutResult { rects, tab_bars, floating: Vec::new() },
    };
    let inner = inner_rect(area, opts.outer_gap as f64);
    let mut leaves = Vec::new();
    geom_leaves_min(root, inner, opts.inner_gap as f64, min, focused, &mut leaves);
    let mut stack_nodes = HashMap::new();
    collect_stack_nodes(root, &mut stack_nodes);
    for (id, r) in leaves {
        if let Some((members, active)) = stack_nodes.get(&id) {
            render_stack_node(members, *active, r, opts, &mut rects, &mut tab_bars);
        } else {
            rects.push(WindowRect {
                id,
                x: round(r.x),
                y: round(r.y),
                width: round(r.w),
                height: round(r.h),
            });
        }
    }
    LayoutResult { rects, tab_bars, floating: Vec::new() }
}

/// Monta o mapa de tamanhos mínimos por FOLHA do grupo a partir das janelas e dos stacks. Uma folha
/// solta carrega o mínimo da própria janela; uma folha-âncora de stack carrega o `max` dos mínimos
/// dos membros presentes (+ `tab_bar_height` na altura, pois a barra come o topo do slot). Membros
/// não-âncora não viram folha, então saem do mapa.
fn build_min_sizes(
    windows: &[WindowInfo],
    stacks: &[StackDescriptor],
    group_ids: &[u64],
    opts: &LayoutOptions,
) -> MinSizes {
    let mut map: MinSizes = HashMap::new();
    for w in windows {
        if group_ids.contains(&w.id) {
            map.insert(w.id, (w.min_width.max(0), w.min_height.max(0)));
        }
    }
    for s in stacks {
        let present: Vec<u64> =
            s.member_ids.iter().copied().filter(|m| group_ids.contains(m)).collect();
        let Some((&anchor, rest)) = present.split_first() else { continue };
        let mut mw = 0;
        let mut mh = 0;
        for m in &present {
            if let Some(w) = windows.iter().find(|w| w.id == *m) {
                mw = mw.max(w.min_width.max(0));
                mh = mh.max(w.min_height.max(0));
            }
        }
        map.insert(anchor, (mw, mh + opts.tab_bar_height as i32));
        for m in rest {
            map.remove(m);
        }
    }
    map
}

/// Id da folha que REPRESENTA a janela focada/nova na árvore: ela mesma, se for folha solta; ou a
/// âncora do `Node::Stack` que a contém. `None` se a focada não está na árvore. Base da proteção
/// contra auto-floating — a janela nova "dita o espaço" e nunca é isolada do grid.
fn focused_leaf_id(tree: &LayoutTree, focused: Option<u64>) -> Option<u64> {
    let f = focused?;
    fn walk(node: &Node, f: u64) -> Option<u64> {
        match node {
            Node::Leaf(id) => (*id == f).then_some(*id),
            Node::Stack { members, .. } => {
                if members.contains(&f) {
                    members.first().copied()
                } else {
                    None
                }
            }
            Node::Grid { cells, .. } => cells.iter().find_map(|c| walk(&c.node, f)),
        }
    }
    walk(tree.root.as_ref()?, f)
}

/// Remove da árvore (para fins de GEOMETRIA) as folhas cujos mínimos tornam o layout inviável,
/// devolvendo a árvore podada + os ids isolados (AUTO-FLOATING). Inviável = em algum eixo o mínimo
/// total da raiz excede a área interna (num BSP os eixos são independentes, então basta checar largura
/// e altura da raiz). A cada passo isola a folha que mais pesa no(s) eixo(s) violado(s) — desempate por
/// MENOR id (determinístico) — e repete até caber. PURA e idempotente: NÃO persiste estado; a árvore
/// COMPLETA continua sendo guardada pela ponte, então a janela volta a tilar quando o espaço cresce.
///
/// A janela `focused` (nova/em foco) é PROTEGIDA: nunca vira vítima do auto-float. Ela mantém o seu
/// mínimo no grid e os vizinhos é que comprimem em cascata (regra "a janela nova dita o espaço", ver
/// ADR 0021). O auto-float só sobra como rede de segurança degenerada: quando, mesmo após espremer
/// todos os vizinhos, o mínimo TOTAL ainda estoura a tela, isola os NÃO-focados (a focada permanece).
fn enforce_min_sizes(
    tree: &LayoutTree,
    area: &WorkArea,
    opts: &LayoutOptions,
    min: &MinSizes,
    focused: Option<u64>,
) -> (LayoutTree, Vec<u64>) {
    let inner = inner_rect(area, opts.outer_gap as f64);
    let gap = opts.inner_gap as f64;
    // Folha intocável (a focada/nova). Estável: nunca é colapsada, então basta computar uma vez.
    let protected = focused_leaf_id(tree, focused);
    let mut tree = tree.clone();
    let mut floated: Vec<u64> = Vec::new();
    loop {
        let Some(root) = &tree.root else { break };
        let over_w = min_extent(root, Axis::Horizontal, gap, min) > inner.w + 0.5;
        let over_h = min_extent(root, Axis::Vertical, gap, min) > inner.h + 0.5;
        if !over_w && !over_h {
            break;
        }
        let victim = collect_leaf_ids(&tree)
            .into_iter()
            .filter(|id| Some(*id) != protected)
            .max_by_key(|id| {
                let (mw, mh) = min.get(id).copied().unwrap_or((0, 0));
                let axis_weight = if over_w { mw.max(0) as i64 } else { 0 }
                    + if over_h { mh.max(0) as i64 } else { 0 };
                // peso no eixo violado, depois área mínima; desempate por MENOR id (Reverse).
                (axis_weight, (mw.max(0) as i64) * (mh.max(0) as i64), std::cmp::Reverse(*id))
            });
        // Sem vítima elegível (só a focada protegida sobrou e ainda não cabe): para. A focada
        // permanece tilada na melhor geometria possível (split forçado prioriza o mínimo dela).
        let Some(victim) = victim else { break };
        tree = collapse_leaf(tree, victim);
        floated.push(victim);
    }
    (tree, floated)
}

/// Retângulo de uma janela em modo flutuante: tamanho atual clampado a `[mínimo, área interna]` (nunca
/// abaixo do mínimo, mesmo que estoure a área), centralizado na área interna do monitor.
fn floating_rect(
    area: &WorkArea,
    opts: &LayoutOptions,
    win: &WindowInfo,
    min: &MinSizes,
) -> WindowRect {
    let inner = inner_rect(area, opts.outer_gap as f64);
    let (mw, mh) =
        min.get(&win.id).copied().unwrap_or((win.min_width.max(0), win.min_height.max(0)));
    let w = (win.width as f64).clamp(mw as f64, inner.w.max(mw as f64));
    let h = (win.height as f64).clamp(mh as f64, inner.h.max(mh as f64));
    WindowRect {
        id: win.id,
        x: round(inner.x + (inner.w - w) / 2.0),
        y: round(inner.y + (inner.h - h) / 2.0),
        width: round(w),
        height: round(h),
    }
}

/// Calcula a geometria RESPEITANDO os tamanhos mínimos das janelas (geometry hints). Monta os mínimos
/// por folha, isola as janelas que estrangulam o grid (auto-floating) e tila o restante com splits
/// assimétricos. É o ponto de entrada usado pelo daemon; `compute_geometry` é o caso sem restrições.
/// A árvore de ENTRADA (completa) deve ser persistida pela ponte — a poda aqui é só para a geometria.
pub fn compute_constrained(
    tree: &LayoutTree,
    area: &WorkArea,
    opts: &LayoutOptions,
    stacks: &[StackDescriptor],
    group_ids: &[u64],
    windows: &[WindowInfo],
    focused: Option<u64>,
) -> LayoutResult {
    let min = build_min_sizes(windows, stacks, group_ids, opts);
    let (geom_tree, floated) = enforce_min_sizes(tree, area, opts, &min, focused);
    let mut res = geometry_from_tree(&geom_tree, area, opts, &min, focused);
    for id in floated {
        if let Some(w) = windows.iter().find(|w| w.id == id) {
            res.floating.push(floating_rect(area, opts, w, &min));
        }
    }
    res
}

/// `true` se a árvore contém a folha `id`.
fn node_contains(node: &Node, id: u64) -> bool {
    match node {
        Node::Leaf(lid) => *lid == id,
        Node::Stack { members, .. } => members.contains(&id),
        Node::Grid { cells, .. } => cells.iter().any(|c| node_contains(&c.node, id)),
    }
}

/// Filtra os ids-alvo de um grupo para o tratamento de UNMAXIMIZE: remove as janelas MAXIMIZADAS que
/// ainda NÃO têm folha na árvore `prev`. Assim, uma janela que abriu já maximizada fica fora do grid
/// (o compositor a mantém maximizada por cima) e só entra quando o usuário a desmaximiza — aí
/// `reconcile`/`insert_one` a inserem pela MAIOR folha (`largest_leaf_id`), dividindo balanceado. Já
/// uma janela que JÁ era folha e foi maximizada temporariamente PERMANECE (seu slot é preservado, e
/// ela volta à posição/proporção originais ao desmaximizar). Pura; preserva a ordem de `group_ids`.
pub fn retain_tileable_when_maximized(
    prev: &LayoutTree,
    group_ids: &[u64],
    maximized_ids: &[u64],
) -> Vec<u64> {
    group_ids
        .iter()
        .copied()
        .filter(|id| {
            !maximized_ids.contains(id)
                || prev.root.as_ref().map(|r| node_contains(r, *id)).unwrap_or(false)
        })
        .collect()
}

/// Todos os ids de folha da árvore (ordem de varredura first→second).
fn collect_leaf_ids(tree: &LayoutTree) -> Vec<u64> {
    fn walk(node: &Node, out: &mut Vec<u64>) {
        match node {
            Node::Leaf(id) => out.push(*id),
            // Um stack ocupa um slot identificado pela sua âncora (primeiro membro).
            Node::Stack { members, .. } => {
                if let Some(anchor) = members.first() {
                    out.push(*anchor);
                }
            }
            Node::Grid { cells, .. } => {
                for c in cells {
                    walk(&c.node, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    if let Some(r) = &tree.root {
        walk(r, &mut out);
    }
    out
}

/// Remove a folha `id` da árvore: o nó pai some e o IRMÃO sobe (absorve espaço e ratio). Se a folha
/// removida era a raiz, a árvore fica vazia.
fn collapse_leaf(tree: LayoutTree, id: u64) -> LayoutTree {
    fn walk(node: Node, id: u64) -> Option<Node> {
        match node {
            Node::Leaf(lid) => {
                if lid == id {
                    None
                } else {
                    Some(Node::Leaf(lid))
                }
            }
            Node::Stack { members, active } => {
                if members.first() == Some(&id) {
                    // A âncora identifica o slot: colapsar a âncora remove o slot inteiro do stack.
                    None
                } else if members.contains(&id) {
                    // Membro não-âncora: tira-o do stack; com 1 sobrando vira folha, com 0 some.
                    let remaining: Vec<u64> =
                        members.iter().copied().filter(|m| *m != id).collect();
                    match remaining.len() {
                        0 => None,
                        1 => Some(Node::Leaf(remaining[0])),
                        _ => {
                            let active =
                                if remaining.contains(&active) { active } else { remaining[0] };
                            Some(Node::Stack { members: remaining, active })
                        }
                    }
                } else {
                    Some(Node::Stack { members, active })
                }
            }
            Node::Grid { cols, rows, cells } => {
                // Colapsa o id dentro de cada célula; remove as que ficaram vazias.
                let mut kept: Vec<GridChild> = Vec::new();
                for c in cells {
                    if let Some(n) = walk(*c.node, id) {
                        kept.push(GridChild {
                            node: Box::new(n),
                            col: c.col,
                            row: c.row,
                            col_span: c.col_span,
                            row_span: c.row_span,
                        });
                    }
                }
                match kept.len() {
                    0 => None,
                    // Sobrou 1 → o sobrevivente ABSORVE o slot inteiro (achata o grid: "o irmão sobe").
                    1 => Some(*kept.into_iter().next().unwrap().node),
                    // ≥2 sobreviventes (grids com >2 células, fora da construção binária) → preserva as
                    // tracks; as posições das células remanescentes seguem válidas.
                    _ => Some(Node::Grid { cols, rows, cells: kept }),
                }
            }
        }
    }
    LayoutTree { root: tree.root.and_then(|r| walk(r, id)) }
}

/// Cria um split binário (grid de 2 tracks) com a janela NOVA (`new_node`) ocupando `new_frac` do eixo,
/// do lado indicado por `new_first`. `new_frac` 0.5 = split balanceado; 1/3 = a nova toma uma faixa de
/// um terço (zona de eixo do jogo da velha) e a antiga é empurrada para os 2/3 restantes.
fn make_split(axis: Axis, new_first: bool, new_frac: f64, new_node: Node, old_node: Node) -> Node {
    let nf = new_frac.clamp(MIN_RATIO, 1.0 - MIN_RATIO);
    if new_first {
        Node::split_on(axis, nf, new_node, old_node)
    } else {
        Node::split_on(axis, 1.0 - nf, old_node, new_node)
    }
}

/// Racha a folha (ou o slot de stack) `target` em duas: `new_id` ocupa `new_frac` do eixo `axis`, no
/// lado `new_first`. As demais folhas não se mexem (estabilidade). Recorre nas células de cada `Grid`.
fn split_leaf_into(
    node: Node,
    target: u64,
    new_id: u64,
    axis: Axis,
    new_first: bool,
    new_frac: f64,
) -> Node {
    match node {
        Node::Leaf(id) if id == target => {
            make_split(axis, new_first, new_frac, Node::Leaf(new_id), Node::Leaf(target))
        }
        Node::Leaf(id) => Node::Leaf(id),
        // Soltar ao lado de um stack (alvo = qualquer membro): racha o SLOT do stack, mantendo o
        // container intacto de um lado e a nova folha do outro. O stack não é dividido por dentro.
        Node::Stack { members, active } if members.contains(&target) => {
            make_split(axis, new_first, new_frac, Node::Leaf(new_id), Node::Stack { members, active })
        }
        Node::Stack { members, active } => Node::Stack { members, active },
        Node::Grid { cols, rows, cells } => Node::Grid {
            cols,
            rows,
            cells: cells
                .into_iter()
                .map(|c| GridChild {
                    node: Box::new(split_leaf_into(
                        *c.node, target, new_id, axis, new_first, new_frac,
                    )),
                    col: c.col,
                    row: c.row,
                    col_span: c.col_span,
                    row_span: c.row_span,
                })
                .collect(),
        },
    }
}

/// Id da maior folha (por área-alvo) da árvore — usado como alvo de inserção quando não há foco no
/// grupo. Aspect-aware via geometria real.
fn largest_leaf_id(root: &Node, area: &WorkArea, opts: &LayoutOptions) -> Option<u64> {
    let inner = inner_rect(area, opts.outer_gap as f64);
    let mut leaves = Vec::new();
    geom_leaves(root, inner, opts.inner_gap as f64, &mut leaves);
    leaves
        .into_iter()
        .max_by(|(_, a), (_, b)| {
            (a.w * a.h).partial_cmp(&(b.w * b.h)).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(id, _)| id)
}

/// Insere `new_id` rachando a folha-alvo: a do `focused` (se presente) ou a maior folha. O eixo do
/// novo split é aspect-aware (folha mais larga → corte vertical/lado a lado; mais alta → horizontal).
fn insert_one(
    tree: LayoutTree,
    new_id: u64,
    focused: Option<u64>,
    area: &WorkArea,
    opts: &LayoutOptions,
) -> LayoutTree {
    let root = match tree.root {
        None => return LayoutTree { root: Some(Node::Leaf(new_id)) },
        Some(r) => r,
    };
    let target =
        focused.filter(|f| node_contains(&root, *f)).or_else(|| largest_leaf_id(&root, area, opts));
    let Some(target) = target else {
        return LayoutTree { root: Some(root) };
    };
    // Aspecto da folha-alvo para escolher o eixo do corte.
    let inner = inner_rect(area, opts.outer_gap as f64);
    let mut leaves = Vec::new();
    geom_leaves(&root, inner, opts.inner_gap as f64, &mut leaves);
    let axis = leaves
        .iter()
        .find(|(id, _)| *id == target)
        .map(|(_, r)| if r.w >= r.h { Axis::Horizontal } else { Axis::Vertical })
        .unwrap_or(Axis::Horizontal);
    LayoutTree { root: Some(split_leaf_into(root, target, new_id, axis, false, 0.5)) }
}

/// Aplica um drop do jogo da velha (ADR 0026). A `zone` dá o eixo e o lado; o `scope` decide a escala:
///  - `Local` — a arrastada toma uma faixa de **1/3** do lado da zona DENTRO do slot do alvo, que é
///    empurrado para os 2/3 restantes (subdivisão fractal da submatriz da janela-alvo);
///  - `Global` — a arrastada vira **nó principal** do workspace, ocupando um bloco de **50%**; todo o
///    resto cascateia no outro 50%.
/// O irmão sempre sobe ao remover a arrastada (nunca perde janela). Zonas de fusão (`Center`/`Stack`)
/// são tratadas pela PONTE (`addToStack`), não aqui → no-op. Cantos caem no eixo horizontal mais
/// próximo (a ponte já resolve a borda dominante; ver ADR 0026 — 2 retângulos exigem um corte único).
pub fn move_window(
    tree: &LayoutTree,
    dragged: u64,
    target: u64,
    zone: DropZone,
    scope: DropScope,
) -> LayoutTree {
    let (axis, dragged_first) = match zone {
        DropZone::Left | DropZone::TopLeft | DropZone::BottomLeft => (Axis::Horizontal, true),
        DropZone::Right | DropZone::TopRight | DropZone::BottomRight => (Axis::Horizontal, false),
        DropZone::Top => (Axis::Vertical, true),
        DropZone::Bottom => (Axis::Vertical, false),
        // Fusão em abas (Center/Stack) é da ponte; None = sem ação.
        _ => return tree.clone(),
    };
    match scope {
        DropScope::Global => {
            // Só o grupo que CONTÉM a arrastada é afetado (o daemon aplica a todas as árvores; as
            // demais são no-op). Sem isto, a arrastada seria inserida em grupos a que não pertence.
            if !tree.root.as_ref().map(|r| node_contains(r, dragged)).unwrap_or(false) {
                return tree.clone();
            }
            // Remove a arrastada e a reinsere como bloco de 50% sobre TODO o resto do workspace.
            let removed = collapse_leaf(tree.clone(), dragged);
            match removed.root {
                None => LayoutTree { root: Some(Node::Leaf(dragged)) },
                Some(rest) => LayoutTree {
                    root: Some(make_split(axis, dragged_first, 0.5, Node::Leaf(dragged), rest)),
                },
            }
        }
        DropScope::Local => {
            if dragged == target {
                return tree.clone();
            }
            // Remove o arrastado; se o alvo não está nesta árvore, desfaz (mantém a original).
            let removed = collapse_leaf(tree.clone(), dragged);
            let root = match removed.root {
                Some(r) if node_contains(&r, target) => r,
                _ => return tree.clone(),
            };
            LayoutTree {
                root: Some(split_leaf_into(root, target, dragged, axis, dragged_first, 1.0 / 3.0)),
            }
        }
    }
}

/// Dois subretângulos iguais (ratio 0.5) de `rect` no `axis`, separados por `gap` — equivalente ao
/// antigo `split_axis`. Usado pelo bootstrap balanceado para recorrer aspect-aware.
fn half_rects(rect: Rectf, gap: f64, axis: Axis) -> (Rectf, Rectf) {
    match axis {
        Axis::Horizontal => {
            let xb = track_bounds(rect.x, rect.w, &[0.5, 0.5], gap);
            (
                Rectf { x: xb[0].0, y: rect.y, w: xb[0].1, h: rect.h },
                Rectf { x: xb[1].0, y: rect.y, w: xb[1].1, h: rect.h },
            )
        }
        Axis::Vertical => {
            let yb = track_bounds(rect.y, rect.h, &[0.5, 0.5], gap);
            (
                Rectf { x: rect.x, y: yb[0].0, w: rect.w, h: yb[0].1 },
                Rectf { x: rect.x, y: yb[1].0, w: rect.w, h: yb[1].1 },
            )
        }
    }
}

/// Constrói uma árvore BALANCEADA a partir de `ids` (ordem preservada), aspect-aware e com ratio
/// 0.5 — geometria idêntica ao BSP de `bsp_rects` (grids binários aninhados). Usada no bootstrap
/// (árvore vazia) para um layout inicial simétrico antes de o usuário rearranjar.
fn balanced_node(ids: &[u64], rect: Rectf, gap: f64) -> Option<Node> {
    match ids.len() {
        0 => None,
        1 => Some(Node::Leaf(ids[0])),
        n => {
            let left_count = n.div_ceil(2);
            let axis = if rect.w >= rect.h { Axis::Horizontal } else { Axis::Vertical };
            let (a, b) = half_rects(rect, gap, axis);
            let first = balanced_node(&ids[..left_count], a, gap)?;
            let second = balanced_node(&ids[left_count..], b, gap)?;
            Some(Node::split_on(axis, 0.5, first, second))
        }
    }
}

/// Converte cada `Node::Stack` na sua `Node::Leaf(âncora)` — a forma "desmaterializada" sobre a qual a
/// lógica de topologia do `reconcile` opera, tratando um stack como uma folha única na posição da
/// âncora (`members[0]`).
fn dematerialize_stacks(node: Node) -> Node {
    match node {
        Node::Stack { members, .. } => Node::Leaf(members.first().copied().unwrap_or(0)),
        Node::Leaf(id) => Node::Leaf(id),
        Node::Grid { cols, rows, cells } => Node::Grid {
            cols,
            rows,
            cells: cells
                .into_iter()
                .map(|c| GridChild {
                    node: Box::new(dematerialize_stacks(*c.node)),
                    col: c.col,
                    row: c.row,
                    col_span: c.col_span,
                    row_span: c.row_span,
                })
                .collect(),
        },
    }
}

/// Remonta os `Node::Stack` a partir das folhas-âncora, conforme o comando de `stacks` da ponte. Para
/// cada stack, a âncora é o primeiro membro presente em `current_ids`; a folha com esse id vira um
/// `Node::Stack` com os membros presentes (na ordem das abas) e a aba ativa resolvida. Stacks com < 2
/// membros presentes NÃO materializam (uma "aba" sozinha é uma janela comum).
fn materialize_stacks(node: Node, stacks: &[StackDescriptor], current_ids: &[u64]) -> Node {
    match node {
        Node::Leaf(id) => {
            for s in stacks {
                let present: Vec<u64> =
                    s.member_ids.iter().copied().filter(|m| current_ids.contains(m)).collect();
                if present.first() == Some(&id) && present.len() >= 2 {
                    let active =
                        if present.contains(&s.active_id) { s.active_id } else { present[0] };
                    return Node::Stack { members: present, active };
                }
            }
            Node::Leaf(id)
        }
        Node::Stack { members, active } => Node::Stack { members, active },
        Node::Grid { cols, rows, cells } => Node::Grid {
            cols,
            rows,
            cells: cells
                .into_iter()
                .map(|c| GridChild {
                    node: Box::new(materialize_stacks(*c.node, stacks, current_ids)),
                    col: c.col,
                    row: c.row,
                    col_span: c.col_span,
                    row_span: c.row_span,
                })
                .collect(),
        },
    }
}

/// Topologia pura do `reconcile` sobre folhas/splits (sem `Node::Stack`): remove as folhas que não são
/// mais alvo e insere as novas (bootstrap balanceado se vazio; senão racha o nó focado/maior).
fn reconcile_topology(
    prev: &LayoutTree,
    target_leaves: &[u64],
    focused: Option<u64>,
    area: &WorkArea,
    opts: &LayoutOptions,
) -> LayoutTree {
    if target_leaves.is_empty() {
        return LayoutTree::default();
    }
    // Bootstrap: sem árvore anterior → layout balanceado (simétrico) a partir das folhas-alvo.
    if prev.root.is_none() {
        let inner = inner_rect(area, opts.outer_gap as f64);
        return LayoutTree { root: balanced_node(target_leaves, inner, opts.inner_gap as f64) };
    }
    // Remoções: folhas que não são mais alvo.
    let mut tree = prev.clone();
    for id in collect_leaf_ids(&tree) {
        if !target_leaves.contains(&id) {
            tree = collapse_leaf(tree, id);
        }
    }
    // Se sobrou vazio mas há alvos (todas as folhas trocaram) → bootstrap balanceado.
    if tree.root.is_none() {
        let inner = inner_rect(area, opts.outer_gap as f64);
        return LayoutTree { root: balanced_node(target_leaves, inner, opts.inner_gap as f64) };
    }
    // Inserções: cada nova folha racha o nó focado (ou a maior), na ordem de `current_ids`.
    for &id in target_leaves {
        if !tree.root.as_ref().map(|r| node_contains(r, id)).unwrap_or(false) {
            tree = insert_one(tree, id, focused, area, opts);
        }
    }
    tree
}

/// Concilia a árvore anterior com o estado atual do grupo:
///  - calcula as folhas-alvo = `current_ids` menos os membros de stack não-âncora (cada stack ocupa
///    uma folha, a do seu primeiro membro presente);
///  - remove (colapsando) as folhas que não são mais alvo;
///  - insere as novas folhas: árvore vazia → BALANCEADA (bootstrap simétrico); árvore existente →
///    cada nova folha racha o nó FOCADO (ou a maior folha), preservando as demais (estabilidade);
///  - MATERIALIZA os stacks do comando da ponte como `Node::Stack` na árvore resultante.
/// Determinístico: depende só das entradas.
pub fn reconcile(
    prev: &LayoutTree,
    current_ids: &[u64],
    stacks: &[StackDescriptor],
    focused: Option<u64>,
    area: &WorkArea,
    opts: &LayoutOptions,
) -> LayoutTree {
    // A topologia opera sobre a forma DESMATERIALIZADA (stack → folha-âncora); os `Node::Stack` são
    // remontados no fim conforme o comando.
    let prev = LayoutTree { root: prev.root.clone().map(dematerialize_stacks) };

    // Membros de stack que NÃO são a âncora (primeiro presente) — não viram folha própria.
    let mut non_anchor: Vec<u64> = Vec::new();
    for s in stacks {
        let present: Vec<u64> =
            s.member_ids.iter().copied().filter(|m| current_ids.contains(m)).collect();
        non_anchor.extend(present.into_iter().skip(1));
    }
    let target_leaves: Vec<u64> =
        current_ids.iter().copied().filter(|id| !non_anchor.contains(id)).collect();

    let demat = reconcile_topology(&prev, &target_leaves, focused, area, opts);
    LayoutTree { root: demat.root.map(|r| materialize_stacks(r, stacks, current_ids)) }
}

/// Uma decisão na descida da raiz até uma folha: o retângulo do nó-split, seu eixo e se descemos
/// pela primeira criança. Usada pelo resize para localizar o split que governa a borda arrastada.
struct Decision {
    rect: Rectf,
    axis: Axis,
    first: bool,
}

/// Caminho (decisões) da raiz até a folha `id`, anotando o `Rectf` de cada split. `false` se a folha
/// não está na árvore.
fn find_path(node: &Node, id: u64, rect: Rectf, gap: f64, out: &mut Vec<Decision>) -> bool {
    match node {
        Node::Leaf(lid) => *lid == id,
        // O stack é um slot atômico: redimensionar qualquer membro redimensiona o slot inteiro.
        Node::Stack { members, .. } => members.contains(&id),
        Node::Grid { cols, rows, cells } => {
            let xb = track_bounds(rect.x, rect.w, cols, gap);
            let yb = track_bounds(rect.y, rect.h, rows, gap);
            // Eixo "binário" do grid (2 tracks num eixo, 1 no outro) — o caso da construção aninhada,
            // o único que o resize governa. Grids não-binários (raros) são atravessados sem decisão.
            let binary_axis = binary_grid_axis(cols, rows);
            for c in cells {
                let cr = cell_rect(&xb, &yb, c);
                match binary_axis {
                    Some(axis) => {
                        let first = match axis {
                            Axis::Horizontal => c.col == 0,
                            Axis::Vertical => c.row == 0,
                        };
                        out.push(Decision { rect, axis, first });
                        if find_path(&c.node, id, cr, gap, out) {
                            return true;
                        }
                        out.pop();
                    }
                    None => {
                        if find_path(&c.node, id, cr, gap, out) {
                            return true;
                        }
                    }
                }
            }
            false
        }
    }
}

/// Eixo de um grid BINÁRIO (2 tracks num eixo, 1 no outro): `Horizontal` se 2 colunas × 1 linha,
/// `Vertical` se 1 coluna × 2 linhas. `None` para qualquer outra forma (não governável por resize).
fn binary_grid_axis(cols: &[f64], rows: &[f64]) -> Option<Axis> {
    if cols.len() == 2 && rows.len() == 1 {
        Some(Axis::Horizontal)
    } else if rows.len() == 2 && cols.len() == 1 {
        Some(Axis::Vertical)
    } else {
        None
    }
}

/// Ajusta (soma `delta`, com clamp) o `ratio` do split alcançado seguindo `path` (sequência de
/// first/second) a partir de `node`. `path` vazio = este nó é o alvo.
fn adjust_ratio(node: Node, path: &[bool], delta: f64) -> Node {
    match node {
        Node::Grid { cols, rows, cells } => {
            let Some(axis) = binary_grid_axis(&cols, &rows) else {
                // Grid não-binário: o resize não o governa (no-op defensivo).
                return Node::Grid { cols, rows, cells };
            };
            if path.is_empty() {
                // Grid governante: ajusta a fração da track 0 (a track 1 absorve; soma constante = 1).
                let (mut tracks, horizontal) = match axis {
                    Axis::Horizontal => (cols.clone(), true),
                    Axis::Vertical => (rows.clone(), false),
                };
                let nr = (tracks[0] + delta).clamp(MIN_RATIO, 1.0 - MIN_RATIO);
                tracks[0] = nr;
                tracks[1] = 1.0 - nr;
                if horizontal {
                    Node::Grid { cols: tracks, rows, cells }
                } else {
                    Node::Grid { cols, rows: tracks, cells }
                }
            } else {
                // Desce na célula do lado indicado por `path[0]`.
                let want_first = path[0];
                let new_cells = cells
                    .into_iter()
                    .map(|c| {
                        let side_first = match axis {
                            Axis::Horizontal => c.col == 0,
                            Axis::Vertical => c.row == 0,
                        };
                        if side_first == want_first {
                            GridChild {
                                node: Box::new(adjust_ratio(*c.node, &path[1..], delta)),
                                col: c.col,
                                row: c.row,
                                col_span: c.col_span,
                                row_span: c.row_span,
                            }
                        } else {
                            c
                        }
                    })
                    .collect();
                Node::Grid { cols, rows, cells: new_cells }
            }
        }
        leaf => leaf,
    }
}

/// Redimensiona elasticamente a janela `id` arrastando a borda `edge` em `delta_px` (positivo =
/// a janela CRESCEU naquela borda). Acha o split ancestral que governa aquela borda — o mais profundo
/// no eixo da borda em que descemos pelo lado certo (Right/Bottom → `first`; Left/Top → `second`) — e
/// ajusta o seu `ratio`. O vizinho imediato encolhe na mesma proporção (a soma das crianças é
/// constante → tela 100% preenchida). Borda externa (sem tal ancestral) ou folha única → no-op.
pub fn resize_window(
    tree: &LayoutTree,
    area: &WorkArea,
    opts: &LayoutOptions,
    id: u64,
    edge: Edge,
    delta_px: i32,
) -> LayoutTree {
    let root = match &tree.root {
        Some(r) => r,
        None => return tree.clone(),
    };
    // Eixo da borda, lado pelo qual a folha deve descer no split governante, e sinal do ajuste.
    let (axis_needed, from_first, sign) = match edge {
        Edge::Right => (Axis::Horizontal, true, 1.0),
        Edge::Left => (Axis::Horizontal, false, -1.0),
        Edge::Bottom => (Axis::Vertical, true, 1.0),
        Edge::Top => (Axis::Vertical, false, -1.0),
    };
    let inner = inner_rect(area, opts.outer_gap as f64);
    let gap = opts.inner_gap as f64;
    let mut path = Vec::new();
    if !find_path(root, id, inner, gap, &mut path) {
        return tree.clone();
    }
    // Split governante: o mais profundo no caminho com o eixo certo e descida pelo lado certo.
    let gov =
        (0..path.len()).rev().find(|&i| path[i].axis == axis_needed && path[i].first == from_first);
    let Some(gi) = gov else {
        return tree.clone(); // borda externa → nada a redimensionar
    };
    let extent = match axis_needed {
        Axis::Horizontal => path[gi].rect.w - gap,
        Axis::Vertical => path[gi].rect.h - gap,
    };
    if extent <= 0.0 {
        return tree.clone();
    }
    let delta_ratio = sign * (delta_px as f64) / extent;
    let node_path: Vec<bool> = path[..gi].iter().map(|d| d.first).collect();
    LayoutTree { root: Some(adjust_ratio(root.clone(), &node_path, delta_ratio)) }
}

/// Arredondamento meio-para-cima compatível com `Math.round` do JS para valores positivos.
fn round(v: f64) -> i32 {
    v.round() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: u64, monitor: u32) -> WindowInfo {
        WindowInfo {
            id,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            app_id: "app".to_string(),
            normal: true,
            resizable: true,
            maximizable: true,
            monitor,
            workspace: 0,
            min_width: 0,
            min_height: 0,
            maximized: false,
        }
    }

    /// `win` com tamanho mínimo (geometry hint) explícito, para os testes de splits assimétricos.
    fn win_min(id: u64, min_width: i32, min_height: i32) -> WindowInfo {
        WindowInfo { min_width, min_height, ..win(id, 0) }
    }

    fn area_1000x800() -> WorkArea {
        WorkArea { index: 0, x: 0, y: 0, width: 1000, height: 800 }
    }

    #[test]
    fn tileable_accepts_normal_resizable_maximizable() {
        assert!(is_tileable(&win(1, 0), &[]));
    }

    #[test]
    fn tileable_rejects_ignored_app_case_insensitive() {
        let mut w = win(1, 0);
        w.app_id = "Firefox".to_string();
        assert!(!is_tileable(&w, &["firefox".to_string()]));
    }

    #[test]
    fn tileable_ignores_empty_app_id_against_ignore_list() {
        let mut w = win(1, 0);
        w.app_id = String::new();
        // app_id vazio nunca casa com a ignore_list (mesmo que contenha "")
        assert!(is_tileable(&w, &[String::new()]));
    }

    #[test]
    fn tileable_rejects_non_resizable_non_maximizable_non_normal() {
        let mut w = win(1, 0);
        w.resizable = false;
        assert!(!is_tileable(&w, &[]));
        let mut w = win(1, 0);
        w.maximizable = false;
        assert!(!is_tileable(&w, &[]));
        let mut w = win(1, 0);
        w.normal = false;
        assert!(!is_tileable(&w, &[]));
    }

    #[test]
    fn layout_empty_for_no_windows() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        assert!(compute_layout(&[], &[area_1000x800()], &opts).is_empty());
    }

    #[test]
    fn extreme_gaps_dont_break_layout() {
        // Gap degenerado (maior que a própria área): o clamp em `inner_rect`/`split_axis` garante que
        // o layout NÃO esvazie nem gere dimensão NEGATIVA (que a ponte descartaria → grid morto).
        // Defesa em profundidade — a UI trava o gap em 0..=100, mas o core não pode quebrar (ADR 0019).
        let opts = LayoutOptions { inner_gap: 2000, outer_gap: 2000, tab_bar_height: 28 };
        let rects = compute_layout(&[win(1, 0), win(2, 0), win(3, 0)], &[area_1000x800()], &opts);
        assert_eq!(rects.len(), 3, "todas as janelas devem receber um retângulo");
        for r in &rects {
            assert!(r.width >= 0, "largura negativa: {}", r.width);
            assert!(r.height >= 0, "altura negativa: {}", r.height);
        }
    }

    #[test]
    fn layout_single_window_fills_inner_area() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let rects = compute_layout(&[win(7, 0)], &[area_1000x800()], &opts);
        assert_eq!(rects, vec![WindowRect { id: 7, x: 12, y: 12, width: 976, height: 776 }]);
    }

    #[test]
    fn layout_two_windows_split_into_halves() {
        // 2 janelas numa área mais larga que alta → split vertical (lado a lado): metades iguais.
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let rects = compute_layout(&[win(1, 0), win(2, 0)], &[area_1000x800()], &opts);
        assert_eq!(
            rects,
            vec![
                WindowRect { id: 1, x: 12, y: 12, width: 484, height: 776 },
                WindowRect { id: 2, x: 504, y: 12, width: 484, height: 776 },
            ]
        );
    }

    #[test]
    fn layout_three_windows_half_plus_two_quarters() {
        // BSP: split vertical (2 esq | 1 dir); a metade esquerda racha na horizontal em dois.
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let rects = compute_layout(&[win(1, 0), win(2, 0), win(3, 0)], &[area_1000x800()], &opts);
        assert_eq!(
            rects,
            vec![
                WindowRect { id: 1, x: 12, y: 12, width: 484, height: 384 },
                WindowRect { id: 2, x: 12, y: 404, width: 484, height: 384 },
                WindowRect { id: 3, x: 504, y: 12, width: 484, height: 776 },
            ]
        );
    }

    #[test]
    fn layout_four_windows_form_2x2_grid() {
        // BSP: split vertical em duas metades; cada metade racha na horizontal → grade 2×2.
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let rects = compute_layout(
            &[win(1, 0), win(2, 0), win(3, 0), win(4, 0)],
            &[area_1000x800()],
            &opts,
        );
        assert_eq!(
            rects,
            vec![
                WindowRect { id: 1, x: 12, y: 12, width: 484, height: 384 },
                WindowRect { id: 2, x: 12, y: 404, width: 484, height: 384 },
                WindowRect { id: 3, x: 504, y: 12, width: 484, height: 384 },
                WindowRect { id: 4, x: 504, y: 404, width: 484, height: 384 },
            ]
        );
    }

    /// Verdadeiro se dois retângulos têm interseção de área positiva.
    fn overlaps(a: &WindowRect, b: &WindowRect) -> bool {
        let ax2 = a.x + a.width;
        let ay2 = a.y + a.height;
        let bx2 = b.x + b.width;
        let by2 = b.y + b.height;
        a.x < bx2 && b.x < ax2 && a.y < by2 && b.y < ay2
    }

    #[test]
    fn layout_never_overlaps_for_many_windows() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        for count in 1..=12u64 {
            let windows: Vec<WindowInfo> = (1..=count).map(|id| win(id, 0)).collect();
            let rects = compute_layout(&windows, &[area_1000x800()], &opts);
            assert_eq!(rects.len() as u64, count, "todas as {count} janelas posicionadas");
            for i in 0..rects.len() {
                for j in (i + 1)..rects.len() {
                    assert!(
                        !overlaps(&rects[i], &rects[j]),
                        "janelas {} e {} se sobrepõem com {count} janelas",
                        rects[i].id,
                        rects[j].id
                    );
                    // E todas dentro da área interna (12..988 x 12..788).
                    assert!(rects[i].x >= 12 && rects[i].x + rects[i].width <= 988);
                    assert!(rects[i].y >= 12 && rects[i].y + rects[i].height <= 788);
                }
            }
        }
    }

    #[test]
    fn layout_groups_by_monitor() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let areas = vec![
            WorkArea { index: 0, x: 0, y: 0, width: 1000, height: 800 },
            WorkArea { index: 1, x: 1000, y: 0, width: 1000, height: 800 },
        ];
        let windows = vec![win(1, 0), win(2, 1), win(3, 0)];
        let rects = compute_layout(&windows, &areas, &opts);
        // Monitor 0 tem 2 janelas (metades); monitor 1 tem 1 (área inteira).
        assert_eq!(rects.len(), 3);
        let m1 = rects.iter().find(|r| r.id == 2).unwrap();
        assert_eq!(*m1, WindowRect { id: 2, x: 1012, y: 12, width: 976, height: 776 });
        // ids 1 e 3 são as metades do monitor 0.
        let r1 = rects.iter().find(|r| r.id == 1).unwrap();
        let r3 = rects.iter().find(|r| r.id == 3).unwrap();
        assert_eq!(r1.x, 12);
        assert_eq!(r3.x, 504);
    }

    #[test]
    fn layout_isolates_by_workspace() {
        // Duas janelas no MESMO monitor mas workspaces distintos: cada grupo tem 1 janela, então
        // cada uma ocupa a área inteira do seu workspace (não viram metades).
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let mut a = win(1, 0);
        a.workspace = 0;
        let mut b = win(2, 0);
        b.workspace = 1;
        let rects = compute_layout(&[a, b], &[area_1000x800()], &opts);
        let full = WindowRect { id: 0, x: 12, y: 12, width: 976, height: 776 };
        let r1 = rects.iter().find(|r| r.id == 1).unwrap();
        let r2 = rects.iter().find(|r| r.id == 2).unwrap();
        assert_eq!((r1.x, r1.y, r1.width, r1.height), (full.x, full.y, full.width, full.height));
        assert_eq!((r2.x, r2.y, r2.width, r2.height), (full.x, full.y, full.width, full.height));
    }

    #[test]
    fn layout_skips_windows_without_known_area() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        // janela no monitor 5, mas só conhecemos a área do monitor 0
        let rects = compute_layout(&[win(1, 5)], &[area_1000x800()], &opts);
        assert!(rects.is_empty());
    }

    // ---- Drop zones ----

    #[test]
    fn drop_zone_left_and_right_halves() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let area = area_1000x800();
        let left = detect_drop_zone(&area, 20, 400, &opts);
        assert_eq!(left.zone, DropZone::Left);
        assert_eq!(left.rect, PreviewRect { x: 12, y: 12, width: 484, height: 776 });
        let right = detect_drop_zone(&area, 980, 400, &opts);
        assert_eq!(right.zone, DropZone::Right);
        assert_eq!(right.rect, PreviewRect { x: 504, y: 12, width: 484, height: 776 });
    }

    #[test]
    fn drop_zone_top_and_bottom_halves() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let area = area_1000x800();
        let top = detect_drop_zone(&area, 500, 20, &opts);
        assert_eq!(top.zone, DropZone::Top);
        assert_eq!(top.rect, PreviewRect { x: 12, y: 12, width: 976, height: 384 });
        let bottom = detect_drop_zone(&area, 500, 780, &opts);
        assert_eq!(bottom.zone, DropZone::Bottom);
        assert_eq!(bottom.rect, PreviewRect { x: 12, y: 404, width: 976, height: 384 });
    }

    #[test]
    fn drop_zone_four_corners() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let area = area_1000x800();
        assert_eq!(detect_drop_zone(&area, 20, 20, &opts).zone, DropZone::TopLeft);
        assert_eq!(
            detect_drop_zone(&area, 20, 20, &opts).rect,
            PreviewRect { x: 12, y: 12, width: 484, height: 384 }
        );
        assert_eq!(detect_drop_zone(&area, 980, 20, &opts).zone, DropZone::TopRight);
        assert_eq!(detect_drop_zone(&area, 20, 780, &opts).zone, DropZone::BottomLeft);
        assert_eq!(detect_drop_zone(&area, 980, 780, &opts).zone, DropZone::BottomRight);
        assert_eq!(
            detect_drop_zone(&area, 980, 780, &opts).rect,
            PreviewRect { x: 504, y: 404, width: 484, height: 384 }
        );
    }

    #[test]
    fn drop_zone_center_maximizes() {
        // O retângulo do centro é idêntico ao single-window do compute_layout.
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let area = area_1000x800();
        let preview = detect_drop_zone(&area, 500, 400, &opts);
        assert_eq!(preview.zone, DropZone::Center);
        let single = compute_layout(&[win(1, 0)], &[area_1000x800()], &opts);
        assert_eq!(preview.rect.x, single[0].x);
        assert_eq!(preview.rect.y, single[0].y);
        assert_eq!(preview.rect.width, single[0].width);
        assert_eq!(preview.rect.height, single[0].height);
    }

    #[test]
    fn drop_zone_midfield_picks_nearest_half() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let area = area_1000x800();
        // Fora das bordas e fora do centro → escolhe a metade horizontal mais próxima.
        assert_eq!(detect_drop_zone(&area, 250, 400, &opts).zone, DropZone::Left);
        assert_eq!(detect_drop_zone(&area, 750, 400, &opts).zone, DropZone::Right);
    }

    #[test]
    fn drop_zone_outside_area_is_none() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let area = area_1000x800();
        let out = detect_drop_zone(&area, -5, 400, &opts);
        assert_eq!(out.zone, DropZone::None);
        assert_eq!(out.rect, PreviewRect { x: 0, y: 0, width: 0, height: 0 });
        assert_eq!(detect_drop_zone(&area, 1005, 400, &opts).zone, DropZone::None);
    }

    #[test]
    fn drop_zone_respects_monitor_offset() {
        // Monitor à direita (x=1000): ponto perto da borda esquerda DAQUELE monitor → Left local.
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 };
        let area = WorkArea { index: 1, x: 1000, y: 0, width: 1000, height: 800 };
        let left = detect_drop_zone(&area, 1020, 400, &opts);
        assert_eq!(left.zone, DropZone::Left);
        assert_eq!(left.rect, PreviewRect { x: 1012, y: 12, width: 484, height: 776 });
    }

    // ---- Stacks (abas) ----

    fn opts() -> LayoutOptions {
        LayoutOptions { inner_gap: 8, outer_gap: 12, tab_bar_height: 28 }
    }

    fn stack_group(members: Vec<u64>, active: u64) -> Vec<StackGroup> {
        vec![StackGroup {
            monitor: 0,
            workspace: 0,
            stacks: vec![StackDescriptor { member_ids: members, active_id: active }],
        }]
    }

    #[test]
    fn stack_occupies_single_bsp_slot() {
        // 1 stack de 3 membros + 1 janela solta → 2 slots: metades lado a lado.
        let windows = vec![win(1, 0), win(2, 0), win(3, 0), win(4, 0)];
        let stacks = stack_group(vec![1, 2, 3], 1);
        let res = compute_layout_with(&windows, &[area_1000x800()], &opts(), &stacks, &[]);
        // rects visíveis: a aba ativa (1) + a janela solta (4) = 2.
        assert_eq!(res.rects.len(), 2);
        assert_eq!(res.tab_bars.len(), 1);
        // O stack ocupa a metade esquerda; a janela solta, a direita.
        assert_eq!((res.tab_bars[0].x, res.tab_bars[0].width), (12, 484));
        let r4 = res.rects.iter().find(|r| r.id == 4).unwrap();
        assert_eq!((r4.x, r4.width), (504, 484));
    }

    #[test]
    fn stack_active_gets_content_below_bar() {
        let windows = vec![win(1, 0), win(2, 0)];
        let res = compute_layout_with(
            &windows,
            &[area_1000x800()],
            &opts(),
            &stack_group(vec![1, 2], 2),
            &[],
        );
        // Um único slot (o stack) ocupa a área interna inteira.
        assert_eq!(res.rects.len(), 1);
        let bar = &res.tab_bars[0];
        assert_eq!((bar.x, bar.y, bar.width, bar.height), (12, 12, 976, 28));
        // Conteúdo da aba ativa: logo abaixo da barra (y = 12 + 28 = 40), altura reduzida.
        assert_eq!(bar.content, PreviewRect { x: 12, y: 40, width: 976, height: 748 });
        let active = &res.rects[0];
        assert_eq!(active.id, 2);
        assert_eq!((active.x, active.y, active.width, active.height), (12, 40, 976, 748));
    }

    #[test]
    fn stack_inactive_members_not_in_rects() {
        let windows = vec![win(1, 0), win(2, 0), win(3, 0)];
        let res = compute_layout_with(
            &windows,
            &[area_1000x800()],
            &opts(),
            &stack_group(vec![1, 2, 3], 2),
            &[],
        );
        // Só a ativa (2) aparece; 1 e 3 ficam de fora (a ponte as oculta).
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 2);
        assert_eq!(res.tab_bars[0].member_ids, vec![1, 2, 3]);
        assert_eq!(res.tab_bars[0].active_id, 2);
        assert_eq!(res.tab_bars[0].stack_id, 1);
    }

    #[test]
    fn stack_invalid_active_falls_back_to_first_present() {
        let windows = vec![win(1, 0), win(2, 0)];
        let res = compute_layout_with(
            &windows,
            &[area_1000x800()],
            &opts(),
            &stack_group(vec![1, 2], 99),
            &[],
        );
        assert_eq!(res.rects[0].id, 1);
        assert_eq!(res.tab_bars[0].active_id, 1);
    }

    #[test]
    fn stack_ignores_absent_members() {
        // Membro 9 não existe no grupo → entra só com os presentes [1, 2].
        let windows = vec![win(1, 0), win(2, 0)];
        let res = compute_layout_with(
            &windows,
            &[area_1000x800()],
            &opts(),
            &stack_group(vec![1, 9, 2], 9),
            &[],
        );
        assert_eq!(res.tab_bars[0].member_ids, vec![1, 2]);
        // active_id 9 ausente → primeiro presente (1).
        assert_eq!(res.tab_bars[0].active_id, 1);
    }

    #[test]
    fn stack_takes_order_position_of_first_member() {
        // Ordem do grupo [1,2,3,4]; stack {2,4} → slots [1, stack, 3]. O stack assume a posição de 2.
        let windows = vec![win(1, 0), win(2, 0), win(3, 0), win(4, 0)];
        let res = compute_layout_with(
            &windows,
            &[area_1000x800()],
            &opts(),
            &stack_group(vec![2, 4], 2),
            &[],
        );
        assert_eq!(res.rects.len(), 3); // 1, ativo do stack, 3
        assert_eq!(res.tab_bars.len(), 1);
        // O slot do stack cai onde a janela 2 cairia na grade 2×2 baseline.
        let baseline = compute_layout(&windows, &[area_1000x800()], &opts());
        let r2 = baseline.iter().find(|r| r.id == 2).unwrap();
        assert_eq!((res.tab_bars[0].x, res.tab_bars[0].y), (r2.x, r2.y));
    }

    #[test]
    fn disabled_group_is_skipped() {
        let windows = vec![win(1, 0), win(2, 0)];
        let res = compute_layout_with(&windows, &[area_1000x800()], &opts(), &[], &[(0, 0)]);
        assert!(res.rects.is_empty());
        assert!(res.tab_bars.is_empty());
    }

    #[test]
    fn disabled_group_isolates_only_its_pair() {
        // Janela 1 no workspace 0 (desligado); janela 2 no workspace 1 (ligado).
        let mut a = win(1, 0);
        a.workspace = 0;
        let mut b = win(2, 0);
        b.workspace = 1;
        let res = compute_layout_with(&[a, b], &[area_1000x800()], &opts(), &[], &[(0, 0)]);
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 2);
    }

    #[test]
    fn legacy_wrapper_matches_baseline() {
        // compute_layout (wrapper) == compute_layout_with(..., &[], &[]).rects.
        let windows = vec![win(1, 0), win(2, 0), win(3, 0)];
        let via_wrapper = compute_layout(&windows, &[area_1000x800()], &opts());
        let via_full = compute_layout_with(&windows, &[area_1000x800()], &opts(), &[], &[]).rects;
        assert_eq!(via_wrapper, via_full);
    }

    // ---- Drag-to-group (detect_drop_target) ----

    #[test]
    fn drop_target_top_band_is_stack() {
        let area = area_1000x800();
        let target = PreviewRect { x: 100, y: 100, width: 400, height: 400 };
        // y dentro dos 25% superiores (100..200) e x dentro → Stack; preview = a própria janela-alvo.
        let p = detect_drop_target(&area, Some(target), 300, 150, &opts());
        assert_eq!(p.zone, DropZone::Stack);
        assert_eq!(p.rect, target);
    }

    #[test]
    fn drop_target_below_band_uses_target_sub_rect() {
        // Abaixo da faixa de stack, o preview é a METADE da janela-alvo (não 50% do monitor).
        let area = area_1000x800();
        let target = PreviewRect { x: 100, y: 100, width: 400, height: 400 };
        // cursor centro-baixo → metade INFERIOR do alvo (half_h = (400-8)/2 = 196; y = 100+196+8).
        let p = detect_drop_target(&area, Some(target), 300, 350, &opts());
        assert_eq!(p.zone, DropZone::Bottom);
        assert_eq!(p.rect, PreviewRect { x: 100, y: 304, width: 400, height: 196 });
        assert_ne!(p.zone, DropZone::Stack);
    }

    #[test]
    fn drop_target_left_and_right_halves_of_target() {
        let area = area_1000x800();
        let target = PreviewRect { x: 100, y: 100, width: 400, height: 400 };
        // Perto da borda esquerda do alvo → metade ESQUERDA dele (half_w = (400-8)/2 = 196).
        let left = detect_drop_target(&area, Some(target), 120, 300, &opts());
        assert_eq!(left.zone, DropZone::Left);
        assert_eq!(left.rect, PreviewRect { x: 100, y: 100, width: 196, height: 400 });
        // Perto da borda direita → metade DIREITA (x = 100 + 196 + 8 = 304).
        let right = detect_drop_target(&area, Some(target), 480, 300, &opts());
        assert_eq!(right.zone, DropZone::Right);
        assert_eq!(right.rect, PreviewRect { x: 304, y: 100, width: 196, height: 400 });
    }

    #[test]
    fn drop_target_top_half_below_stack_band() {
        // Topo do alvo, mas FORA da faixa de stack (fy = 0.25 exato) → metade superior do alvo.
        let area = area_1000x800();
        let target = PreviewRect { x: 100, y: 100, width: 400, height: 400 };
        let p = detect_drop_target(&area, Some(target), 300, 200, &opts());
        assert_eq!(p.zone, DropZone::Top);
        assert_eq!(p.rect, PreviewRect { x: 100, y: 100, width: 400, height: 196 });
    }

    #[test]
    fn drop_target_none_is_plain_split() {
        let area = area_1000x800();
        let p = detect_drop_target(&area, None, 20, 400, &opts());
        assert_eq!(p, detect_drop_zone(&area, 20, 400, &opts()));
    }

    // ---- Árvore BSP persistente ----

    #[test]
    fn reconcile_bootstrap_matches_legacy_bsp() {
        // Árvore vazia → balanceada: geometria IDÊNTICA ao BSP legado para 1..=6 janelas.
        let area = area_1000x800();
        for n in 1..=6u64 {
            let ids: Vec<u64> = (1..=n).collect();
            let windows: Vec<WindowInfo> = ids.iter().map(|&id| win(id, 0)).collect();
            let legacy = compute_layout(&windows, &[area_1000x800()], &opts());
            let tree = reconcile(&LayoutTree::default(), &ids, &[], None, &area, &opts());
            let geo = compute_geometry(&tree, &area, &opts(), &[], &ids);
            assert_eq!(geo.rects, legacy, "n={n}");
        }
    }

    #[test]
    fn reconcile_insert_is_stable() {
        // Abrir a 3ª janela rachando a FOCADA (2) não move a janela 1.
        let area = area_1000x800();
        let a = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let ga = compute_geometry(&a, &area, &opts(), &[], &[1, 2]);
        let b = reconcile(&a, &[1, 2, 3], &[], Some(2), &area, &opts());
        let gb = compute_geometry(&b, &area, &opts(), &[], &[1, 2, 3]);
        // 1 inalterada.
        let a1 = ga.rects.iter().find(|r| r.id == 1).unwrap();
        let b1 = gb.rects.iter().find(|r| r.id == 1).unwrap();
        assert_eq!(a1, b1);
        // 2 e 3 dividem a metade direita (2 em cima, 3 embaixo — folha mais alta que larga).
        let b2 = gb.rects.iter().find(|r| r.id == 2).unwrap();
        let b3 = gb.rects.iter().find(|r| r.id == 3).unwrap();
        assert_eq!(*b2, WindowRect { id: 2, x: 504, y: 12, width: 484, height: 384 });
        assert_eq!(*b3, WindowRect { id: 3, x: 504, y: 404, width: 484, height: 384 });
    }

    #[test]
    fn reconcile_remove_collapses_sibling() {
        // Remover uma das duas folhas faz a irmã ocupar a área inteira.
        let area = area_1000x800();
        let a = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let b = reconcile(&a, &[2], &[], None, &area, &opts());
        let gb = compute_geometry(&b, &area, &opts(), &[], &[2]);
        assert_eq!(gb.rects, vec![WindowRect { id: 2, x: 12, y: 12, width: 976, height: 776 }]);
    }

    #[test]
    fn reconcile_is_idempotent() {
        // Reconciliar com os mesmos ids/foco não muda a árvore.
        let area = area_1000x800();
        let a = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], Some(1), &area, &opts());
        let b = reconcile(&a, &[1, 2, 3], &[], Some(1), &area, &opts());
        assert_eq!(a, b);
    }

    #[test]
    fn reconcile_never_overlaps_after_incremental_inserts() {
        // Inserções incrementais (focando sempre a última) nunca sobrepõem e cobrem todos os ids.
        let area = area_1000x800();
        let mut tree = LayoutTree::default();
        for n in 1..=10u64 {
            let ids: Vec<u64> = (1..=n).collect();
            tree = reconcile(&tree, &ids, &[], Some(n.saturating_sub(1)), &area, &opts());
            let geo = compute_geometry(&tree, &area, &opts(), &[], &ids);
            assert_eq!(geo.rects.len() as u64, n, "todas as {n} posicionadas");
            for i in 0..geo.rects.len() {
                for j in (i + 1)..geo.rects.len() {
                    assert!(!overlaps(&geo.rects[i], &geo.rects[j]), "sobreposição com {n}");
                }
            }
        }
    }

    #[test]
    fn compute_geometry_renders_stack_anchor_leaf() {
        // Stack [1,2,3] (âncora 1) + janela solta 4 → 2 slots; a folha 1 vira barra de abas.
        let area = area_1000x800();
        let stacks = vec![StackDescriptor { member_ids: vec![1, 2, 3], active_id: 1 }];
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3, 4], &stacks, None, &area, &opts());
        let res = compute_geometry(&tree, &area, &opts(), &stacks, &[1, 2, 3, 4]);
        // rects visíveis: a aba ativa (1) + a janela solta (4).
        assert_eq!(res.rects.len(), 2);
        assert_eq!(res.tab_bars.len(), 1);
        // O stack ocupa a metade esquerda; a janela solta, a direita.
        assert_eq!((res.tab_bars[0].x, res.tab_bars[0].width), (12, 484));
        assert_eq!(res.tab_bars[0].member_ids, vec![1, 2, 3]);
        let r4 = res.rects.iter().find(|r| r.id == 4).unwrap();
        assert_eq!((r4.x, r4.width), (504, 484));
    }

    /// Busca o primeiro `Node::Stack` da árvore (helper de teste).
    fn find_stack_node(n: &Node) -> Option<(Vec<u64>, u64)> {
        match n {
            Node::Stack { members, active } => Some((members.clone(), *active)),
            Node::Grid { cells, .. } => cells.iter().find_map(|c| find_stack_node(&c.node)),
            Node::Leaf(_) => None,
        }
    }

    #[test]
    fn reconcile_materializes_and_unmaterializes_stack_node() {
        // Agrupar [1,2,3] (ativa 2) + janela solta 4 → a árvore deve conter um Node::Stack.
        let area = area_1000x800();
        let stacks = vec![StackDescriptor { member_ids: vec![1, 2, 3], active_id: 2 }];
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3, 4], &stacks, None, &area, &opts());
        let (members, active) =
            find_stack_node(tree.root.as_ref().unwrap()).expect("deve haver Node::Stack");
        assert_eq!(members, vec![1, 2, 3]);
        assert_eq!(active, 2);

        // Desagrupar (sem stacks no comando) reexpande os membros em folhas independentes.
        let t2 = reconcile(&tree, &[1, 2, 3, 4], &[], None, &area, &opts());
        assert!(find_stack_node(t2.root.as_ref().unwrap()).is_none(), "stack deve desmaterializar");
        for id in [1u64, 2, 3, 4] {
            assert!(node_contains(t2.root.as_ref().unwrap(), id), "folha {id} deve existir");
        }
    }

    #[test]
    fn ungroup_single_member_returns_window_to_grid_as_leaf() {
        // Remover uma janela do stack [1,2,3] (desagrupar uma) → stack vira [1,3] e 2 vira folha.
        let area = area_1000x800();
        let stacks0 = vec![StackDescriptor { member_ids: vec![1, 2, 3], active_id: 1 }];
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &stacks0, None, &area, &opts());
        let stacks1 = vec![StackDescriptor { member_ids: vec![1, 3], active_id: 1 }];
        let t2 = reconcile(&tree, &[1, 2, 3], &stacks1, None, &area, &opts());
        let (members, _) =
            find_stack_node(t2.root.as_ref().unwrap()).expect("ainda há stack [1,3]");
        assert_eq!(members, vec![1, 3]);
        // A janela 2 desagrupada é uma folha independente no grid.
        assert!(node_contains(t2.root.as_ref().unwrap(), 2));
        let res = compute_geometry(&t2, &area, &opts(), &stacks1, &[1, 2, 3]);
        assert!(res.rects.iter().any(|r| r.id == 2), "2 desagrupada deve ter retângulo próprio");
    }

    #[test]
    fn compute_geometry_empty_tree_is_empty() {
        let area = area_1000x800();
        let res = compute_geometry(&LayoutTree::default(), &area, &opts(), &[], &[]);
        assert!(res.rects.is_empty());
        assert!(res.tab_bars.is_empty());
    }

    #[test]
    fn move_window_splits_target_on_zone_side() {
        // [1,2,3] balanceada; mover 3 para a ESQUERDA de 1 → 3 fica à esquerda de 1.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], None, &area, &opts());
        let moved = move_window(&tree, 3, 1, DropZone::Left, DropScope::Local);
        let geo = compute_geometry(&moved, &area, &opts(), &[], &[1, 2, 3]);
        assert_eq!(geo.rects.len(), 3);
        let r1 = geo.rects.iter().find(|r| r.id == 1).unwrap();
        let r3 = geo.rects.iter().find(|r| r.id == 3).unwrap();
        // 3 à esquerda de 1 (mesma faixa vertical, x menor); 3 toma 1/3, 1 fica com 2/3.
        assert!(r3.x < r1.x);
        assert_eq!(r3.y, r1.y);
        assert_eq!(r3.height, r1.height);
        assert!(r3.width < r1.width, "a faixa de 1/3 da arrastada é menor que os 2/3 do alvo");
    }

    #[test]
    fn move_window_noop_for_center_and_missing_target() {
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        // Center → inalterado (fusão em abas é tratada pela ponte).
        assert_eq!(move_window(&tree, 2, 1, DropZone::Center, DropScope::Local), tree);
        // Alvo ausente → inalterado (não perde a janela arrastada).
        assert_eq!(move_window(&tree, 2, 99, DropZone::Left, DropScope::Local), tree);
    }

    #[test]
    fn move_window_global_insere_bloco_de_50_porcento() {
        // [1,2,3]; mover 3 para a ESQUERDA em escopo GLOBAL → 3 ocupa ~50% da tela; 1 e 2 no outro 50%.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], None, &area, &opts());
        let moved = move_window(&tree, 3, 0, DropZone::Left, DropScope::Global);
        let geo = compute_geometry(&moved, &area, &opts(), &[], &[1, 2, 3]);
        assert_eq!(geo.rects.len(), 3);
        let r3 = geo.rects.iter().find(|r| r.id == 3).unwrap();
        // 3 à esquerda ocupando ~metade da largura interna (976 - gap 8) / 2 = 484.
        assert_eq!((r3.x, r3.width, r3.height), (12, 484, 776));
        // 1 e 2 ficam à direita de 3 (no outro bloco de 50%).
        for id in [1u64, 2] {
            let r = geo.rects.iter().find(|r| r.id == id).unwrap();
            assert!(r.x > r3.x + r3.width - 1, "janela {id} no bloco direito");
        }
    }

    #[test]
    fn move_window_local_da_um_terco_ao_arrastado() {
        // [1,2]; soltar 2 sobre o EIXO superior de 1 (local) → 2 toma 1/3 da altura, 1 fica com 2/3.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let moved = move_window(&tree, 2, 1, DropZone::Top, DropScope::Local);
        let geo = compute_geometry(&moved, &area, &opts(), &[], &[1, 2]);
        let r1 = geo.rects.iter().find(|r| r.id == 1).unwrap();
        let r2 = geo.rects.iter().find(|r| r.id == 2).unwrap();
        // 2 no topo, mais baixa que 1 (1/3 vs 2/3); empilhadas verticalmente.
        assert!(r2.y < r1.y);
        assert!(r2.height < r1.height);
    }

    #[test]
    fn resize_window_horizontal_is_elastic_and_fills() {
        // [1|2] lado a lado; arrastar a borda DIREITA de 1 em +100 → 1 cresce 100, 2 encolhe 100.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let before = compute_geometry(&tree, &area, &opts(), &[], &[1, 2]);
        let b1 = before.rects.iter().find(|r| r.id == 1).unwrap();
        let b2 = before.rects.iter().find(|r| r.id == 2).unwrap();
        let resized = resize_window(&tree, &area, &opts(), 1, Edge::Right, 100);
        let after = compute_geometry(&resized, &area, &opts(), &[], &[1, 2]);
        let a1 = after.rects.iter().find(|r| r.id == 1).unwrap();
        let a2 = after.rects.iter().find(|r| r.id == 2).unwrap();
        assert_eq!(a1.width, b1.width + 100);
        assert_eq!(a2.width, b2.width - 100);
        // Tela 100% preenchida: a soma das larguras + a costura é constante.
        assert_eq!(a1.width + a2.width, b1.width + b2.width);
        // Mesma faixa vertical (não tocou no eixo Y).
        assert_eq!(a1.height, b1.height);
    }

    #[test]
    fn resize_window_left_edge_grows_window_leftward() {
        // [1|2]; arrastar a borda ESQUERDA de 2 em +60 (cresceu) → 2 cresce 60, 1 encolhe 60.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let before = compute_geometry(&tree, &area, &opts(), &[], &[1, 2]);
        let b1 = before.rects.iter().find(|r| r.id == 1).unwrap().width;
        let b2 = before.rects.iter().find(|r| r.id == 2).unwrap().width;
        let resized = resize_window(&tree, &area, &opts(), 2, Edge::Left, 60);
        let after = compute_geometry(&resized, &area, &opts(), &[], &[1, 2]);
        assert_eq!(after.rects.iter().find(|r| r.id == 2).unwrap().width, b2 + 60);
        assert_eq!(after.rects.iter().find(|r| r.id == 1).unwrap().width, b1 - 60);
    }

    #[test]
    fn resize_window_vertical_axis() {
        // Bootstrap [1,2,3]: 1 e 2 EMPILHADOS na metade esquerda (split vertical), 3 na direita.
        // Arrastar a borda INFERIOR de 1 (a costura 1↔2) em +50 → 1 cresce, 2 encolhe.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], None, &area, &opts());
        let before = compute_geometry(&tree, &area, &opts(), &[], &[1, 2, 3]);
        let b1 = before.rects.iter().find(|r| r.id == 1).unwrap().height;
        let b2 = before.rects.iter().find(|r| r.id == 2).unwrap().height;
        let resized = resize_window(&tree, &area, &opts(), 1, Edge::Bottom, 50);
        let after = compute_geometry(&resized, &area, &opts(), &[], &[1, 2, 3]);
        assert_eq!(after.rects.iter().find(|r| r.id == 1).unwrap().height, b1 + 50);
        assert_eq!(after.rects.iter().find(|r| r.id == 2).unwrap().height, b2 - 50);
    }

    #[test]
    fn resize_window_outer_edge_is_noop() {
        // Borda esquerda de 1 (já colada na borda do monitor) não tem split governante → no-op.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        assert_eq!(resize_window(&tree, &area, &opts(), 1, Edge::Left, 50), tree);
        // Folha única também não redimensiona.
        let single = reconcile(&LayoutTree::default(), &[1], &[], None, &area, &opts());
        assert_eq!(resize_window(&single, &area, &opts(), 1, Edge::Right, 50), single);
    }

    #[test]
    fn resize_window_clamps_to_min_ratio() {
        // Delta gigante não colapsa a vizinha: o ratio é clampado (ambas as larguras > 0).
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let resized = resize_window(&tree, &area, &opts(), 1, Edge::Right, 100_000);
        let after = compute_geometry(&resized, &area, &opts(), &[], &[1, 2]);
        let w2 = after.rects.iter().find(|r| r.id == 2).unwrap().width;
        assert!(w2 > 0, "vizinha nunca colapsa a zero");
    }

    // ---- Tamanhos mínimos (geometry hints): splits assimétricos + auto-floating ----

    #[test]
    fn min_extent_soma_no_mesmo_eixo_e_max_no_perpendicular() {
        // Grid de 2 colunas (1,2): largura = min1 + gap + min2; altura = max(min1, min2).
        let tree = LayoutTree { root: Some(Node::split_h(0.5, Node::Leaf(1), Node::Leaf(2))) };
        let mut min = MinSizes::new();
        min.insert(1, (300, 200));
        min.insert(2, (100, 150));
        let root = tree.root.as_ref().unwrap();
        assert_eq!(min_extent(root, Axis::Horizontal, 8.0, &min), 300.0 + 8.0 + 100.0);
        assert_eq!(min_extent(root, Axis::Vertical, 8.0, &min), 200.0);
    }

    #[test]
    fn split_respeita_min_da_primeira_e_espreme_vizinha() {
        // Janela 1 com min_width 700 num par 50/50: recebe seu mínimo; a 2 encolhe (modo forçado).
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let windows = vec![win_min(1, 700, 0), win(2, 0)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &[1, 2], &windows, None);
        let r1 = res.rects.iter().find(|r| r.id == 1).unwrap();
        let r2 = res.rects.iter().find(|r| r.id == 2).unwrap();
        assert!(res.floating.is_empty());
        assert_eq!(r1.width, 700);
        // avail = inner(976) - gap(8) = 968 → a vizinha fica com 968 - 700 = 268.
        assert_eq!(r2.width, 268);
        assert_eq!(r1.width + r2.width, 968);
    }

    #[test]
    fn min_nao_muta_o_ratio_persistido() {
        // O clamp é SÓ de geometria: a árvore mantém ratio 0.5 (geometria sem restrição volta 50/50).
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let windows = vec![win_min(1, 700, 0), win(2, 0)];
        let _ = compute_constrained(&tree, &area, &opts(), &[], &[1, 2], &windows, None);
        let plain = compute_geometry(&tree, &area, &opts(), &[], &[1, 2]);
        assert_eq!(plain.rects.iter().find(|r| r.id == 1).unwrap().width, 484);
    }

    #[test]
    fn min_volta_ao_normal_quando_a_area_cresce() {
        // Em tela larga, 700px < metade proporcional → o mínimo não força; volta a 50/50.
        let area = WorkArea { index: 0, x: 0, y: 0, width: 4000, height: 800 };
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let windows = vec![win_min(1, 700, 0), win(2, 0)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &[1, 2], &windows, None);
        let r1 = res.rects.iter().find(|r| r.id == 1).unwrap();
        let r2 = res.rects.iter().find(|r| r.id == 2).unwrap();
        assert_eq!(r1.width, r2.width, "espaço amplo → proporcional, sem clamp");
    }

    #[test]
    fn auto_floata_janela_cujo_minimo_nao_cabe() {
        // min_width 2000 > área: a janela sai do grid (floating) e a vizinha ocupa tudo.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let windows = vec![win_min(1, 2000, 0), win(2, 0)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &[1, 2], &windows, None);
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 2);
        assert_eq!(res.rects[0].width, 976, "a vizinha ocupa a área interna inteira");
        assert_eq!(res.floating.len(), 1);
        assert_eq!(res.floating[0].id, 1);
        assert_eq!(res.floating[0].width, 2000, "a flutuante mantém ao menos seu mínimo");
    }

    #[test]
    fn auto_floating_e_idempotente() {
        // Rodar duas vezes com as mesmas entradas dá exatamente o mesmo resultado (sem thrash).
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], None, &area, &opts());
        let windows = vec![win_min(1, 2000, 0), win(2, 0), win(3, 0)];
        let a = compute_constrained(&tree, &area, &opts(), &[], &[1, 2, 3], &windows, None);
        let b = compute_constrained(&tree, &area, &opts(), &[], &[1, 2, 3], &windows, None);
        assert_eq!(a, b);
    }

    #[test]
    fn auto_floata_todas_quando_nenhuma_cabe_e_nunca_some() {
        // Caso do log "N janelas → 0 rects": se NENHUMA janela cabe (todas com min gigante), o grid
        // tilado fica vazio — mas o motor NUNCA some com as janelas: todas viram floating (visíveis,
        // acima do grid). 0 rects + 0 floating com janelas tileáveis seria a regressão; aqui provamos
        // que não acontece.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let windows = vec![win_min(1, 2000, 0), win_min(2, 2000, 0)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &[1, 2], &windows, None);
        assert!(res.rects.is_empty(), "ninguém cabe → grid tilado vazio");
        assert_eq!(res.floating.len(), 2, "as 2 continuam visíveis via auto-floating");
    }

    #[test]
    fn stack_min_agrega_max_dos_membros_mais_tab_bar() {
        // A folha-âncora de um stack carrega o MAX dos mínimos dos membros (+ tab_bar na altura);
        // membros não-âncora saem do mapa (não viram folha própria).
        let windows = vec![win_min(1, 300, 200), win_min(2, 500, 100)];
        let stacks = vec![StackDescriptor { member_ids: vec![1, 2], active_id: 1 }];
        let m = build_min_sizes(&windows, &stacks, &[1, 2], &opts());
        assert_eq!(m.get(&1), Some(&(500, 200 + 28)));
        assert_eq!(m.get(&2), None);
    }

    #[test]
    fn resize_abaixo_do_min_satura_geometria_mas_preserva_o_resize() {
        // Encolher a 1 abaixo do seu min: a geometria satura no mínimo, mas o resize (ratio) valeu.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let resized = resize_window(&tree, &area, &opts(), 1, Edge::Right, -300);
        // sem restrição: a 1 encolheu para 184 (o resize funcionou).
        let plain = compute_geometry(&resized, &area, &opts(), &[], &[1, 2]);
        assert_eq!(plain.rects.iter().find(|r| r.id == 1).unwrap().width, 184);
        // com min 600: a geometria satura em 600 (sem quebrar a UI), a vizinha fica com 368.
        let windows = vec![win_min(1, 600, 0), win(2, 0)];
        let res = compute_constrained(&resized, &area, &opts(), &[], &[1, 2], &windows, None);
        assert_eq!(res.rects.iter().find(|r| r.id == 1).unwrap().width, 600);
        assert_eq!(res.rects.iter().find(|r| r.id == 2).unwrap().width, 368);
    }

    #[test]
    fn constrained_nunca_sobrepoe_com_mins_variados() {
        // Quatro janelas com mínimos diversos: os retângulos tilados nunca se sobrepõem.
        let area = area_1000x800();
        let ids = [1u64, 2, 3, 4];
        let tree = reconcile(&LayoutTree::default(), &ids, &[], None, &area, &opts());
        let windows = vec![win_min(1, 400, 300), win_min(2, 200, 0), win(3, 0), win_min(4, 0, 250)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &ids, &windows, None);
        let rs = &res.rects;
        for i in 0..rs.len() {
            for j in (i + 1)..rs.len() {
                let (a, b) = (&rs[i], &rs[j]);
                let disjoint = a.x + a.width <= b.x
                    || b.x + b.width <= a.x
                    || a.y + a.height <= b.y
                    || b.y + b.height <= a.y;
                assert!(disjoint, "rects {} e {} se sobrepõem", a.id, b.id);
            }
        }
    }

    #[test]
    fn focada_com_min_rigido_encaixa_e_vizinhos_cascateiam_sem_floatar() {
        // Regra "a janela nova dita o espaço" (ADR 0021): a focada (1) com min 500 e a vizinha 2 com
        // min 200 recebem ao menos os seus mínimos no grid e a 3 (maleável) absorve o resto — ninguém
        // flutua, nada se sobrepõe. Invariantes (independentes da topologia que `reconcile` escolher).
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], Some(1), &area, &opts());
        let windows = vec![win_min(1, 500, 0), win_min(2, 200, 0), win(3, 0)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &[1, 2, 3], &windows, Some(1));
        assert!(res.floating.is_empty(), "ninguém flutua: tudo cabe via cascata");
        assert_eq!(res.rects.len(), 3, "as 3 ficam no grid");
        let w = |id: u64| res.rects.iter().find(|r| r.id == id).unwrap().width;
        assert!(w(1) >= 500, "a focada mantém ao menos o seu mínimo (got {})", w(1));
        assert!(w(2) >= 200, "vizinha 2 mantém ao menos o seu mínimo (got {})", w(2));
        assert!(w(3) >= 1, "vizinha 3 segue visível");
        // Nenhum par de retângulos se sobrepõe.
        let rs = &res.rects;
        for i in 0..rs.len() {
            for j in (i + 1)..rs.len() {
                let (a, b) = (&rs[i], &rs[j]);
                let disjoint = a.x + a.width <= b.x
                    || b.x + b.width <= a.x
                    || a.y + a.height <= b.y
                    || b.y + b.height <= a.y;
                assert!(disjoint, "rects {} e {} se sobrepõem", a.id, b.id);
            }
        }
    }

    #[test]
    fn focada_protegida_do_autofloat_o_vizinho_e_que_cede() {
        // Mesma entrada de `auto_floata_janela_cujo_minimo_nao_cabe`, mas AGORA a janela restrita (1)
        // está FOCADA: ela é protegida e NÃO flutua — quem sai do grid é a vizinha. Contraste direto:
        // sem foco, a 1 flutuava; com foco, a 1 permanece tilada (a nova janela nunca é jogada fora).
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], Some(1), &area, &opts());
        let windows = vec![win_min(1, 2000, 0), win(2, 0)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &[1, 2], &windows, Some(1));
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 1, "a focada permanece no grid");
        assert_eq!(res.rects[0].width, 976, "ocupa a área interna inteira (melhor esforço)");
        assert_eq!(res.floating.len(), 1);
        assert_eq!(res.floating[0].id, 2, "o vizinho não-focado é que flutua");
    }

    #[test]
    fn focada_nunca_e_vitima_so_os_nao_focados_floatam() {
        // Três janelas, a focada (1) com min inviável: o auto-float isola APENAS os não-focados
        // (2 e 3), nunca a focada. Garante que a proteção vale mesmo com múltiplos candidatos.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], Some(1), &area, &opts());
        let windows = vec![win_min(1, 4000, 0), win(2, 0), win(3, 0)];
        let res = compute_constrained(&tree, &area, &opts(), &[], &[1, 2, 3], &windows, Some(1));
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 1, "a focada nunca é a vítima");
        let floated: Vec<u64> = res.floating.iter().map(|r| r.id).collect();
        assert!(floated.contains(&2) && floated.contains(&3));
        assert!(!floated.contains(&1));
    }

    #[test]
    fn solve_tracks_respeita_minimos_e_espreme_em_cascata() {
        // 2 tracks 50/50 com mínimo só na 1ª (600): a 1ª recebe 600 e a 2ª encolhe (cascata elástica).
        // avail = 1000 - gap(8) = 992 → 2ª fica com 992 - 600 = 392.
        let t = solve_tracks(0.0, 1000.0, &[0.5, 0.5], &[600.0, 0.0], 8.0);
        assert_eq!(t.len(), 2);
        assert!((t[0].1 - 600.0).abs() < 1e-6, "1ª track recebe o mínimo");
        assert!((t[1].1 - 392.0).abs() < 1e-6, "2ª track absorve o resto (cascata)");
        // Sem mínimos, é idêntico à distribuição pura (track_bounds): 50/50 de 992.
        let p = solve_tracks(0.0, 1000.0, &[0.5, 0.5], &[0.0, 0.0], 8.0);
        assert!((p[0].1 - 496.0).abs() < 1e-6 && (p[1].1 - 496.0).abs() < 1e-6);
        // Caso degenerado (os dois mínimos > avail): ambas SATURAM no mínimo (overflow tratado a
        // montante por auto-float); nunca há track negativa.
        let d = solve_tracks(0.0, 1000.0, &[0.5, 0.5], &[600.0, 600.0], 8.0);
        assert!((d[0].1 - 600.0).abs() < 1e-6 && (d[1].1 - 600.0).abs() < 1e-6);
    }

    // ---- Unmaximize Recovery ----

    #[test]
    fn maximized_nova_fica_fora_do_grid_e_entra_pela_maior_folha_ao_voltar() {
        // Janela 2 abre JÁ MAXIMIZADA (sem folha prévia): é podada dos alvos enquanto maximizada.
        let area = area_1000x800();
        let tree1 = reconcile(&LayoutTree::default(), &[1], &[], None, &area, &opts());
        let alvos = retain_tileable_when_maximized(&tree1, &[1, 2], &[2]);
        assert_eq!(alvos, vec![1], "a janela maximizada nova não deve virar folha");
        let tree2 = reconcile(&tree1, &alvos, &[], None, &area, &opts());
        let res = compute_geometry(&tree2, &area, &opts(), &[], &alvos);
        assert_eq!(res.rects.len(), 1);
        assert_eq!(res.rects[0].id, 1, "só a janela não-maximizada ocupa o grid");

        // Ao DESMAXIMIZAR (sem maximizadas), a janela 2 entra rachando a maior folha (a única, 1).
        let alvos2 = retain_tileable_when_maximized(&tree2, &[1, 2], &[]);
        assert_eq!(alvos2, vec![1, 2]);
        let tree3 = reconcile(&tree2, &alvos2, &[], None, &area, &opts());
        let res3 = compute_geometry(&tree3, &area, &opts(), &[], &alvos2);
        assert_eq!(res3.rects.len(), 2);
        assert!(res3.rects.iter().any(|r| r.id == 2));
    }

    #[test]
    fn maximized_existente_preserva_a_folha_e_volta_ao_slot() {
        // 1 e 2 estão no grid (lado a lado). 2 é maximizada temporariamente: como JÁ é folha, deve
        // permanecer nos alvos (slot preservado) e voltar à posição/proporção exatas ao desmaximizar.
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        let antes = compute_geometry(&tree, &area, &opts(), &[], &[1, 2]);
        let r2_antes = antes.rects.iter().find(|r| r.id == 2).unwrap().clone();

        let alvos = retain_tileable_when_maximized(&tree, &[1, 2], &[2]);
        assert_eq!(alvos, vec![1, 2], "janela maximizada que já era folha permanece");

        // Desmaximiza: a árvore não mudou → o retângulo de 2 é idêntico ao de antes.
        let depois = compute_geometry(&tree, &area, &opts(), &[], &[1, 2]);
        let r2_depois = depois.rects.iter().find(|r| r.id == 2).unwrap();
        assert_eq!(&r2_antes, r2_depois);
    }

    #[test]
    fn retain_sem_maximizadas_e_identidade() {
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2, 3], &[], None, &area, &opts());
        assert_eq!(retain_tileable_when_maximized(&tree, &[1, 2, 3], &[]), vec![1, 2, 3]);
    }
}
