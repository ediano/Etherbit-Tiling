// text.rs — carregamento de fonte (runtime) e rasterização de texto por software para os rótulos das
// abas. ADR 0039. Rust puro (`ab_glyph`), sem libs de sistema. A fonte é procurada em caminhos padrão do
// Linux; se nenhuma existir, `load_font` devolve `None` e as abas ficam SEM rótulo (ainda funcionais).
//
// O canvas é o buffer SHM ARGB8888 PRÉ-MULTIPLICADO da superfície. Como o fundo da barra é OPACO
// (alpha = 255), pré-multiplicado == direto, e o texto pode ser composto por cobertura simples.

use ab_glyph::{Font, FontVec, PxScale, ScaleFont};

/// Caminhos comuns de fontes sans em distros Linux (ordem de preferência).
const FONT_CANDIDATES: &[&str] = &[
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/google-noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "/usr/share/fonts/gnu-free/FreeSans.ttf",
];

/// Tenta carregar uma fonte sans do sistema. `None` = nenhuma encontrada (abas sem texto).
pub fn load_font() -> Option<FontVec> {
    for path in FONT_CANDIDATES {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(font) = FontVec::try_from_vec(bytes) {
                return Some(font);
            }
        }
    }
    eprintln!(
        "Etherbit tabs — nenhuma fonte sans encontrada nos caminhos padrão; abas ficarão sem rótulo."
    );
    None
}

/// Compõe um pixel de cor opaca `color` sobre o canvas com cobertura `cov` (0..1), preservando o alfa.
/// Memória ARGB8888 em little-endian = bytes `[B, G, R, A]` (mesma convenção do `overlay::draw`).
fn blend_pixel(canvas: &mut [u8], cw: i32, ch: i32, x: i32, y: i32, color: (u8, u8, u8), cov: f32) {
    if x < 0 || y < 0 || x >= cw || y >= ch {
        return;
    }
    let cov = cov.clamp(0.0, 1.0);
    let idx = ((y * cw + x) * 4) as usize;
    if idx + 3 >= canvas.len() {
        return;
    }
    let (tr, tg, tb) = color;
    let inv = 1.0 - cov;
    canvas[idx] = (canvas[idx] as f32 * inv + tb as f32 * cov) as u8;
    canvas[idx + 1] = (canvas[idx + 1] as f32 * inv + tg as f32 * cov) as u8;
    canvas[idx + 2] = (canvas[idx + 2] as f32 * inv + tr as f32 * cov) as u8;
    // alpha (idx + 3) mantém-se (fundo opaco).
}

/// Desenha um único pixel opaco (usado pelo "x" das abas).
pub fn plot(canvas: &mut [u8], cw: i32, ch: i32, x: i32, y: i32, color: (u8, u8, u8)) {
    blend_pixel(canvas, cw, ch, x, y, color, 1.0);
}

/// Rasteriza `text` no canvas `cw`×`ch`, com a baseline centralizada verticalmente, começando em `x0` e
/// CLIPANDO glifos que ultrapassem `x_max` (sem cortar no meio de um glifo). Cor opaca.
#[allow(clippy::too_many_arguments)]
pub fn draw_text(
    canvas: &mut [u8],
    cw: i32,
    ch: i32,
    font: &FontVec,
    text: &str,
    x0: i32,
    x_max: i32,
    color: (u8, u8, u8),
    font_px: f32,
) {
    if x_max <= x0 || text.is_empty() {
        return;
    }
    let scale = PxScale::from(font_px);
    let scaled = font.as_scaled(scale);
    let line_h = scaled.ascent() - scaled.descent(); // descent é negativo
    let baseline = ((ch as f32 - line_h) / 2.0 + scaled.ascent()).round();
    let mut caret_x = x0 as f32;
    for c in text.chars() {
        if c.is_control() {
            continue;
        }
        let gid = font.glyph_id(c);
        let adv = scaled.h_advance(gid);
        // Clipa por glifo: para antes de desenhar um que ultrapasse a largura útil.
        if caret_x + adv > x_max as f32 {
            break;
        }
        let glyph = gid.with_scale_and_position(scale, ab_glyph::point(caret_x, baseline));
        if let Some(outlined) = font.outline_glyph(glyph) {
            let bb = outlined.px_bounds();
            outlined.draw(|gx, gy, cov| {
                let px = bb.min.x as i32 + gx as i32;
                let py = bb.min.y as i32 + gy as i32;
                blend_pixel(canvas, cw, ch, px, py, color, cov);
            });
        }
        caret_x += adv;
    }
}
