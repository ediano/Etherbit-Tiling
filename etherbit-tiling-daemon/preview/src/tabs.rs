// tabs.rs — modelo e hit-testing das barras de abas do KDE (PURO, testável; sem Wayland/SHM). ADR 0039.
//
// O KWin Script publica, via `ShowTabs`, as barras que o core calculou (`TabBarRect`: faixa + membros +
// aba ativa) já em coordenadas absolutas de tela, com o TÍTULO de cada janela (que o daemon de geometria
// não carrega — ADR 0029 — e por isso vem da ponte). Aqui transformamos cada faixa na geometria LOCAL
// (relativa à superfície da barra) dos seus elementos clicáveis — uma "guia" por membro, com o ícone "x"
// de fechar no canto direito — e resolvemos qual elemento um clique do ponteiro atinge.
//
// Os ids (`stack_id`, `member_id`) são OPACOS para o helper: ele só os ecoa de volta nas ações
// (`DrainTabActions`). A ponte usa o `internalId` ESTÁVEL do KWin (string), o que evita o id de
// transporte (u64, reatribuído por sync) ficar obsoleto entre o clique e a drenagem.
//
// Portado do `tabbar.rs` legado (removido no ADR 0028/0029); a matemática não depende de plataforma.

use serde::{Deserialize, Serialize};

/// Uma aba (membro de um stack) como publicada pelo KWin Script.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TabView {
    /// Id opaco da janela (o `internalId` estável do KWin). Ecoado nas ações.
    pub member_id: String,
    /// Título da janela (`win.caption`) para o rótulo. Vazio = sem texto.
    #[serde(default)]
    pub title: String,
    /// `true` na aba visível do grupo.
    #[serde(default)]
    pub active: bool,
}

/// Uma barra de abas como publicada pelo KWin Script: faixa (coords absolutas) + suas abas.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TabBarView {
    /// Id opaco do stack (o `internalId` do 1º membro/âncora). Ecoado nas ações.
    pub stack_id: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub tabs: Vec<TabView>,
}

/// Botão do ponteiro num clique. `Left` ativa/fecha; `Right` desagrupa (menu de contexto do GNOME).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerButton {
    Left,
    Right,
    Other,
}

/// Ação resolvida por um clique do ponteiro sobre uma barra. Os ids são opacos (ecoados à ponte).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TabAction {
    pub stack_id: String,
    pub member_id: String,
    /// `"activate"` | `"close"` | `"ungroup"`.
    pub kind: &'static str,
}

/// Retângulo LOCAL à superfície da barra (origem no canto superior-esquerdo da faixa).
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

/// Uma guia posicionada: id do membro, retângulo da guia inteira, o do "x", título e se é a ativa.
/// Coordenadas LOCAIS à superfície da barra (para desenho e hit-test no espaço da própria superfície).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabSlot {
    pub member_id: String,
    pub tab: Rect,
    pub close: Rect,
    pub title: String,
    pub active: bool,
}

/// Largura (px) do alvo do ícone "x" no canto direito de cada guia.
pub const CLOSE_W: i32 = 24;

/// Constrói os `TabSlot` (geometria LOCAL dos elementos clicáveis) de uma barra. Divide a largura
/// igualmente entre os membros; o "x" ocupa os últimos `CLOSE_W` px de cada guia (clampado em guias mais
/// estreitas). Retorna vazio para barras sem abas ou degeneradas.
pub fn layout_slots(bar: &TabBarView) -> Vec<TabSlot> {
    let n = bar.tabs.len();
    if n == 0 || bar.w <= 0 || bar.h <= 0 {
        return Vec::new();
    }
    let mut slots = Vec::with_capacity(n);
    for (i, t) in bar.tabs.iter().enumerate() {
        // Reparte por bordas inteiras (em coords LOCAIS, 0..w) para não deixar buracos por arredondamento.
        let x0 = (bar.w * i as i32) / n as i32;
        let x1 = (bar.w * (i as i32 + 1)) / n as i32;
        let tab = Rect { x: x0, y: 0, w: x1 - x0, h: bar.h };
        let close_w = CLOSE_W.min(tab.w);
        let close = Rect { x: tab.x + tab.w - close_w, y: 0, w: close_w, h: bar.h };
        slots.push(TabSlot {
            member_id: t.member_id.clone(),
            tab,
            close,
            title: t.title.clone(),
            active: t.active,
        });
    }
    slots
}

/// Resolve a ação de um clique LOCAL `(px, py)` (relativo à superfície da barra `stack_id`) com o
/// `button`. Esquerdo no "x" → `close`; esquerdo na guia → `activate`; direito na guia → `ungroup`;
/// fora de qualquer guia → `None`.
pub fn hit_test_local(
    stack_id: &str,
    slots: &[TabSlot],
    px: i32,
    py: i32,
    button: PointerButton,
) -> Option<TabAction> {
    for slot in slots {
        if !slot.tab.contains(px, py) {
            continue;
        }
        let kind = match button {
            PointerButton::Left => {
                if slot.close.contains(px, py) {
                    "close"
                } else {
                    "activate"
                }
            }
            PointerButton::Right => "ungroup",
            PointerButton::Other => return None,
        };
        return Some(TabAction {
            stack_id: stack_id.to_string(),
            member_id: slot.member_id.clone(),
            kind,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(members: &[(&str, bool)]) -> TabBarView {
        // Faixa de 300x28 em (100, 50), com N abas iguais.
        TabBarView {
            stack_id: members[0].0.to_string(),
            x: 100,
            y: 50,
            w: 300,
            h: 28,
            tabs: members
                .iter()
                .map(|(id, active)| TabView {
                    member_id: id.to_string(),
                    title: String::new(),
                    active: *active,
                })
                .collect(),
        }
    }

    #[test]
    fn layout_divides_width_equally_and_places_close_at_right() {
        let slots = layout_slots(&bar(&[("a", true), ("b", false), ("c", false)]));
        assert_eq!(slots.len(), 3);
        // Abas contíguas em coords LOCAIS, sem buracos, cobrindo toda a largura.
        assert_eq!((slots[0].tab.x, slots[0].tab.w), (0, 100));
        assert_eq!((slots[1].tab.x, slots[1].tab.w), (100, 100));
        assert_eq!((slots[2].tab.x, slots[2].tab.w), (200, 100));
        // "x" nos últimos CLOSE_W px de cada guia.
        assert_eq!(slots[0].close.x, 100 - CLOSE_W);
        assert_eq!(slots[0].close.w, CLOSE_W);
    }

    #[test]
    fn left_click_on_tab_body_activates() {
        let slots = layout_slots(&bar(&[("a", true), ("b", false), ("c", false)]));
        // Centro da 2ª aba (local x ∈ [100,200)), longe do "x".
        let hit = hit_test_local("a", &slots, 130, 10, PointerButton::Left).unwrap();
        assert_eq!(hit.kind, "activate");
        assert_eq!(hit.member_id, "b");
        assert_eq!(hit.stack_id, "a");
    }

    #[test]
    fn left_click_on_close_icon_closes() {
        let slots = layout_slots(&bar(&[("a", true), ("b", false)]));
        // 1ª aba: local x ∈ [0,150); "x" nos últimos 24px (x ∈ [126,150)).
        let hit = hit_test_local("a", &slots, 140, 10, PointerButton::Left).unwrap();
        assert_eq!(hit.kind, "close");
        assert_eq!(hit.member_id, "a");
    }

    #[test]
    fn right_click_ungroups_even_over_close_icon() {
        let slots = layout_slots(&bar(&[("a", true), ("b", false), ("c", false)]));
        let hit = hit_test_local("a", &slots, 290, 10, PointerButton::Right).unwrap();
        assert_eq!(hit.kind, "ungroup");
        assert_eq!(hit.member_id, "c");
    }

    #[test]
    fn other_button_does_nothing() {
        let slots = layout_slots(&bar(&[("a", true), ("b", false), ("c", false)]));
        assert!(hit_test_local("a", &slots, 50, 10, PointerButton::Other).is_none());
    }

    #[test]
    fn click_outside_any_tab_is_none() {
        let slots = layout_slots(&bar(&[("a", true)]));
        // py fora da faixa (h=28).
        assert!(hit_test_local("a", &slots, 50, 100, PointerButton::Left).is_none());
    }

    #[test]
    fn narrow_tab_clamps_close_to_tab_width() {
        let b = TabBarView {
            stack_id: "x".into(),
            x: 0,
            y: 0,
            w: 10,
            h: 20,
            tabs: vec![TabView { member_id: "x".into(), title: String::new(), active: true }],
        };
        let slots = layout_slots(&b);
        let close = slots[0].close;
        assert!(close.w <= 10);
        assert_eq!(close.x + close.w, 10);
    }

    #[test]
    fn empty_or_degenerate_bars_yield_no_slots() {
        let b = TabBarView { stack_id: "x".into(), x: 0, y: 0, w: 0, h: 0, tabs: vec![] };
        assert!(layout_slots(&b).is_empty());
    }

    #[test]
    fn deserializes_showtabs_json() {
        let json = r#"[{"stack_id":"s1","x":1,"y":2,"w":300,"h":28,
            "tabs":[{"member_id":"s1","title":"Firefox","active":true},
                    {"member_id":"w2","title":"Code","active":false}]}]"#;
        let bars: Vec<TabBarView> = serde_json::from_str(json).unwrap();
        assert_eq!(bars.len(), 1);
        assert_eq!(bars[0].tabs.len(), 2);
        assert_eq!(bars[0].tabs[0].title, "Firefox");
        assert!(bars[0].tabs[0].active);
    }

    #[test]
    fn serializes_action_json() {
        let a = TabAction { stack_id: "s1".into(), member_id: "w2".into(), kind: "close" };
        let s = serde_json::to_string(&a).unwrap();
        assert!(s.contains("\"kind\":\"close\""));
        assert!(s.contains("\"member_id\":\"w2\""));
    }
}
