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

/// Nó da árvore BSP persistente: uma folha (id de janela / âncora de stack) ou uma divisão binária
/// com `ratio` (fração da PRIMEIRA criança no eixo, `0<ratio<1`).
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Leaf(u64),
    Split { axis: Axis, ratio: f64, first: Box<Node>, second: Box<Node> },
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

        // Área interna: aplica `outer_gap` uma vez ao redor da área útil.
        let outer = opts.outer_gap as f64;
        let inner = Rectf {
            x: area.x as f64 + outer,
            y: area.y as f64 + outer,
            w: area.width as f64 - 2.0 * outer,
            h: area.height as f64 - 2.0 * outer,
        };

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

    LayoutResult { rects, tab_bars }
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
        let w = (rect.w - gap) / 2.0;
        (
            Rectf { x: rect.x, y: rect.y, w, h: rect.h },
            Rectf { x: rect.x + w + gap, y: rect.y, w, h: rect.h },
        )
    } else {
        let h = (rect.h - gap) / 2.0;
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

/// Área interna de um monitor: a área útil menos `outer` em cada borda.
fn inner_rect(area: &WorkArea, outer: f64) -> Rectf {
    Rectf {
        x: area.x as f64 + outer,
        y: area.y as f64 + outer,
        w: area.width as f64 - 2.0 * outer,
        h: area.height as f64 - 2.0 * outer,
    }
}

/// Divide `rect` em duas partes no `axis`, separadas por `gap`, com a PRIMEIRA ocupando `ratio` do
/// espaço útil (após descontar o gap). Generaliza `split_axis` (que é o caso `ratio = 0.5`).
fn split_rect(rect: Rectf, gap: f64, axis: Axis, ratio: f64) -> (Rectf, Rectf) {
    match axis {
        Axis::Horizontal => {
            let avail = (rect.w - gap).max(0.0);
            let w1 = avail * ratio;
            (
                Rectf { x: rect.x, y: rect.y, w: w1, h: rect.h },
                Rectf { x: rect.x + w1 + gap, y: rect.y, w: avail - w1, h: rect.h },
            )
        }
        Axis::Vertical => {
            let avail = (rect.h - gap).max(0.0);
            let h1 = avail * ratio;
            (
                Rectf { x: rect.x, y: rect.y, w: rect.w, h: h1 },
                Rectf { x: rect.x, y: rect.y + h1 + gap, w: rect.w, h: avail - h1 },
            )
        }
    }
}

/// Atribui um `Rectf` a cada folha da árvore, aplicando os ratios e o `gap` em cada costura.
fn geom_leaves(node: &Node, rect: Rectf, gap: f64, out: &mut Vec<(u64, Rectf)>) {
    match node {
        Node::Leaf(id) => out.push((*id, rect)),
        Node::Split { axis, ratio, first, second } => {
            let (a, b) = split_rect(rect, gap, *axis, *ratio);
            geom_leaves(first, a, gap, out);
            geom_leaves(second, b, gap, out);
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

/// O stack cuja ÂNCORA (primeiro membro presente no grupo) é `id`, se houver. É a folha que o stack
/// ocupa na árvore.
fn stack_anchored_at<'a>(
    id: u64,
    stacks: &'a [StackDescriptor],
    group_ids: &[u64],
) -> Option<&'a StackDescriptor> {
    stacks.iter().find(|s| s.member_ids.iter().copied().find(|m| group_ids.contains(m)) == Some(id))
}

/// Calcula a geometria a partir da ÁRVORE persistente (aplicando ratios), integrando stacks (uma
/// folha-âncora vira barra de abas + conteúdo) e os `outer/inner` gaps. Espelha visualmente o
/// `compute_layout_with`, mas guiado pela topologia/proporções da árvore em vez da ordem.
pub fn compute_geometry(
    tree: &LayoutTree,
    area: &WorkArea,
    opts: &LayoutOptions,
    stacks: &[StackDescriptor],
    group_ids: &[u64],
) -> LayoutResult {
    let mut rects = Vec::new();
    let mut tab_bars = Vec::new();
    let root = match &tree.root {
        Some(r) => r,
        None => return LayoutResult { rects, tab_bars },
    };
    let inner = inner_rect(area, opts.outer_gap as f64);
    let mut leaves = Vec::new();
    geom_leaves(root, inner, opts.inner_gap as f64, &mut leaves);
    for (id, r) in leaves {
        if let Some(desc) = stack_anchored_at(id, stacks, group_ids) {
            render_stack(desc, r, group_ids, opts, &mut rects, &mut tab_bars);
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
    LayoutResult { rects, tab_bars }
}

/// `true` se a árvore contém a folha `id`.
fn node_contains(node: &Node, id: u64) -> bool {
    match node {
        Node::Leaf(lid) => *lid == id,
        Node::Split { first, second, .. } => node_contains(first, id) || node_contains(second, id),
    }
}

/// Todos os ids de folha da árvore (ordem de varredura first→second).
fn collect_leaf_ids(tree: &LayoutTree) -> Vec<u64> {
    fn walk(node: &Node, out: &mut Vec<u64>) {
        match node {
            Node::Leaf(id) => out.push(*id),
            Node::Split { first, second, .. } => {
                walk(first, out);
                walk(second, out);
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
            Node::Split { axis, ratio, first, second } => {
                match (walk(*first, id), walk(*second, id)) {
                    (None, None) => None,
                    (Some(n), None) | (None, Some(n)) => Some(n),
                    (Some(a), Some(b)) => {
                        Some(Node::Split { axis, ratio, first: Box::new(a), second: Box::new(b) })
                    }
                }
            }
        }
    }
    LayoutTree { root: tree.root.and_then(|r| walk(r, id)) }
}

/// Racha a folha `target` em duas (ratio 0.5, eixo `axis`): `new_id` fica em `first` se
/// `new_first`, senão em `second`. As demais folhas não se mexem.
fn split_leaf_into(node: Node, target: u64, new_id: u64, axis: Axis, new_first: bool) -> Node {
    match node {
        Node::Leaf(id) if id == target => {
            let (first, second) = if new_first {
                (Node::Leaf(new_id), Node::Leaf(target))
            } else {
                (Node::Leaf(target), Node::Leaf(new_id))
            };
            Node::Split { axis, ratio: 0.5, first: Box::new(first), second: Box::new(second) }
        }
        Node::Leaf(id) => Node::Leaf(id),
        Node::Split { axis: a, ratio, first, second } => Node::Split {
            axis: a,
            ratio,
            first: Box::new(split_leaf_into(*first, target, new_id, axis, new_first)),
            second: Box::new(split_leaf_into(*second, target, new_id, axis, new_first)),
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
    LayoutTree { root: Some(split_leaf_into(root, target, new_id, axis, false)) }
}

/// Move a janela `dragged` para junto de `target`, rachando a folha do alvo no lado da `zone`
/// (`Left/Right` → corte horizontal; `Top/Bottom` → vertical; o arrastado fica do lado indicado).
/// Remove o arrastado de onde estava (o irmão sobe) e o reinsere com ratio 0.5. Zonas que não são
/// um lado (`Center`/`Stack`/`None`/cantos) ou alvo ausente → árvore inalterada (nunca perde janela).
pub fn move_window(tree: &LayoutTree, dragged: u64, target: u64, zone: DropZone) -> LayoutTree {
    if dragged == target {
        return tree.clone();
    }
    let (axis, dragged_first) = match zone {
        DropZone::Left => (Axis::Horizontal, true),
        DropZone::Right => (Axis::Horizontal, false),
        DropZone::Top => (Axis::Vertical, true),
        DropZone::Bottom => (Axis::Vertical, false),
        _ => return tree.clone(),
    };
    // Remove o arrastado; se o alvo não está nesta árvore, desfaz (mantém a árvore original).
    let removed = collapse_leaf(tree.clone(), dragged);
    let root = match removed.root {
        Some(r) if node_contains(&r, target) => r,
        _ => return tree.clone(),
    };
    LayoutTree { root: Some(split_leaf_into(root, target, dragged, axis, dragged_first)) }
}

/// Constrói uma árvore BALANCEADA a partir de `ids` (ordem preservada), aspect-aware e com ratio
/// 0.5 — geometria idêntica ao BSP de `bsp_rects`. Usada no bootstrap (árvore vazia) para um layout
/// inicial simétrico antes de o usuário rearranjar.
fn balanced_node(ids: &[u64], rect: Rectf, gap: f64) -> Option<Node> {
    match ids.len() {
        0 => None,
        1 => Some(Node::Leaf(ids[0])),
        n => {
            let left_count = n.div_ceil(2);
            let axis = if rect.w >= rect.h { Axis::Horizontal } else { Axis::Vertical };
            let (a, b) = split_rect(rect, gap, axis, 0.5);
            let first = balanced_node(&ids[..left_count], a, gap)?;
            let second = balanced_node(&ids[left_count..], b, gap)?;
            Some(Node::Split { axis, ratio: 0.5, first: Box::new(first), second: Box::new(second) })
        }
    }
}

/// Concilia a árvore anterior com o estado atual do grupo:
///  - calcula as folhas-alvo = `current_ids` menos os membros de stack não-âncora (cada stack ocupa
///    uma folha, a do seu primeiro membro presente);
///  - remove (colapsando) as folhas que não são mais alvo;
///  - insere as novas folhas: árvore vazia → BALANCEADA (bootstrap simétrico); árvore existente →
///    cada nova folha racha o nó FOCADO (ou a maior folha), preservando as demais (estabilidade).
/// Determinístico: depende só das entradas.
pub fn reconcile(
    prev: &LayoutTree,
    current_ids: &[u64],
    stacks: &[StackDescriptor],
    focused: Option<u64>,
    area: &WorkArea,
    opts: &LayoutOptions,
) -> LayoutTree {
    // Membros de stack que NÃO são a âncora (primeiro presente) — não viram folha própria.
    let mut non_anchor: Vec<u64> = Vec::new();
    for s in stacks {
        let present: Vec<u64> =
            s.member_ids.iter().copied().filter(|m| current_ids.contains(m)).collect();
        non_anchor.extend(present.into_iter().skip(1));
    }
    let target_leaves: Vec<u64> =
        current_ids.iter().copied().filter(|id| !non_anchor.contains(id)).collect();

    if target_leaves.is_empty() {
        return LayoutTree::default();
    }

    // Bootstrap: sem árvore anterior → layout balanceado (simétrico) a partir das folhas-alvo.
    if prev.root.is_none() {
        let inner = inner_rect(area, opts.outer_gap as f64);
        return LayoutTree { root: balanced_node(&target_leaves, inner, opts.inner_gap as f64) };
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
        return LayoutTree { root: balanced_node(&target_leaves, inner, opts.inner_gap as f64) };
    }

    // Inserções: cada nova folha racha o nó focado (ou a maior), na ordem de `current_ids`.
    for &id in &target_leaves {
        if !tree.root.as_ref().map(|r| node_contains(r, id)).unwrap_or(false) {
            tree = insert_one(tree, id, focused, area, opts);
        }
    }
    tree
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
        Node::Split { axis, ratio, first, second } => {
            let (a, b) = split_rect(rect, gap, *axis, *ratio);
            out.push(Decision { rect, axis: *axis, first: true });
            if find_path(first, id, a, gap, out) {
                return true;
            }
            out.pop();
            out.push(Decision { rect, axis: *axis, first: false });
            if find_path(second, id, b, gap, out) {
                return true;
            }
            out.pop();
            false
        }
    }
}

/// Ajusta (soma `delta`, com clamp) o `ratio` do split alcançado seguindo `path` (sequência de
/// first/second) a partir de `node`. `path` vazio = este nó é o alvo.
fn adjust_ratio(node: Node, path: &[bool], delta: f64) -> Node {
    match node {
        Node::Split { axis, ratio, first, second } => {
            if path.is_empty() {
                let nr = (ratio + delta).clamp(MIN_RATIO, 1.0 - MIN_RATIO);
                Node::Split { axis, ratio: nr, first, second }
            } else if path[0] {
                Node::Split {
                    axis,
                    ratio,
                    first: Box::new(adjust_ratio(*first, &path[1..], delta)),
                    second,
                }
            } else {
                Node::Split {
                    axis,
                    ratio,
                    first,
                    second: Box::new(adjust_ratio(*second, &path[1..], delta)),
                }
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
        }
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
        let moved = move_window(&tree, 3, 1, DropZone::Left);
        let geo = compute_geometry(&moved, &area, &opts(), &[], &[1, 2, 3]);
        assert_eq!(geo.rects.len(), 3);
        let r1 = geo.rects.iter().find(|r| r.id == 1).unwrap();
        let r3 = geo.rects.iter().find(|r| r.id == 3).unwrap();
        // 3 à esquerda de 1 (mesma faixa vertical, x menor).
        assert!(r3.x < r1.x);
        assert_eq!(r3.y, r1.y);
        assert_eq!(r3.height, r1.height);
    }

    #[test]
    fn move_window_noop_for_center_and_missing_target() {
        let area = area_1000x800();
        let tree = reconcile(&LayoutTree::default(), &[1, 2], &[], None, &area, &opts());
        // Center → inalterado.
        assert_eq!(move_window(&tree, 2, 1, DropZone::Center), tree);
        // Alvo ausente → inalterado (não perde a janela arrastada).
        assert_eq!(move_window(&tree, 2, 99, DropZone::Left), tree);
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
}
