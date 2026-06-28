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

/// Calcula o layout-alvo: agrupa as janelas por `(monitor, workspace)` e distribui cada grupo via
/// divisão binária (BSP) dentro da área útil do seu monitor, aplicando `outer_gap` ao redor e
/// `inner_gap` em cada costura. Preserva a ordem de descoberta das janelas (a ordem é o que torna
/// o rearranjo persistente sem estado no daemon). Janelas cujo monitor não tem área correspondente
/// são ignoradas (não há onde posicioná-las).
///
/// O isolamento por workspace é estrito: grupos de `(monitor, workspace)` distintos nunca
/// interferem entre si.
pub fn compute_layout(
    windows: &[WindowInfo],
    areas: &[WorkArea],
    opts: &LayoutOptions,
) -> Vec<WindowRect> {
    let mut result = Vec::new();

    // Ordem dos grupos `(monitor, workspace)` conforme a primeira janela descoberta em cada um.
    let mut group_order: Vec<(u32, u32)> = Vec::new();
    for w in windows {
        let key = (w.monitor, w.workspace);
        if !group_order.contains(&key) {
            group_order.push(key);
        }
    }

    for (monitor, workspace) in group_order {
        let area = match areas.iter().find(|a| a.index == monitor) {
            Some(a) => a,
            None => continue, // sem área útil conhecida para este monitor → não posiciona
        };
        let ids: Vec<u64> = windows
            .iter()
            .filter(|w| w.monitor == monitor && w.workspace == workspace)
            .map(|w| w.id)
            .collect();

        // Área interna: aplica `outer_gap` uma vez ao redor da área útil.
        let outer = opts.outer_gap as f64;
        let inner = Rectf {
            x: area.x as f64 + outer,
            y: area.y as f64 + outer,
            w: area.width as f64 - 2.0 * outer,
            h: area.height as f64 - 2.0 * outer,
        };

        for (id, rect) in bsp(inner, &ids, opts.inner_gap as f64) {
            result.push(WindowRect {
                id,
                x: round(rect.x),
                y: round(rect.y),
                width: round(rect.w),
                height: round(rect.h),
            });
        }
    }

    result
}

/// Divisão binária recursiva: "racha" `rect` ao meio pelo lado MAIOR, distribuindo a primeira
/// metade das janelas (em ordem) à primeira subárea e o restante à segunda, deixando `inner_gap`
/// na costura. Convergência garantida: cada passo reduz a contagem; folhas (1 janela) ocupam o
/// retângulo inteiro. Não há sobreposição porque as subáreas são disjuntas (separadas pelo gap).
fn bsp(rect: Rectf, ids: &[u64], inner_gap: f64) -> Vec<(u64, Rectf)> {
    match ids.len() {
        0 => Vec::new(),
        1 => vec![(ids[0], rect)],
        n => {
            let left_count = n.div_ceil(2);
            let (left_ids, right_ids) = ids.split_at(left_count);
            let (a, b) = if rect.w >= rect.h {
                split_axis(rect, inner_gap, true)
            } else {
                split_axis(rect, inner_gap, false)
            };
            let mut out = bsp(a, left_ids, inner_gap);
            out.extend(bsp(b, right_ids, inner_gap));
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
        DropZone::None => (0.0, 0.0, 0.0, 0.0),
    };

    PreviewRect { x: round(x), y: round(y), width: round(w), height: round(h) }
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
        assert!(compute_layout(&[], &[area_1000x800()], &opts).is_empty());
    }

    #[test]
    fn layout_single_window_fills_inner_area() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
        let rects = compute_layout(&[win(7, 0)], &[area_1000x800()], &opts);
        assert_eq!(rects, vec![WindowRect { id: 7, x: 12, y: 12, width: 976, height: 776 }]);
    }

    #[test]
    fn layout_two_windows_split_into_halves() {
        // 2 janelas numa área mais larga que alta → split vertical (lado a lado): metades iguais.
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
        // janela no monitor 5, mas só conhecemos a área do monitor 0
        let rects = compute_layout(&[win(1, 5)], &[area_1000x800()], &opts);
        assert!(rects.is_empty());
    }

    // ---- Drop zones ----

    #[test]
    fn drop_zone_left_and_right_halves() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
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
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
        let area = area_1000x800();
        // Fora das bordas e fora do centro → escolhe a metade horizontal mais próxima.
        assert_eq!(detect_drop_zone(&area, 250, 400, &opts).zone, DropZone::Left);
        assert_eq!(detect_drop_zone(&area, 750, 400, &opts).zone, DropZone::Right);
    }

    #[test]
    fn drop_zone_outside_area_is_none() {
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
        let area = area_1000x800();
        let out = detect_drop_zone(&area, -5, 400, &opts);
        assert_eq!(out.zone, DropZone::None);
        assert_eq!(out.rect, PreviewRect { x: 0, y: 0, width: 0, height: 0 });
        assert_eq!(detect_drop_zone(&area, 1005, 400, &opts).zone, DropZone::None);
    }

    #[test]
    fn drop_zone_respects_monitor_offset() {
        // Monitor à direita (x=1000): ponto perto da borda esquerda DAQUELE monitor → Left local.
        let opts = LayoutOptions { inner_gap: 8, outer_gap: 12 };
        let area = WorkArea { index: 1, x: 1000, y: 0, width: 1000, height: 800 };
        let left = detect_drop_zone(&area, 1020, 400, &opts);
        assert_eq!(left.zone, DropZone::Left);
        assert_eq!(left.rect, PreviewRect { x: 1012, y: 12, width: 484, height: 776 });
    }
}
