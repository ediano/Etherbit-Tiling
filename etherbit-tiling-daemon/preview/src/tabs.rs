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

/// Botão do ponteiro num clique. `Left` ativa/fecha; `Right` abre o **menu de contexto** da guia
/// (ADR 0040), de onde o "Desagrupar" é confirmado por clique esquerdo.
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
    /// `"activate"` | `"close"` | `"ungroup"` | `"ungroup_drag"`.
    pub kind: &'static str,
    /// Coordenadas GLOBAIS de soltura, só para `"ungroup_drag"` (drag-to-ungroup, ADR 0042); `0,0` nas
    /// demais. A ponte resolve a zona de drop nesse ponto e reposiciona a janela ejetada ("cai onde foi
    /// solta"). `#[serde(default)]` mantém retrocompat do JSON drenado.
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
}

impl TabAction {
    /// Ação simples (sem coordenadas) — `activate`/`close`/`ungroup`.
    pub fn simple(stack_id: String, member_id: String, kind: &'static str) -> Self {
        TabAction { stack_id, member_id, kind, x: 0, y: 0 }
    }

    /// Ejeção por arraste (ADR 0042): a janela `member_id` sai do stack e é reposicionada na zona de
    /// drop resolvida em `(x, y)` (coordenadas globais de tela).
    pub fn ungroup_drag(stack_id: String, member_id: String, x: i32, y: i32) -> Self {
        TabAction { stack_id, member_id, kind: "ungroup_drag", x, y }
    }
}

/// Resultado de um clique sobre uma barra de abas (ADR 0040). O clique esquerdo resolve em uma `Action`
/// imediata (ativar/fechar); o clique direito não age na hora — pede para **abrir o menu de contexto**
/// da guia (que confirma o "Desagrupar" por clique esquerdo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BarHit {
    Action(TabAction),
    OpenContextMenu { stack_id: String, member_id: String },
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

/// Resolve o que um clique LOCAL `(px, py)` (relativo à superfície da barra `stack_id`) com o `button`
/// faz. Esquerdo no "x" → `Action(close)`; esquerdo na guia → `Action(activate)`; direito na guia →
/// `OpenContextMenu` (NÃO desagrupa direto — ADR 0040); fora de qualquer guia → `None`.
pub fn hit_test_local(
    stack_id: &str,
    slots: &[TabSlot],
    px: i32,
    py: i32,
    button: PointerButton,
) -> Option<BarHit> {
    for slot in slots {
        if !slot.tab.contains(px, py) {
            continue;
        }
        return match button {
            PointerButton::Left => {
                let kind = if slot.close.contains(px, py) { "close" } else { "activate" };
                Some(BarHit::Action(TabAction::simple(
                    stack_id.to_string(),
                    slot.member_id.clone(),
                    kind,
                )))
            }
            PointerButton::Right => Some(BarHit::OpenContextMenu {
                stack_id: stack_id.to_string(),
                member_id: slot.member_id.clone(),
            }),
            PointerButton::Other => None,
        };
    }
    None
}

/// Rótulo do item "Desagrupar" do menu de contexto. PT-only na v1 (o helper ainda não tem i18n — ADR
/// 0040). O item ejeta a janela do stack, devolvendo-a ao grid cíclico.
pub const UNGROUP_LABEL: &str = "Desagrupar";

/// Largura (px) do menu de contexto da guia.
pub const MENU_W: i32 = 160;
/// Altura (px) de cada item do menu.
pub const MENU_ITEM_H: i32 = 28;
/// Recuo horizontal (px) do rótulo dentro do item.
pub const MENU_PAD_X: i32 = 10;

/// Um item do menu de contexto: rótulo a desenhar e o `kind` da `TabAction` que ele dispara.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItem {
    pub label: String,
    /// `kind` ecoado na `TabAction` (hoje só `"ungroup"`).
    pub kind: &'static str,
}

/// Modelo (puro) do menu de contexto de uma guia: para qual `(stack_id, member_id)` ele age e seus
/// itens. Coordenadas/desenho ficam no overlay; aqui só o conteúdo e o hit-test (testáveis sem Wayland).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuModel {
    pub stack_id: String,
    pub member_id: String,
    pub items: Vec<MenuItem>,
}

impl MenuModel {
    /// Menu padrão de uma guia: um único item "Desagrupar".
    pub fn for_tab(stack_id: &str, member_id: &str) -> Self {
        MenuModel {
            stack_id: stack_id.to_string(),
            member_id: member_id.to_string(),
            items: vec![MenuItem { label: UNGROUP_LABEL.to_string(), kind: "ungroup" }],
        }
    }
}

/// Tamanho (largura, altura) da superfície do menu: largura fixa, altura = nº de itens × `MENU_ITEM_H`.
pub fn menu_size(model: &MenuModel) -> (i32, i32) {
    (MENU_W, MENU_ITEM_H * model.items.len() as i32)
}

/// Resolve um clique LOCAL `(px, py)` (relativo à superfície do menu) sobre um item: devolve a
/// `TabAction` correspondente (com `stack_id`/`member_id` do menu); fora de qualquer item → `None`
/// (o chamador trata como dismiss). Os itens são empilhados verticalmente, cada um com `MENU_ITEM_H`.
pub fn menu_hit_test(model: &MenuModel, px: i32, py: i32) -> Option<TabAction> {
    let (w, h) = menu_size(model);
    if px < 0 || px >= w || py < 0 || py >= h {
        return None;
    }
    let idx = (py / MENU_ITEM_H) as usize;
    let item = model.items.get(idx)?;
    Some(TabAction::simple(model.stack_id.clone(), model.member_id.clone(), item.kind))
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

    fn action(hit: BarHit) -> TabAction {
        match hit {
            BarHit::Action(a) => a,
            other => panic!("esperava BarHit::Action, veio {other:?}"),
        }
    }

    #[test]
    fn left_click_on_tab_body_activates() {
        let slots = layout_slots(&bar(&[("a", true), ("b", false), ("c", false)]));
        // Centro da 2ª aba (local x ∈ [100,200)), longe do "x".
        let hit = action(hit_test_local("a", &slots, 130, 10, PointerButton::Left).unwrap());
        assert_eq!(hit.kind, "activate");
        assert_eq!(hit.member_id, "b");
        assert_eq!(hit.stack_id, "a");
    }

    #[test]
    fn left_click_on_close_icon_closes() {
        let slots = layout_slots(&bar(&[("a", true), ("b", false)]));
        // 1ª aba: local x ∈ [0,150); "x" nos últimos 24px (x ∈ [126,150)).
        let hit = action(hit_test_local("a", &slots, 140, 10, PointerButton::Left).unwrap());
        assert_eq!(hit.kind, "close");
        assert_eq!(hit.member_id, "a");
    }

    #[test]
    fn right_click_opens_context_menu_even_over_close_icon() {
        // ADR 0040: o clique direito NÃO desagrupa direto — pede para abrir o menu de contexto da guia.
        let slots = layout_slots(&bar(&[("a", true), ("b", false), ("c", false)]));
        let hit = hit_test_local("a", &slots, 290, 10, PointerButton::Right).unwrap();
        assert_eq!(
            hit,
            BarHit::OpenContextMenu { stack_id: "a".to_string(), member_id: "c".to_string() }
        );
    }

    #[test]
    fn menu_size_matches_item_count() {
        let model = MenuModel::for_tab("a", "c");
        assert_eq!(model.items.len(), 1, "menu padrão tem só o 'Desagrupar'");
        assert_eq!(menu_size(&model), (MENU_W, MENU_ITEM_H));
    }

    #[test]
    fn menu_hit_test_on_item_returns_ungroup() {
        // Clique LOCAL sobre o único item → TabAction de ungroup com o (stack_id, member_id) do menu.
        let model = MenuModel::for_tab("a", "c");
        let action = menu_hit_test(&model, MENU_PAD_X, MENU_ITEM_H / 2).unwrap();
        assert_eq!(action.kind, "ungroup");
        assert_eq!(action.member_id, "c");
        assert_eq!(action.stack_id, "a");
    }

    #[test]
    fn menu_hit_test_outside_item_is_none() {
        // Fora dos limites da superfície do menu → None (o chamador trata como dismiss).
        let model = MenuModel::for_tab("a", "c");
        assert!(
            menu_hit_test(&model, MENU_PAD_X, MENU_ITEM_H + 1).is_none(),
            "abaixo do único item"
        );
        assert!(
            menu_hit_test(&model, MENU_W + 1, MENU_ITEM_H / 2).is_none(),
            "à direita da superfície"
        );
        assert!(menu_hit_test(&model, -1, MENU_ITEM_H / 2).is_none(), "à esquerda da superfície");
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
        let a = TabAction::simple("s1".into(), "w2".into(), "close");
        let s = serde_json::to_string(&a).unwrap();
        assert!(s.contains("\"kind\":\"close\""));
        assert!(s.contains("\"member_id\":\"w2\""));
    }

    #[test]
    fn serializes_ungroup_drag_with_coords() {
        // ADR 0042: a ejeção por arraste carrega as coordenadas globais de soltura para a ponte
        // resolver a zona de drop ("cai onde foi solta").
        let a = TabAction::ungroup_drag("s1".into(), "w2".into(), 640, 360);
        let s = serde_json::to_string(&a).unwrap();
        assert!(s.contains("\"kind\":\"ungroup_drag\""));
        assert!(s.contains("\"x\":640"));
        assert!(s.contains("\"y\":360"));
    }
}
