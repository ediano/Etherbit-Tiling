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
    /// Origem lógica `(ox, oy)` do output ao qual esta `LayerSurface` está fixada (ADR 0063). `None` =
    /// fallback global (nenhum output conhecido continha a barra). Serve para (a) rebaixar as margens
    /// GLOBAIS do core para LOCAIS ao output (uma `LayerSurface` ancorada TOP|LEFT mede as margens da
    /// origem do SEU output) e (b) detectar troca de output (barra arrastada para outro monitor): como
    /// o output de uma `LayerSurface` é IMUTÁVEL após criada, a troca exige RECRIAR a superfície.
    origin: Option<(i32, i32)>,
}

/// A superfície do menu de contexto da guia (ADR 0040): a `LayerSurface`, o modelo (para qual
/// `(stack_id, member_id)` age e seus itens) e o tamanho desenhado.
struct MenuSurface {
    layer: LayerSurface,
    model: MenuModel,
    w: i32,
    h: i32,
}

/// Arraste em curso de uma guia (ADR 0042 — drag-to-ungroup). Nasce no `Press` esquerdo sobre o corpo de
/// uma guia (o `activate` fica ADIADO até o `Release`, para distinguir clique de arraste). Guarda a
/// superfície da barra (para casar os eventos sob o grab implícito do ponteiro), a ação `activate` adiada
/// e a geometria GLOBAL da faixa (origem + tamanho), usada para resolver o ponto de soltura.
///
/// `last_pos` acompanha a ÚLTIMA posição de `Motion` (local à barra) sob o grab: o `Release` isolado é
/// frágil (alguns compositores clampeiam a posição do release à superfície), então a decisão
/// "soltou dentro/fora" usa a trajetória rastreada, não só o ponto do release (ADR 0046).
struct DragState {
    surface: wl_surface::WlSurface,
    activate: TabAction,
    bar_x: i32,
    bar_y: i32,
    bar_w: i32,
    bar_h: i32,
    last_pos: (f64, f64),
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
    /// Origem lógica do output ao qual a superfície de PREVIEW está fixada (ver `TabSurface::origin`).
    /// `None` = escondida ou fallback global. Detecta drag do preview entre monitores → recriar.
    layer_origin: Option<(i32, i32)>,
    /// Superfícies das BARRAS DE ABAS (uma por grupo).
    tab_surfaces: Vec<TabSurface>,
    /// Menu de contexto aberto (no máximo um por vez). `None` = nenhum menu aberto. ADR 0040.
    menu: Option<MenuSurface>,
    pointer: Option<wl_pointer::WlPointer>,
    /// Arraste de guia em curso (drag-to-ungroup, ADR 0042). `None` = nenhum.
    drag: Option<DragState>,
    /// Fila de ações (clique) drenada pela interface D-Bus `Tabs`.
    actions: Arc<Mutex<Vec<TabAction>>>,
    /// Acorda o KWin Script (via `invokeShortcut`) após enfileirar uma ação.
    wake_tx: UnboundedSender<()>,
    exit: bool,
}

impl App {
    /// Output cuja área lógica contém o ponto GLOBAL `(x, y)`, com sua origem lógica `(ox, oy)` (ADR
    /// 0063). O core devolve a geometria das barras/preview em coordenadas GLOBAIS do compositor, mas
    /// uma `LayerSurface` ancorada TOP|LEFT interpreta as margens relativas à origem do output ao qual
    /// está fixada. Fixamos cada superfície ao output que a contém e rebaixamos as margens para a origem
    /// dele — sem isto, uma barra num monitor fora da origem global `(0,0)` cai FORA da tela (era a causa
    /// das "abas invisíveis" no monitor secundário). `None` = nenhum output conhecido contém o ponto (o
    /// chamador cai no fallback: `output = None` + margens globais, o comportamento antigo).
    fn output_at(&self, x: i32, y: i32) -> Option<(wl_output::WlOutput, i32, i32, i32, i32)> {
        for output in self.output_state.outputs() {
            if let Some(info) = self.output_state.info(&output) {
                if let (Some((lx, ly)), Some((sw, sh))) = (info.logical_position, info.logical_size)
                {
                    if output_contains(lx, ly, sw, sh, x, y) {
                        return Some((output, lx, ly, sw, sh));
                    }
                }
            }
        }
        None
    }

    // ---- PREVIEW (papel 1) -------------------------------------------------------------------

    /// Cria/reposiciona (Some) ou esconde (None) a superfície translúcida do preview.
    fn apply_preview(&mut self, next: Option<PreviewRect>) {
        match next {
            Some(r) if r.width > 0 && r.height > 0 => {
                // Fixa ao output que contém o retângulo e rebaixa as margens para a origem dele (ADR
                // 0063). Sem output conhecido → fallback global (output=None, margens globais).
                let target = self.output_at(r.x, r.y);
                let origin = target.as_ref().map(|(_, ox, oy, _, _)| (*ox, *oy));
                let (mx, my) = origin.unwrap_or((0, 0));
                // Output de uma `LayerSurface` é IMUTÁVEL: se o preview migrou de monitor (drag entre
                // telas), descarta a superfície antiga para recriá-la fixada ao novo output.
                if self.layer.is_some() && self.layer_origin != origin {
                    self.layer = None;
                }
                self.rect = Some(r);
                if let Some(layer) = self.layer.as_ref() {
                    layer.set_size(r.width as u32, r.height as u32);
                    layer.set_margin(r.y - my, 0, 0, r.x - mx);
                    layer.commit();
                    self.draw_preview(r.width as u32, r.height as u32);
                } else {
                    let surface = self.compositor.create_surface(&self.qh);
                    let layer = self.layer_shell.create_layer_surface(
                        &self.qh,
                        surface,
                        Layer::Overlay,
                        Some("etherbit-preview"),
                        target.as_ref().map(|(o, _, _, _, _)| o),
                    );
                    layer.set_anchor(Anchor::TOP | Anchor::LEFT);
                    layer.set_size(r.width as u32, r.height as u32);
                    layer.set_margin(r.y - my, 0, 0, r.x - mx);
                    layer.set_keyboard_interactivity(KeyboardInteractivity::None);
                    layer.set_exclusive_zone(-1);
                    // Input region VAZIA: o preview é click-through (nunca rouba o ponteiro do drag).
                    if let Ok(region) = Region::new(&self.compositor) {
                        layer.wl_surface().set_input_region(Some(region.wl_region()));
                    }
                    layer.commit();
                    self.layer = Some(layer);
                    self.layer_origin = origin;
                }
            }
            _ => {
                self.layer = None;
                self.layer_origin = None;
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
        // Não reconcilia/dropa as superfícies das barras durante um arraste de guia (ADR 0042):
        // destruir a `LayerSurface` sob o grab implícito do ponteiro quebraria o grab (release
        // ignorado / ponteiro preso). O `on_pointer_release` sempre faz `self.drag.take()`, então o
        // próximo `ShowTabs` após o release reconcilia normalmente — o guard nunca prende as barras.
        if self.drag.is_some() {
            return;
        }
        // Diagnóstico de hardware (ADR 0039): confirma no journal que o helper RECEBEU as barras. Um
        // `ShowTabs` chegando aqui com N>0 e nenhuma barra visível na tela isola o defeito no desenho
        // (draw/configure); a ausência desta linha isola no transporte (D-Bus/ativação do helper).
        eprintln!(
            "Etherbit tabs — apply_bars: {} barra(s) recebida(s), {} superfície(s) atual(is)",
            bars.len(),
            self.tab_surfaces.len(),
        );
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
            // Output que contém a barra e sua origem lógica (ADR 0063): margens do core são GLOBAIS;
            // rebaixamos para LOCAIS ao output ao qual a superfície é fixada. Sem output → fallback global.
            let target = self.output_at(b.x, b.y);
            let origin = target.as_ref().map(|(_, ox, oy, _, _)| (*ox, *oy));
            let (mx, my) = origin.unwrap_or((0, 0));
            // Barra existente cujo output MUDOU (grupo arrastado para outro monitor): o output de uma
            // `LayerSurface` é imutável, então descarta a superfície para recriá-la fixada ao novo output.
            if let Some(i) = self.tab_surfaces.iter().position(|ts| ts.stack_id == b.stack_id) {
                if self.tab_surfaces[i].origin != origin {
                    self.tab_surfaces.remove(i);
                }
            }
            if let Some(i) = self.tab_surfaces.iter().position(|ts| ts.stack_id == b.stack_id) {
                let size_changed =
                    self.tab_surfaces[i].view.w != b.w || self.tab_surfaces[i].view.h != b.h;
                self.tab_surfaces[i].view = b.clone();
                self.tab_surfaces[i].slots = slots;
                self.tab_surfaces[i].layer.set_size(b.w as u32, b.h as u32);
                self.tab_surfaces[i].layer.set_margin(b.y - my, 0, 0, b.x - mx);
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
                    target.as_ref().map(|(o, _, _, _, _)| o),
                );
                layer.set_anchor(Anchor::TOP | Anchor::LEFT);
                layer.set_size(b.w as u32, b.h as u32);
                layer.set_margin(b.y - my, 0, 0, b.x - mx);
                layer.set_keyboard_interactivity(KeyboardInteractivity::None);
                layer.set_exclusive_zone(-1);
                // Input region PADRÃO (toda a superfície) → recebe os cliques. Primeiro draw no configure.
                layer.commit();
                self.tab_surfaces.push(TabSurface {
                    stack_id: b.stack_id.clone(),
                    layer,
                    view: b.clone(),
                    slots,
                    origin,
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
        let mut start_drag: Option<DragState> = None;
        for ts in &self.tab_surfaces {
            if ts.layer.wl_surface() == surface {
                match hit_test_local(&ts.view.stack_id, &ts.slots, px, py, pb) {
                    // `close` age na hora; `activate` fica ADIADO (vira candidato a arraste, ADR 0042):
                    // se o botão soltar FORA da barra, ejeta ("cai onde foi solta"); se soltar dentro,
                    // o `activate` é enfileirado no `Release`.
                    Some(BarHit::Action(action)) => {
                        if action.kind == "close" {
                            self.enqueue_action(action);
                        } else {
                            start_drag = Some(DragState {
                                surface: surface.clone(),
                                activate: action,
                                bar_x: ts.view.x,
                                bar_y: ts.view.y,
                                bar_w: ts.view.w,
                                bar_h: ts.view.h,
                                last_pos: pos,
                            });
                        }
                    }
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
        self.drag = start_drag;
    }

    /// Fim do arraste de uma guia (ADR 0042). Sob o grab implícito do ponteiro, os eventos seguem na
    /// superfície da barra onde o `Press` começou, com posição LOCAL a ela (podendo sair de `[0,w]×
    /// [0,h]`). A decisão "dentro/fora" usa a ÚLTIMA posição rastreada (`drag.last_pos`, atualizada pelos
    /// `Motion`), preferindo-a ao ponto do `Release` — que alguns compositores clampeiam à superfície,
    /// tornando a ejeção inativa (ADR 0046). Fora da faixa → ejeta com coords GLOBAIS (`ungroup_drag`);
    /// dentro → era um clique: enfileira o `activate` adiado.
    fn on_pointer_release(&mut self, surface: &wl_surface::WlSurface, pos: (f64, f64)) {
        let Some(drag) = self.drag.take() else {
            return;
        };
        if &drag.surface != surface {
            // Release numa superfície diferente (raro sob grab): trata como clique cancelado.
            return;
        }
        // "Fora da barra?" para um ponto local (origem 0,0; dentro = `[0,w)×[0,h)`).
        let is_outside = |p: (f64, f64)| -> bool {
            let (x, y) = (p.0 as i32, p.1 as i32);
            x < 0 || x >= drag.bar_w || y < 0 || y >= drag.bar_h
        };
        // A trajetória rastreada (Motion) é a fonte confiável; o ponto do release entra como reforço
        // (cobre compositores que só reportam a posição no release). Ejeta se QUALQUER um indicar fora.
        let drop = if is_outside(drag.last_pos) {
            Some(drag.last_pos)
        } else if is_outside(pos) {
            Some(pos)
        } else {
            None
        };
        match drop {
            Some((x, y)) => self.enqueue_action(TabAction::ungroup_drag(
                drag.activate.stack_id,
                drag.activate.member_id,
                drag.bar_x + x as i32,
                drag.bar_y + y as i32,
            )),
            None => self.enqueue_action(drag.activate),
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
        // Fixa o menu ao output que contém o ponto de âncora e clampa/rebaixa as margens DENTRO dele
        // (ADR 0063): o clamp por união de outputs (antigo) só funcionava com todos na origem — num
        // monitor deslocado o menu vazava ou caía fora. Sem output conhecido → fallback global.
        let target = self.output_at(anchor_x, anchor_y);
        let (out, ox, oy, ow, oh) = match &target {
            Some((o, ox, oy, ow, oh)) => (Some(o), *ox, *oy, *ow, *oh),
            None => match self.output_bounds() {
                // Fallback: clamp à união e margens globais (comportamento antigo).
                Some((bx, by)) => (None, 0, 0, bx, by),
                None => (None, 0, 0, i32::MAX, i32::MAX),
            },
        };
        // Ponto de âncora local ao output, clampado para o menu caber inteiro nele.
        let lx = (anchor_x - ox).clamp(0, (ow - w).max(0));
        let ly = (anchor_y - oy).clamp(0, (oh - h).max(0));
        let surface = self.compositor.create_surface(&self.qh);
        let layer = self.layer_shell.create_layer_surface(
            &self.qh,
            surface,
            Layer::Overlay,
            Some("etherbit-tab-menu"),
            out,
        );
        layer.set_anchor(Anchor::TOP | Anchor::LEFT);
        layer.set_size(w as u32, h as u32);
        layer.set_margin(ly, 0, 0, lx);
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
            // Diagnóstico (ADR 0039): confirma o PRIMEIRO desenho (pós-`configure`) da barra na tela.
            eprintln!(
                "Etherbit tabs — desenhando barra stack={} ({}x{})",
                self.tab_surfaces[i].view.stack_id,
                self.tab_surfaces[i].view.w,
                self.tab_surfaces[i].view.h,
            );
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
            match e.kind {
                PointerEventKind::Press { button, .. } => {
                    self.on_pointer_press(&e.surface, e.position, button);
                }
                // Rastreia a trajetória do arraste sob o grab implícito: guarda a última posição de
                // motion na barra que detém o `drag` (a posição pode sair de `[0,w]×[0,h]`). O `Release`
                // usa isto em vez de confiar só no ponto do release (ADR 0046, drag-to-ungroup).
                PointerEventKind::Motion { .. } => {
                    if let Some(drag) = self.drag.as_mut() {
                        if drag.surface == e.surface {
                            drag.last_pos = e.position;
                        }
                    }
                }
                // Fim do arraste/clique adiado da guia (ADR 0042).
                PointerEventKind::Release { .. } => {
                    self.on_pointer_release(&e.surface, e.position);
                }
                _ => {}
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

/// `true` se o ponto GLOBAL `(x, y)` cai dentro do retângulo lógico de um output `(ox, oy, ow, oh)`.
/// Semiaberto no canto inferior/direito (`< ox+ow`) para que outputs adjacentes não se sobreponham na
/// fronteira. Puro e testável (base de `output_at`/`local_origin_for`).
fn output_contains(ox: i32, oy: i32, ow: i32, oh: i32, x: i32, y: i32) -> bool {
    x >= ox && x < ox + ow && y >= oy && y < oy + oh
}

/// Origem lógica `(ox, oy)` do output que contém o ponto GLOBAL `(x, y)` numa lista de retângulos
/// `(ox, oy, ow, oh)` — ou `None` se nenhum o contém. Núcleo PURO da conversão global→local do ADR
/// 0063 (rebaixar as margens do core para a origem do output ao qual a `LayerSurface` é fixada);
/// testável sem sessão Wayland. `output_at` faz o mesmo casando o `wl_output` real.
#[cfg_attr(not(test), allow(dead_code))]
fn local_origin_for(outputs: &[(i32, i32, i32, i32)], x: i32, y: i32) -> Option<(i32, i32)> {
    outputs
        .iter()
        .find(|&&(ox, oy, ow, oh)| output_contains(ox, oy, ow, oh, x, y))
        .map(|&(ox, oy, _, _)| (ox, oy))
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
        layer_origin: None,
        tab_surfaces: Vec::new(),
        menu: None,
        pointer: None,
        drag: None,
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

    // Resync no startup (ADR 0039): acabamos de bindar `wlr-layer-shell` nesta sessão, mas o KWin Script
    // pode já ter barras publicadas que o dedup (`lastTabsKey`) não reemitirá para um helper recém-subido
    // — deixando o overlay em branco (só a janela ativa do grupo visível). Um único wake faz o script cair
    // no ramo de resync do `drainTabActions` (drain VAZIO, sem ação de clique) e reemitir as barras atuais.
    // Reusa o MESMO canal de wake dos cliques (kglobalaccel `invokeShortcut`), já validado em hardware.
    let _ = app.wake_tx.send(());

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

#[cfg(test)]
mod tests {
    use super::{local_origin_for, output_contains};

    // Setup assimétrico do relato de hardware: principal 4K na origem (0,0) e secundário Full HD à
    // direita, começando em x=3840. As margens do core são GLOBAIS; o teste trava a conversão para a
    // origem do output que contém cada barra (ADR 0063).
    const OUTPUTS_4K_FHD: &[(i32, i32, i32, i32)] = &[(0, 0, 3840, 2160), (3840, 0, 1920, 1080)];

    #[test]
    fn origin_para_barra_no_monitor_da_origem_global() {
        // Barra numa janela do 4K (origem global): margens já são locais → origem (0,0).
        assert_eq!(local_origin_for(OUTPUTS_4K_FHD, 100, 28), Some((0, 0)));
        assert_eq!(local_origin_for(OUTPUTS_4K_FHD, 3839, 2159), Some((0, 0)));
    }

    #[test]
    fn origin_rebaixa_barra_no_monitor_deslocado() {
        // Barra numa janela do Full HD (x global ≥ 3840): a origem (3840,0) rebaixa a margem para
        // dentro do output — sem isto, `set_margin(.., 3840)` a jogaria para fora da tela (bug 4K).
        assert_eq!(local_origin_for(OUTPUTS_4K_FHD, 3840, 28), Some((3840, 0)));
        assert_eq!(local_origin_for(OUTPUTS_4K_FHD, 5000, 500), Some((3840, 0)));
        // Margem local resultante: x global 3900 − origem 3840 = 60 (dentro do Full HD).
        let (ox, _) = local_origin_for(OUTPUTS_4K_FHD, 3900, 28).unwrap();
        assert_eq!(3900 - ox, 60);
    }

    #[test]
    fn origin_para_monitor_deslocado_verticalmente() {
        // Arranjo empilhado: secundário abaixo do principal.
        let stacked = &[(0, 0, 1920, 1080), (0, 1080, 1920, 1080)];
        assert_eq!(local_origin_for(stacked, 500, 1200), Some((0, 1080)));
        let (_, oy) = local_origin_for(stacked, 500, 1200).unwrap();
        assert_eq!(1200 - oy, 120);
    }

    #[test]
    fn origin_none_para_ponto_fora_de_todos_os_outputs() {
        // Fora de qualquer output conhecido → None (chamador cai no fallback global).
        assert_eq!(local_origin_for(OUTPUTS_4K_FHD, -10, -10), None);
        assert_eq!(local_origin_for(OUTPUTS_4K_FHD, 6000, 2000), None);
        assert_eq!(local_origin_for(&[], 0, 0), None);
    }

    #[test]
    fn contains_e_semiaberto_na_fronteira() {
        assert!(output_contains(0, 0, 3840, 2160, 0, 0));
        // Borda direita/inferior é exclusiva: o pixel 3840 já pertence ao próximo output.
        assert!(!output_contains(0, 0, 3840, 2160, 3840, 0));
        assert!(!output_contains(0, 0, 3840, 2160, 0, 2160));
        assert!(output_contains(3840, 0, 1920, 1080, 3840, 0));
    }
}
