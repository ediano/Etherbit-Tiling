// tabbar.rs — modelo e hit-testing da barra de abas (PURO, testável; sem wgpu/Wayland).
//
// O core devolve `TabBarRect` (faixa + membros + aba ativa) em coordenadas absolutas de tela. Aqui
// transformamos cada faixa na geometria dos seus elementos clicáveis — uma "guia" por membro, e o
// ícone "x" de fechar no canto direito de cada guia — e resolvemos qual elemento um clique do ponteiro
// atinge. É a entrada da barra interativa renderizada com wgpu no daemon (KDE) e a base reaproveitável
// para a futura porta macOS (a matemática não depende de plataforma).
//
// Ver ADR 0016/0018/0022: sob KWin (que suporta wlr-layer-shell) o daemon desenha a barra em SUA
// PRÓPRIA superfície de overlay — não é overlay sobre janelas alheias. O GNOME segue desenhando a
// barra na extensão (Mutter não tem layer-shell).
//
// A API (layout/hit-testing) é consumida pelo overlay wgpu (`layer.rs`, sessão KWin) e pelos testes
// abaixo; num build headless parte aparece como "não usada" — fundação aguardando o bind de hardware.
#![allow(dead_code)]

/// Retângulo em coordenadas absolutas de tela (px).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    /// `true` se o ponto `(px, py)` está dentro do retângulo (borda esquerda/topo inclusiva).
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// Botão do ponteiro num clique. `Left` ativa/fecha; `Right` abre o menu de contexto (Desagrupar).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    Left,
    Right,
    Other,
}

/// Faixa de barra vinda do core (espelha `TabBarRect`, já em coords absolutas).
#[derive(Debug, Clone, PartialEq)]
pub struct BarInput {
    pub stack_id: u64,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// Membros na ordem das abas (esquerda→direita).
    pub members: Vec<u64>,
    pub active: u64,
}

/// Uma guia (aba) posicionada: o id da janela, o retângulo da guia inteira e o do ícone "x".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TabSlot {
    pub member_id: u64,
    pub tab: Rect,
    pub close: Rect,
}

/// Uma barra de abas com a geometria de todos os seus elementos clicáveis.
#[derive(Debug, Clone, PartialEq)]
pub struct TabBar {
    pub stack_id: u64,
    pub bar: Rect,
    pub slots: Vec<TabSlot>,
    pub active_id: u64,
}

/// Ação resolvida por um clique do ponteiro sobre as barras.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabHit {
    /// Clique esquerdo na guia (fora do "x") → ativar aquela aba.
    Activate(u64),
    /// Clique esquerdo no "x" → fechar o app daquela janela.
    Close(u64),
    /// Clique direito na guia → menu de contexto "Desagrupar Janela".
    Context(u64),
    /// Clique fora de qualquer barra.
    None,
}

/// Largura (px) do alvo do ícone "x" no canto direito de cada guia.
pub const CLOSE_W: i32 = 24;

/// Constrói as `TabBar` (geometria dos elementos clicáveis) a partir das faixas do core. Divide a
/// largura da faixa igualmente entre os membros; o "x" ocupa os últimos `CLOSE_W` px de cada guia
/// (clampado para guias mais estreitas que isso). Barras sem membros são ignoradas.
pub fn layout_bars(bars: &[BarInput]) -> Vec<TabBar> {
    let mut out = Vec::new();
    for b in bars {
        let n = b.members.len();
        if n == 0 || b.w <= 0 || b.h <= 0 {
            continue;
        }
        let mut slots = Vec::with_capacity(n);
        for (i, &member_id) in b.members.iter().enumerate() {
            // Reparte por bordas inteiras para não deixar buracos por arredondamento.
            let x0 = b.x + (b.w * i as i32) / n as i32;
            let x1 = b.x + (b.w * (i as i32 + 1)) / n as i32;
            let tab = Rect { x: x0, y: b.y, w: x1 - x0, h: b.h };
            let close_w = CLOSE_W.min(tab.w);
            let close = Rect { x: tab.x + tab.w - close_w, y: tab.y, w: close_w, h: tab.h };
            slots.push(TabSlot { member_id, tab, close });
        }
        out.push(TabBar {
            stack_id: b.stack_id,
            bar: Rect { x: b.x, y: b.y, w: b.w, h: b.h },
            slots,
            active_id: b.active,
        });
    }
    out
}

/// Resolve a ação de um clique `(px, py)` com o `button` sobre as barras. Esquerdo no "x" → `Close`;
/// esquerdo na guia → `Activate`; direito na guia → `Context`; fora de tudo → `None`. A primeira barra
/// que contém o ponto vence (as barras não se sobrepõem no layout do core).
pub fn hit_test(bars: &[TabBar], px: i32, py: i32, button: PointerButton) -> TabHit {
    for bar in bars {
        if !bar.bar.contains(px, py) {
            continue;
        }
        for slot in &bar.slots {
            if !slot.tab.contains(px, py) {
                continue;
            }
            return match button {
                PointerButton::Left => {
                    if slot.close.contains(px, py) {
                        TabHit::Close(slot.member_id)
                    } else {
                        TabHit::Activate(slot.member_id)
                    }
                }
                PointerButton::Right => TabHit::Context(slot.member_id),
                PointerButton::Other => TabHit::None,
            };
        }
        // Dentro da faixa mas fora de qualquer guia (folga de arredondamento): nada a fazer.
        return TabHit::None;
    }
    TabHit::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(members: Vec<u64>, active: u64) -> BarInput {
        // Faixa de 300x28 em (100, 50), com 3 abas de 100px cada.
        BarInput { stack_id: members[0], x: 100, y: 50, w: 300, h: 28, members, active }
    }

    #[test]
    fn layout_divides_width_equally_and_places_close_at_right() {
        let bars = layout_bars(&[bar(vec![1, 2, 3], 1)]);
        assert_eq!(bars.len(), 1);
        let slots = &bars[0].slots;
        assert_eq!(slots.len(), 3);
        // Abas contíguas, sem buracos, cobrindo toda a faixa.
        assert_eq!((slots[0].tab.x, slots[0].tab.w), (100, 100));
        assert_eq!((slots[1].tab.x, slots[1].tab.w), (200, 100));
        assert_eq!((slots[2].tab.x, slots[2].tab.w), (300, 100));
        // "x" nos últimos CLOSE_W px de cada guia.
        assert_eq!(slots[0].close.x, 100 + 100 - CLOSE_W);
        assert_eq!(slots[0].close.w, CLOSE_W);
    }

    #[test]
    fn left_click_on_tab_body_activates() {
        let bars = layout_bars(&[bar(vec![1, 2, 3], 1)]);
        // Centro da 2ª aba, longe do "x".
        assert_eq!(hit_test(&bars, 230, 60, PointerButton::Left), TabHit::Activate(2));
    }

    #[test]
    fn left_click_on_close_icon_closes() {
        let bars = layout_bars(&[bar(vec![1, 2, 3], 1)]);
        // Dentro do "x" da 1ª aba (últimos CLOSE_W px: x ∈ [176, 200)).
        assert_eq!(hit_test(&bars, 190, 60, PointerButton::Left), TabHit::Close(1));
    }

    #[test]
    fn right_click_opens_context_even_over_close_icon() {
        let bars = layout_bars(&[bar(vec![1, 2, 3], 1)]);
        assert_eq!(hit_test(&bars, 190, 60, PointerButton::Right), TabHit::Context(1));
        assert_eq!(hit_test(&bars, 230, 60, PointerButton::Right), TabHit::Context(2));
    }

    #[test]
    fn other_button_does_nothing() {
        let bars = layout_bars(&[bar(vec![1, 2, 3], 1)]);
        assert_eq!(hit_test(&bars, 150, 60, PointerButton::Other), TabHit::None);
    }

    #[test]
    fn click_outside_any_bar_is_none() {
        let bars = layout_bars(&[bar(vec![1, 2, 3], 1)]);
        assert_eq!(hit_test(&bars, 10, 10, PointerButton::Left), TabHit::None);
        assert_eq!(hit_test(&bars, 250, 200, PointerButton::Left), TabHit::None);
    }

    #[test]
    fn narrow_tab_clamps_close_to_tab_width() {
        // Faixa de 30px com 1 aba estreita: o "x" não pode exceder a guia.
        let bars = layout_bars(&[BarInput {
            stack_id: 7,
            x: 0,
            y: 0,
            w: 10,
            h: 20,
            members: vec![7],
            active: 7,
        }]);
        let close = bars[0].slots[0].close;
        assert!(close.w <= 10);
        assert_eq!(close.x + close.w, 10);
    }

    #[test]
    fn empty_or_degenerate_bars_are_skipped() {
        assert!(layout_bars(&[BarInput {
            stack_id: 1,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            members: vec![],
            active: 0,
        }])
        .is_empty());
    }
}
