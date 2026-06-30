// overlay.rs — superfícies de overlay (wlr-layer-shell) do helper KDE. ADR 0029/0031/0039.
//
// Dois papéis num único cliente Wayland:
//   1) PREVIEW translúcido do drag — UMA `LayerSurface` preenchida via SHM com a cor de realce (alpha
//      0.3–0.4). Reposiciona REUSANDO a superfície (sem churn por passo do arrasto). Input region VAZIA
//      (click-through). [ADR 0029/0031]
//   2) BARRAS DE ABAS clicáveis — UMA `LayerSurface` OPACA por grupo, desenhada com SHM + texto
//      (`text`), ancorada na geometria que o core calculou. Recebe o ponteiro: cada clique vira uma
//      `TabAction` na fila e ACORDA o KWin Script (via `wake_tx` → `invokeShortcut`). [ADR 0039]
//
// O estado (preview + barras) chega por um canal `watch`; a fila de ações sai por um `Arc<Mutex<…>>`
// compartilhado com a interface D-Bus `Tabs` (drenado em `DrainTabActions`).
//
// `run` é o ÚNICO ponto dependente de uma sessão Wayland real com `wlr-layer-shell` (KWin): fora dela
// (Mutter/headless/CI) o bind falha e ele encerra GRACIOSO (sem erro) — o serviço D-Bus segue vivo.

// Parte da API de handlers aparece como "não usada" em análise estática (fundação de hardware).
#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;

use ab_glyph::FontVec;

use smithay_client_toolkit::reexports::calloop::EventLoop;
use smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::reexports::client::{
    globals::registry_queue_init,
    protocol::{wl_output, wl_pointer, wl_seat, wl_shm, wl_surface},
    Connection, Proxy, QueueHandle,
};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState, Region},
    delegate_compositor, delegate_layer, delegate_output, delegate_pointer, delegate_registry,
    delegate_seat, delegate_shm,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        pointer::{PointerEvent, PointerEventKind, PointerHandler},
        Capability, SeatHandler, SeatState,
    },
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
    shm::{slot::SlotPool, Shm, ShmHandler},
};

use crate::tabs::{
    hit_test_local, layout_slots, menu_hit_test, menu_size, BarHit, MenuModel, PointerButton,
    TabAction, TabBarView, TabSlot, MENU_ITEM_H, MENU_PAD_X,
};
use crate::text;

/// Retângulo físico do preview (coordenadas globais do compositor).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PreviewRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Estado completo do overlay: o preview (drag) e as barras de abas. Os dois coexistem.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct OverlayState {
    pub preview: Option<PreviewRect>,
    pub bars: Vec<TabBarView>,
}

/// Cor de realce do PREVIEW (Nord `#5e81ac`) e opacidade (ADR: 0.3–0.4 → 0.35).
const FILL_R: u32 = 0x5e;
const FILL_G: u32 = 0x81;
const FILL_B: u32 = 0xac;
const FILL_ALPHA: f32 = 0.35;

/// Paleta Nord das ABAS (opaca), espelhando o GNOME (`_makeTabButton`).
const BAR_BG: (u8, u8, u8) = (0x2e, 0x34, 0x40); // fundo da faixa
const TAB_ACTIVE_BG: (u8, u8, u8) = (0x5e, 0x81, 0xac); // realce da aba visível
const TEXT_ACTIVE: (u8, u8, u8) = (0xec, 0xef, 0xf4); // título da aba ativa
const TEXT_INACTIVE: (u8, u8, u8) = (0xd8, 0xde, 0xe9); // título da aba inativa
const TAB_PAD_X: i32 = 8; // recuo do texto na guia

/// Botões do ponteiro (códigos do Linux input).
const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;

/// Uma superfície de barra de abas viva: o stack que representa, a `LayerSurface` e o layout atual.
struct TabSurface {
    stack_id: String,
    layer: LayerSurface,
    view: TabBarView,
    slots: Vec<TabSlot>,
}

/// A superfície do menu de contexto da guia (ADR 0040): a `LayerSurface`, o modelo (para qual
/// `(stack_id, member_id)` age e seus itens) e o tamanho desenhado.
struct MenuSurface {
    layer: LayerSurface,
    model: MenuModel,
    w: i32,
    h: i32,
}

struct App {
    registry_state: RegistryState,
    output_state: OutputState,
    seat_state: SeatState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    shm: Shm,
    qh: QueueHandle<App>,
    pool: SlotPool,
    font: Option<FontVec>,
    /// Superfície do PREVIEW (None = preview escondido).
    layer: Option<LayerSurface>,
    rect: Option<PreviewRect>,
    /// Superfícies das BARRAS DE ABAS (uma por grupo).
    tab_surfaces: Vec<TabSurface>,
    /// Menu de contexto aberto (no máximo um por vez). `None` = nenhum menu aberto. ADR 0040.
    menu: Option<MenuSurface>,
    pointer: Option<wl_pointer::WlPointer>,
    /// Fila de ações (clique) drenada pela interface D-Bus `Tabs`.
    actions: Arc<Mutex<Vec<TabAction>>>,
    /// Acorda o KWin Script (via `invokeShortcut`) após enfileirar uma ação.
    wake_tx: UnboundedSender<()>,
    exit: bool,
}

impl App {
    // ---- PREVIEW (papel 1) -------------------------------------------------------------------

    /// Cria/reposiciona (Some) ou esconde (None) a superfície translúcida do preview.
    fn apply_preview(&mut self, next: Option<PreviewRect>) {
        match next {
            Some(r) if r.width > 0 && r.height > 0 => {
                self.rect = Some(r);
                if self.layer.is_some() {
                    if let Some(layer) = self.layer.as_ref() {
                        layer.set_size(r.width as u32, r.height as u32);
                        layer.set_margin(r.y, 0, 0, r.x);
                        layer.commit();
                    }
                    self.draw_preview(r.width as u32, r.height as u32);
                } else {
                    let surface = self.compositor.create_surface(&self.qh);
                    let layer = self.layer_shell.create_layer_surface(
                        &self.qh,
                        surface,
                        Layer::Overlay,
                        Some("etherbit-preview"),
                        None,
                    );
                    layer.set_anchor(Anchor::TOP | Anchor::LEFT);
                    layer.set_size(r.width as u32, r.height as u32);
                    layer.set_margin(r.y, 0, 0, r.x);
                    layer.set_keyboard_interactivity(KeyboardInteractivity::None);
                    layer.set_exclusive_zone(-1);
                    // Input region VAZIA: o preview é click-through (nunca rouba o ponteiro do drag).
                    if let Ok(region) = Region::new(&self.compositor) {
                        layer.wl_surface().set_input_region(Some(region.wl_region()));
                    }
                    layer.commit();
                    self.layer = Some(layer);
                }
            }
            _ => {
                self.layer = None;
                self.rect = None;
            }
        }
    }

    /// Preenche o preview com o retângulo translúcido (SHM, alfa pré-multiplicado).
    fn draw_preview(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 || self.layer.is_none() {
            return;
        }
        let stride = w as i32 * 4;
        let (buffer, canvas) =
            match self.pool.create_buffer(w as i32, h as i32, stride, wl_shm::Format::Argb8888) {
                Ok(pair) => pair,
                Err(err) => {
                    eprintln!("Etherbit preview — create_buffer falhou: {err}");
                    return;
                }
            };
        let a = (FILL_ALPHA.clamp(0.0, 1.0) * 255.0) as u32;
        let pr = FILL_R * a / 255;
        let pg = FILL_G * a / 255;
        let pb = FILL_B * a / 255;
        let pixel: u32 = (a << 24) | (pr << 16) | (pg << 8) | pb;
        {
            let bytes = pixel.to_ne_bytes();
            for chunk in canvas.chunks_exact_mut(4) {
                chunk.copy_from_slice(&bytes);
            }
        }
        if let Some(layer) = self.layer.as_ref() {
            let surface = layer.wl_surface();
            if let Err(err) = buffer.attach_to(surface) {
                eprintln!("Etherbit preview — attach buffer falhou: {err}");
                return;
            }
            surface.damage_buffer(0, 0, w as i32, h as i32);
            surface.commit();
        }
    }

    // ---- BARRAS DE ABAS (papel 2) ------------------------------------------------------------

    /// Reconcilia as superfícies das barras com o estado novo: cria as que faltam, atualiza as
    /// existentes (reposiciona + redesenha) e DESTRÓI (drop) as de stacks que sumiram — sem vazamento.
    fn apply_bars(&mut self, bars: &[TabBarView]) {
        // Remove superfícies de stacks ausentes/degenerados (o drop desmonta a surface no compositor).
        self.tab_surfaces.retain(|ts| {
            bars.iter()
                .any(|b| b.stack_id == ts.stack_id && b.w > 0 && b.h > 0 && !b.tabs.is_empty())
        });
        for b in bars {
            if b.w <= 0 || b.h <= 0 || b.tabs.is_empty() {
                continue;
            }
            let slots = layout_slots(b);
            if let Some(i) = self.tab_surfaces.iter().position(|ts| ts.stack_id == b.stack_id) {
                let size_changed =
                    self.tab_surfaces[i].view.w != b.w || self.tab_surfaces[i].view.h != b.h;
                self.tab_surfaces[i].view = b.clone();
                self.tab_surfaces[i].slots = slots;
                self.tab_surfaces[i].layer.set_size(b.w as u32, b.h as u32);
                self.tab_surfaces[i].layer.set_margin(b.y, 0, 0, b.x);
                self.tab_surfaces[i].layer.commit();
                // Tamanho MUDOU → o compositor manda `configure` e desenhamos lá (o buffer casa o tamanho
                // já "acked", sem erro de protocolo). Tamanho igual (só conteúdo/título/ativa ou reposição)
                // → redesenha já (nenhum `configure` virá).
                if !size_changed {
                    draw_bar(&mut self.pool, self.font.as_ref(), &self.tab_surfaces[i]);
                }
            } else {
                let surface = self.compositor.create_surface(&self.qh);
                let layer = self.layer_shell.create_layer_surface(
                    &self.qh,
                    surface,
                    Layer::Overlay,
                    Some("etherbit-tabs"),
                    None,
                );
                layer.set_anchor(Anchor::TOP | Anchor::LEFT);
                layer.set_size(b.w as u32, b.h as u32);
                layer.set_margin(b.y, 0, 0, b.x);
                layer.set_keyboard_interactivity(KeyboardInteractivity::None);
                layer.set_exclusive_zone(-1);
                // Input region PADRÃO (toda a superfície) → recebe os cliques. Primeiro draw no configure.
                layer.commit();
                self.tab_surfaces.push(TabSurface {
                    stack_id: b.stack_id.clone(),
                    layer,
                    view: b.clone(),
                    slots,
                });
            }
        }
        // Se o menu aberto referencia uma guia que sumiu (stack dissolvido ou membro removido), fecha-o
        // para não apontar para nada (ADR 0040).
        if let Some(menu) = self.menu.as_ref() {
            let still = bars.iter().any(|b| {
                b.stack_id == menu.model.stack_id
                    && b.tabs.iter().any(|t| t.member_id == menu.model.member_id)
            });
            if !still {
                self.close_menu();
            }
        }
    }

    /// Enfileira uma `TabAction` e acorda o KWin Script (drena via `DrainTabActions`). Best-effort.
    fn enqueue_action(&self, action: TabAction) {
        if let Ok(mut q) = self.actions.lock() {
            q.push(action);
        }
        let _ = self.wake_tx.send(());
    }

    /// Resolve um clique do ponteiro. Prioridade (ADR 0040): se há menu de contexto aberto, o clique o
    /// resolve (item → ungroup) ou o descarta (dismiss); só então os cliques nas barras são roteados —
    /// esquerdo ativa/fecha, direito ABRE o menu de contexto da guia.
    fn on_pointer_press(&mut self, surface: &wl_surface::WlSurface, pos: (f64, f64), button: u32) {
        let pb = match button {
            BTN_LEFT => PointerButton::Left,
            BTN_RIGHT => PointerButton::Right,
            _ => PointerButton::Other,
        };
        let px = pos.0 as i32;
        let py = pos.1 as i32;

        // 1) Menu aberto tem prioridade: um único clique resolve o item OU descarta o menu.
        if let Some(menu) = self.menu.as_ref() {
            if menu.layer.wl_surface() == surface {
                // Dentro do menu: esquerdo sobre o item → ação; qualquer outro botão/ponto → dismiss.
                let action = if pb == PointerButton::Left {
                    menu_hit_test(&menu.model, px, py)
                } else {
                    None
                };
                if let Some(action) = action {
                    self.enqueue_action(action);
                }
            }
            // Clique dentro (sem item) OU fora do menu: em ambos os casos o menu fecha. O clique fora
            // NÃO é repassado à barra (primeira interação só descarta o popup — padrão de menus).
            self.close_menu();
            return;
        }

        // 2) Sem menu: roteia o clique na barra cuja superfície casa.
        let mut open: Option<(String, String, i32, i32)> = None;
        for ts in &self.tab_surfaces {
            if ts.layer.wl_surface() == surface {
                match hit_test_local(&ts.view.stack_id, &ts.slots, px, py, pb) {
                    Some(BarHit::Action(action)) => self.enqueue_action(action),
                    Some(BarHit::OpenContextMenu { stack_id, member_id }) => {
                        // Posição GLOBAL do cursor = origem da barra (view.x, view.y) + offset local.
                        open = Some((stack_id, member_id, ts.view.x + px, ts.view.y + py));
                    }
                    None => {}
                }
                break;
            }
        }
        if let Some((stack_id, member_id, ax, ay)) = open {
            self.open_menu(&stack_id, &member_id, ax, ay);
        }
    }

    /// Abre o menu de contexto da guia `(stack_id, member_id)` ancorado na posição GLOBAL `(anchor_x,
    /// anchor_y)` do cursor. Substitui qualquer menu anterior (só um por vez). O primeiro desenho ocorre
    /// no `configure`. Clamp best-effort à união dos outputs (v1, ADR 0040).
    fn open_menu(&mut self, stack_id: &str, member_id: &str, anchor_x: i32, anchor_y: i32) {
        self.close_menu();
        let model = MenuModel::for_tab(stack_id, member_id);
        let (w, h) = menu_size(&model);
        if w <= 0 || h <= 0 {
            return;
        }
        let (mut ax, mut ay) = (anchor_x.max(0), anchor_y.max(0));
        if let Some((bx, by)) = self.output_bounds() {
            ax = ax.min((bx - w).max(0));
            ay = ay.min((by - h).max(0));
        }
        let surface = self.compositor.create_surface(&self.qh);
        let layer = self.layer_shell.create_layer_surface(
            &self.qh,
            surface,
            Layer::Overlay,
            Some("etherbit-tab-menu"),
            None,
        );
        layer.set_anchor(Anchor::TOP | Anchor::LEFT);
        layer.set_size(w as u32, h as u32);
        layer.set_margin(ay, 0, 0, ax);
        layer.set_keyboard_interactivity(KeyboardInteractivity::None);
        layer.set_exclusive_zone(-1);
        // Input region PADRÃO (toda a superfície) → recebe os cliques. Primeiro draw no configure.
        layer.commit();
        self.menu = Some(MenuSurface { layer, model, w, h });
    }

    /// Fecha o menu de contexto (o drop da `LayerSurface` desmonta a superfície no compositor).
    fn close_menu(&mut self) {
        self.menu = None;
    }

    /// União (x+w, y+h) máxima dos outputs com geometria lógica conhecida — para o clamp do menu.
    /// `None` se nenhum output expõe geometria (fica sem clamp).
    fn output_bounds(&self) -> Option<(i32, i32)> {
        let mut max_x = 0;
        let mut max_y = 0;
        let mut found = false;
        for output in self.output_state.outputs() {
            if let Some(info) = self.output_state.info(&output) {
                if let (Some((lx, ly)), Some((sw, sh))) = (info.logical_position, info.logical_size)
                {
                    max_x = max_x.max(lx + sw);
                    max_y = max_y.max(ly + sh);
                    found = true;
                }
            }
        }
        if found {
            Some((max_x, max_y))
        } else {
            None
        }
    }

    /// Redesenha a barra cuja superfície casa com `layer` (chamado no `configure`).
    fn redraw_bar_for(&mut self, layer: &LayerSurface) {
        if let Some(i) =
            self.tab_surfaces.iter().position(|ts| ts.layer.wl_surface() == layer.wl_surface())
        {
            draw_bar(&mut self.pool, self.font.as_ref(), &self.tab_surfaces[i]);
        }
    }
}

/// Desenha uma barra de abas no seu buffer SHM: fundo opaco, realce da ativa, títulos e o "x".
fn draw_bar(pool: &mut SlotPool, font: Option<&FontVec>, ts: &TabSurface) {
    let w = ts.view.w;
    let h = ts.view.h;
    if w <= 0 || h <= 0 {
        return;
    }
    let stride = w * 4;
    let (buffer, canvas) = match pool.create_buffer(w, h, stride, wl_shm::Format::Argb8888) {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("Etherbit tabs — create_buffer falhou: {err}");
            return;
        }
    };
    {
        // Fundo opaco da faixa.
        fill_rect(canvas, w, h, 0, 0, w, h, BAR_BG);
        let font_px = (h as f32 * 0.52).clamp(11.0, 16.0);
        for slot in &ts.slots {
            if slot.active {
                fill_rect(
                    canvas,
                    w,
                    h,
                    slot.tab.x,
                    slot.tab.y,
                    slot.tab.w,
                    slot.tab.h,
                    TAB_ACTIVE_BG,
                );
            }
            let color = if slot.active { TEXT_ACTIVE } else { TEXT_INACTIVE };
            // Rótulo: do recuo esquerdo até o início do "x".
            if let Some(font) = font {
                let x0 = slot.tab.x + TAB_PAD_X;
                let x_max = slot.close.x - 2;
                text::draw_text(canvas, w, h, font, &slot.title, x0, x_max, color, font_px);
            }
            draw_close_x(canvas, w, h, slot, color);
        }
    }
    let surface = ts.layer.wl_surface();
    if let Err(err) = buffer.attach_to(surface) {
        eprintln!("Etherbit tabs — attach buffer falhou: {err}");
        return;
    }
    surface.damage_buffer(0, 0, w, h);
    surface.commit();
}

/// Desenha o menu de contexto no seu buffer SHM: fundo opaco + o rótulo de cada item (ADR 0040). A v1
/// tem um único item ("Desagrupar"), então a altura da superfície é `MENU_ITEM_H` e o rótulo fica
/// centralizado verticalmente (o `draw_text` centra na altura do canvas).
fn draw_menu(pool: &mut SlotPool, font: Option<&FontVec>, menu: &MenuSurface) {
    let w = menu.w;
    let h = menu.h;
    if w <= 0 || h <= 0 {
        return;
    }
    let stride = w * 4;
    let (buffer, canvas) = match pool.create_buffer(w, h, stride, wl_shm::Format::Argb8888) {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("Etherbit menu — create_buffer falhou: {err}");
            return;
        }
    };
    {
        fill_rect(canvas, w, h, 0, 0, w, h, BAR_BG);
        if let Some(font) = font {
            let font_px = (MENU_ITEM_H as f32 * 0.52).clamp(11.0, 16.0);
            // v1: item único — centralizado na altura total (= MENU_ITEM_H). Multi-item (offset vertical
            // por linha) fica como evolução futura.
            if let Some(item) = menu.model.items.first() {
                text::draw_text(
                    canvas,
                    w,
                    h,
                    font,
                    &item.label,
                    MENU_PAD_X,
                    w - MENU_PAD_X,
                    TEXT_ACTIVE,
                    font_px,
                );
            }
        }
    }
    let surface = menu.layer.wl_surface();
    if let Err(err) = buffer.attach_to(surface) {
        eprintln!("Etherbit menu — attach buffer falhou: {err}");
        return;
    }
    surface.damage_buffer(0, 0, w, h);
    surface.commit();
}

/// Preenche um retângulo opaco no canvas ARGB8888 (LE: bytes `[B, G, R, A]`).
#[allow(clippy::too_many_arguments)]
fn fill_rect(
    canvas: &mut [u8],
    cw: i32,
    ch: i32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    color: (u8, u8, u8),
) {
    let (r, g, b) = color;
    let x1 = (x + w).min(cw);
    let y1 = (y + h).min(ch);
    let x0 = x.max(0);
    let y0 = y.max(0);
    for py in y0..y1 {
        for px in x0..x1 {
            let idx = ((py * cw + px) * 4) as usize;
            if idx + 3 < canvas.len() {
                canvas[idx] = b;
                canvas[idx + 1] = g;
                canvas[idx + 2] = r;
                canvas[idx + 3] = 0xff;
            }
        }
    }
}

/// Desenha o "x" de fechar (duas diagonais, ~3px de espessura) centrado no retângulo do close.
fn draw_close_x(canvas: &mut [u8], cw: i32, ch: i32, slot: &TabSlot, color: (u8, u8, u8)) {
    let r = slot.close;
    let size = (r.w.min(r.h) / 2).clamp(6, 12);
    let half = size / 2;
    let cx = r.x + r.w / 2;
    let cy = r.y + r.h / 2;
    for d in -half..=half {
        for t in -1..=1 {
            text::plot(canvas, cw, ch, cx + d, cy + d + t, color); // diagonal "\"
            text::plot(canvas, cw, ch, cx + d, cy - d + t, color); // diagonal "/"
        }
    }
}

impl CompositorHandler for App {
    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_factor: i32,
    ) {
    }
    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _new_transform: wl_output::Transform,
    ) {
    }
    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _time: u32,
    ) {
    }
    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _surface: &wl_surface::WlSurface,
        _output: &wl_output::WlOutput,
    ) {
    }
}

impl OutputHandler for App {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }
    fn new_output(&mut self, _c: &Connection, _q: &QueueHandle<Self>, _o: wl_output::WlOutput) {}
    fn update_output(&mut self, _c: &Connection, _q: &QueueHandle<Self>, _o: wl_output::WlOutput) {}
    fn output_destroyed(
        &mut self,
        _c: &Connection,
        _q: &QueueHandle<Self>,
        _o: wl_output::WlOutput,
    ) {
    }
}

impl SeatHandler for App {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }
    fn new_seat(&mut self, _c: &Connection, _q: &QueueHandle<Self>, _s: wl_seat::WlSeat) {}
    fn new_capability(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Pointer && self.pointer.is_none() {
            match self.seat_state.get_pointer(qh, &seat) {
                Ok(p) => self.pointer = Some(p),
                Err(err) => eprintln!("Etherbit tabs — get_pointer falhou: {err}"),
            }
        }
    }
    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Pointer {
            if let Some(p) = self.pointer.take() {
                if p.version() >= 3 {
                    p.release();
                }
            }
        }
    }
    fn remove_seat(&mut self, _c: &Connection, _q: &QueueHandle<Self>, _s: wl_seat::WlSeat) {}
}

impl PointerHandler for App {
    fn pointer_frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for e in events {
            if let PointerEventKind::Press { button, .. } = e.kind {
                self.on_pointer_press(&e.surface, e.position, button);
            }
        }
    }
}

impl LayerShellHandler for App {
    fn closed(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, layer: &LayerSurface) {
        if self.layer.as_ref().map(|l| l.wl_surface()) == Some(layer.wl_surface()) {
            self.layer = None;
        }
        if self.menu.as_ref().map(|m| m.layer.wl_surface()) == Some(layer.wl_surface()) {
            self.menu = None;
        }
        self.tab_surfaces.retain(|ts| ts.layer.wl_surface() != layer.wl_surface());
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _serial: u32,
    ) {
        // Preview?
        if self.layer.as_ref().map(|l| l.wl_surface()) == Some(layer.wl_surface()) {
            let (w, h) = if configure.new_size.0 != 0 && configure.new_size.1 != 0 {
                configure.new_size
            } else {
                let r = self.rect.unwrap_or(PreviewRect { x: 0, y: 0, width: 0, height: 0 });
                (r.width.max(0) as u32, r.height.max(0) as u32)
            };
            self.draw_preview(w, h);
            return;
        }
        // Menu de contexto?
        if self.menu.as_ref().map(|m| m.layer.wl_surface()) == Some(layer.wl_surface()) {
            if let Some(menu) = self.menu.as_ref() {
                draw_menu(&mut self.pool, self.font.as_ref(), menu);
            }
            return;
        }
        // Barra de abas?
        self.redraw_bar_for(layer);
    }
}

impl ShmHandler for App {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

delegate_compositor!(App);
delegate_output!(App);
delegate_seat!(App);
delegate_pointer!(App);
delegate_layer!(App);
delegate_shm!(App);
delegate_registry!(App);

impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
}

/// Sobe o event loop Wayland do overlay. Fora de uma sessão com `wlr-layer-shell`, encerra GRACIOSO.
pub fn run(
    mut rx: watch::Receiver<OverlayState>,
    actions: Arc<Mutex<Vec<TabAction>>>,
    wake_tx: UnboundedSender<()>,
) -> Result<()> {
    let conn = match Connection::connect_to_env() {
        Ok(conn) => conn,
        Err(err) => {
            eprintln!("Etherbit preview — sem sessão Wayland: {err} (overlay desativado)");
            return Ok(());
        }
    };
    let (globals, mut event_queue) = match registry_queue_init::<App>(&conn) {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("Etherbit preview — registro Wayland indisponível: {err}");
            return Ok(());
        }
    };
    let qh = event_queue.handle();

    let compositor = match CompositorState::bind(&globals, &qh) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Etherbit preview — wl_compositor indisponível: {err}");
            return Ok(());
        }
    };
    let layer_shell = match LayerShell::bind(&globals, &qh) {
        Ok(l) => l,
        Err(_) => {
            eprintln!(
                "Etherbit preview — wlr-layer-shell indisponível (compositor sem suporte, ex.: \
                 Mutter/headless); overlay desativado."
            );
            return Ok(());
        }
    };
    let shm = match Shm::bind(&globals, &qh) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("Etherbit preview — wl_shm indisponível: {err}");
            return Ok(());
        }
    };
    let pool = SlotPool::new(256, &shm).map_err(|e| anyhow!("SlotPool::new: {e}"))?;

    let mut app = App {
        registry_state: RegistryState::new(&globals),
        output_state: OutputState::new(&globals, &qh),
        seat_state: SeatState::new(&globals, &qh),
        compositor,
        layer_shell,
        shm,
        qh: qh.clone(),
        pool,
        font: text::load_font(),
        layer: None,
        rect: None,
        tab_surfaces: Vec::new(),
        menu: None,
        pointer: None,
        actions,
        wake_tx,
        exit: false,
    };

    if let Err(err) = event_queue.roundtrip(&mut app) {
        eprintln!("Etherbit preview — roundtrip Wayland inicial falhou: {err}");
        return Ok(());
    }

    let mut event_loop: EventLoop<App> =
        EventLoop::try_new().map_err(|e| anyhow!("calloop EventLoop::try_new: {e}"))?;
    WaylandSource::new(conn, event_queue)
        .insert(event_loop.handle())
        .map_err(|e| anyhow!("inserir WaylandSource no calloop: {e:?}"))?;

    let mut last = OverlayState::default();
    loop {
        event_loop
            .dispatch(Some(Duration::from_millis(100)), &mut app)
            .map_err(|e| anyhow!("dispatch calloop: {e}"))?;
        if app.exit {
            break;
        }
        match rx.has_changed() {
            Ok(true) => {
                let next = rx.borrow_and_update().clone();
                if next != last {
                    if next.preview != last.preview {
                        app.apply_preview(next.preview);
                    }
                    if next.bars != last.bars {
                        app.apply_bars(&next.bars);
                    }
                    last = next;
                }
            }
            Ok(false) => {}
            Err(_) => break,
        }
    }
    Ok(())
}
