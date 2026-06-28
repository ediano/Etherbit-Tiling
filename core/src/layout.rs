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
                    // Membros presentes neste grupo, na ordem das abas.
                    let present: Vec<u64> =
                        desc.member_ids.iter().copied().filter(|m| ids.contains(m)).collect();
                    if present.is_empty() {
                        continue;
                    }
                    // Faixa da barra no topo (clamp à altura do slot); conteúdo abaixo dela.
                    let bar_h = (opts.tab_bar_height as f64).min(srect.h.max(0.0));
                    let content = PreviewRect {
                        x: round(srect.x),
                        y: round(srect.y + bar_h),
                        width: round(srect.w),
                        height: round((srect.h - bar_h).max(0.0)),
                    };
                    // Aba ativa: a indicada se presente, senão o primeiro membro presente.
                    let active =
                        if present.contains(&desc.active_id) { desc.active_id } else { present[0] };
                    // Só a ativa entra em `rects` (visível, no conteúdo). As inativas a ponte oculta.
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
fn sub_rect_of_target(t: PreviewRect, fx: f64, fy: f64, opts: &LayoutOptions) -> (DropZone, PreviewRect) {
    let gap = opts.inner_gap as f64;
    let (tx, ty, tw, th) = (t.x as f64, t.y as f64, t.width as f64, t.height as f64);
    let half_w = (tw - gap) / 2.0;
    let half_h = (th - gap) / 2.0;

    // Distância do cursor a cada borda da janela-alvo; a menor define o lado.
    let (left, right, top, bottom) = (fx, 1.0 - fx, fy, 1.0 - fy);
    let nearest = left.min(right).min(top).min(bottom);

    if nearest == left {
        (DropZone::Left, PreviewRect { x: round(tx), y: round(ty), width: round(half_w), height: round(th) })
    } else if nearest == right {
        (DropZone::Right, PreviewRect { x: round(tx + half_w + gap), y: round(ty), width: round(half_w), height: round(th) })
    } else if nearest == top {
        (DropZone::Top, PreviewRect { x: round(tx), y: round(ty), width: round(tw), height: round(half_h) })
    } else {
        (DropZone::Bottom, PreviewRect { x: round(tx), y: round(ty + half_h + gap), width: round(tw), height: round(half_h) })
    }
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
}
