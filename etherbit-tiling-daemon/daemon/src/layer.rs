// layer.rs — superfície de overlay (wlr-layer-shell) + input do ponteiro para a barra de abas.
//
// Esta é a "cola" entre o pipeline wgpu (`render.rs`), o modelo/hit-testing (`tabbar.rs`) e o contrato
// D-Bus. Sob KWin (que suporta `wlr-layer-shell`) o daemon cria UMA superfície de overlay por barra de
// abas, posicionada sobre o quadrante empilhado, e:
//   - desenha a faixa + guias + "x" com `QuadRenderer`;
//   - lê o ponteiro (`wl_pointer`) e resolve o clique com `tabbar::hit_test`;
//   - ENFILEIRA a ação (activate/close/ungroup) na fila compartilhada que o `SyncWindows` drena e
//     entrega à ponte KDE por PULL (o KWin Script é pull-only e não assina o sinal `TabAction`; ver
//     ADR 0022/0025) — e ainda emite o sinal `TabAction` (diagnóstico/GNOME/futuro).
// Isso NÃO viola o ADR 0016 (é superfície PRÓPRIA do daemon, não overlay sobre janelas alheias).
//
// O `run_event_loop` é o ÚNICO ponto dependente de uma sessão Wayland real com layer-shell (KWin):
// fora dela (CI/headless/GNOME-Mutter) o `LayerShell::bind` falha e ele encerra GRACIOSO. As barras
// vêm por um canal `tokio::watch` (último estado) alimentado a cada `SyncWindows`.

// Parte da API aparece como "não usada" em análises estáticas (é fundação de hardware): silenciado.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle, WaylandWindowHandle,
};
use tokio::sync::watch;

use smithay_client_toolkit::reexports::client::{
    globals::registry_queue_init,
    protocol::{wl_output, wl_pointer, wl_seat, wl_surface},
    Connection, Proxy, QueueHandle,
};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_layer, delegate_output, delegate_pointer, delegate_registry,
    delegate_seat,
    output::{OutputHandler, OutputState},
    reexports::calloop::EventLoop,
    reexports::calloop_wayland_source::WaylandSource,
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
};

use crate::protocol::TabActionDto;
use crate::render::{QuadRenderer, RenderContext};
use crate::service;
use crate::tabbar::{hit_test, layout_bars, BarInput, PointerButton, TabBar, TabHit};

/// Códigos `linux/input-event-codes.h` dos botões do ponteiro.
const BTN_LEFT: u32 = 0x110;
const BTN_RIGHT: u32 = 0x111;

/// Modelo + renderização da barra (independente de hardware). Conhece o pipeline wgpu, as barras
/// atuais e a fila de ações; NÃO conhece a `LayerSurface` (isso vive no event loop).
pub struct TabBarOverlay {
    ctx: RenderContext,
    renderer: QuadRenderer,
    /// Barras atuais (geometria dos elementos clicáveis), atualizadas a cada `SyncWindows`.
    bars: Vec<TabBar>,
    /// Formato da superfície (escolhido ao configurar a layer-surface).
    format: wgpu::TextureFormat,
    connection: zbus::Connection,
    /// Fila compartilhada com o serviço D-Bus: cada clique enfileira uma ação que o `SyncWindows`
    /// drena e entrega à ponte KDE por PULL (a ponte não assina o sinal `TabAction`; ver ADR 0022).
    pending_actions: Arc<Mutex<VecDeque<TabActionDto>>>,
}

impl TabBarOverlay {
    /// Cria o overlay a partir do contexto wgpu (device/queue/instance), da connection de sessão (para
    /// emitir `TabAction`) e da fila de ações pendentes (entrega por PULL). O `format` casa com o da
    /// superfície de overlay (BGRA é o comum).
    pub fn new(
        ctx: RenderContext,
        connection: zbus::Connection,
        pending_actions: Arc<Mutex<VecDeque<TabActionDto>>>,
    ) -> Self {
        let format = wgpu::TextureFormat::Bgra8UnormSrgb;
        let renderer = QuadRenderer::new(&ctx.device, format);
        Self { ctx, renderer, bars: Vec::new(), format, connection, pending_actions }
    }

    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }

    pub fn render_ctx(&self) -> &RenderContext {
        &self.ctx
    }

    pub fn connection(&self) -> &zbus::Connection {
        &self.connection
    }

    /// Atualiza as barras a partir das faixas devolvidas pelo core (após `SyncWindows`). Cada `BarInput`
    /// já vem em coordenadas absolutas de tela.
    pub fn update_bars(&mut self, inputs: &[BarInput]) {
        self.bars = layout_bars(inputs);
    }

    pub fn bars(&self) -> &[TabBar] {
        &self.bars
    }

    /// A barra do stack `stack_id` (para casar uma superfície com a sua faixa).
    pub fn bar_for_stack(&self, stack_id: u64) -> Option<&TabBar> {
        self.bars.iter().find(|b| b.stack_id == stack_id)
    }

    /// Redesenha uma barra na sua superfície (`view` = textura da swapchain da layer-surface).
    pub fn render_bar(&self, view: &wgpu::TextureView, bar: &TabBar) {
        self.renderer.draw(
            &self.ctx.device,
            &self.ctx.queue,
            view,
            bar,
            bar.bar.w.max(0) as u32,
            bar.bar.h.max(0) as u32,
        );
    }

    /// Resolve um clique do ponteiro `(x, y)` (coords absolutas de tela) e ENFILEIRA a ação
    /// correspondente para entrega por PULL. Esquerdo na guia → `activate`; esquerdo no "x" → `close`;
    /// direito → `ungroup`. Devolve `(stack_id, member_id, action)` para o chamador emitir o sinal
    /// `TabAction` (diagnóstico/GNOME/futuro), ou `None` se o clique não atingiu nada.
    pub fn enqueue_click(
        &self,
        x: i32,
        y: i32,
        button: PointerButton,
    ) -> Option<(u64, u64, &'static str)> {
        let (stack_id, member_id, action) = match hit_test(&self.bars, x, y, button) {
            TabHit::Activate(m) => (self.stack_of(m), m, "activate"),
            TabHit::Close(m) => (self.stack_of(m), m, "close"),
            TabHit::Context(m) => (self.stack_of(m), m, "ungroup"),
            TabHit::None => return None,
        };
        if let Ok(mut queue) = self.pending_actions.lock() {
            queue.push_back(TabActionDto { stack_id, member_id, action: action.to_string() });
        }
        Some((stack_id, member_id, action))
    }

    /// Id do stack (primeiro membro da barra) que contém `member`.
    fn stack_of(&self, member: u64) -> u64 {
        for bar in &self.bars {
            if bar.slots.iter().any(|s| s.member_id == member) {
                return bar.stack_id;
            }
        }
        member
    }
}

/// Constrói os handles RAW (Wayland) de uma `wl_surface`/`wl_display` para criar a `wgpu::Surface`.
/// `surface_ptr`/`display_ptr` são os ponteiros C do protocolo (obtidos do objeto da layer-surface e da
/// connection). `unsafe`: os ponteiros devem viver enquanto a surface existir (garantido pelo event
/// loop que mantém a `LayerSurface` viva junto da `wgpu::Surface`).
///
/// # Safety
/// `surface_ptr` e `display_ptr` precisam ser ponteiros válidos e não-nulos para os objetos Wayland
/// vivos durante todo o uso da `wgpu::Surface` resultante.
pub unsafe fn wgpu_surface_target(
    surface_ptr: NonNull<std::ffi::c_void>,
    display_ptr: NonNull<std::ffi::c_void>,
) -> wgpu::SurfaceTargetUnsafe {
    let wh = WaylandWindowHandle::new(surface_ptr);
    let dh = WaylandDisplayHandle::new(display_ptr);
    wgpu::SurfaceTargetUnsafe::RawHandle {
        raw_display_handle: RawDisplayHandle::Wayland(dh),
        raw_window_handle: RawWindowHandle::Wayland(wh),
    }
}

/// Uma barra materializada numa superfície de overlay própria. A ordem dos campos importa: a
/// `wgpu::Surface` empresta o ponteiro da `wl_surface` (dentro da `LayerSurface`) e DEVE ser destruída
/// ANTES dela — por isso `gpu` vem antes de `wl` (Rust dropa os campos na ordem de declaração).
struct BarSurface {
    stack_id: u64,
    gpu: wgpu::Surface<'static>,
    wl: LayerSurface,
    width: u32,
    height: u32,
}

/// Estado do event loop Wayland: globais, seat/pointer/output, o overlay (render) e as superfícies por
/// barra. `last_bars` evita recriar superfícies quando o `watch` repete o mesmo estado.
struct App {
    registry_state: RegistryState,
    seat_state: SeatState,
    output_state: OutputState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    conn: Connection,
    qh: QueueHandle<App>,
    format: wgpu::TextureFormat,
    overlay: TabBarOverlay,
    surfaces: Vec<BarSurface>,
    pointer: Option<wl_pointer::WlPointer>,
    rt: tokio::runtime::Handle,
    exit: bool,
    last_bars: Vec<BarInput>,
}

impl App {
    /// Output (e sua origem lógica) que CONTÉM o ponto absoluto `(x, y)`. Sem match (output sem
    /// posição lógica ou ponto fora de todos), devolve `(None, (0, 0))` → âncora assume origem 0,0.
    fn output_for(&self, x: i32, y: i32) -> (Option<wl_output::WlOutput>, (i32, i32)) {
        for output in self.output_state.outputs() {
            if let Some(info) = self.output_state.info(&output) {
                if let (Some((ox, oy)), Some((ow, oh))) = (info.logical_position, info.logical_size)
                {
                    if x >= ox && x < ox + ow && y >= oy && y < oy + oh {
                        return (Some(output), (ox, oy));
                    }
                }
            }
        }
        (None, (0, 0))
    }

    /// Recria as superfícies de overlay para casar com as barras atuais. Estratégia simples (recriar do
    /// zero): as barras mudam raramente (criar/desfazer/redimensionar stack, trocar aba), então o custo
    /// é desprezível e evita um diff frágil de superfícies.
    fn apply_bars(&mut self, inputs: &[BarInput]) {
        self.overlay.update_bars(inputs);
        // Solta as superfícies antigas (gpu antes de wl, pela ordem de campos).
        self.surfaces.clear();
        // Coleta a geometria ANTES do laço para não emprestar `self.overlay` enquanto muta `surfaces`.
        let geoms: Vec<(u64, i32, i32, u32, u32)> = self
            .overlay
            .bars()
            .iter()
            .map(|b| (b.stack_id, b.bar.x, b.bar.y, b.bar.w.max(1) as u32, b.bar.h.max(1) as u32))
            .collect();
        for (stack_id, bx, by, bw, bh) in geoms {
            let (output, (ox, oy)) = self.output_for(bx, by);
            let surface = self.compositor.create_surface(&self.qh);
            let layer = self.layer_shell.create_layer_surface(
                &self.qh,
                surface,
                Layer::Overlay,
                Some("etherbit-tabbar"),
                output.as_ref(),
            );
            layer.set_anchor(Anchor::TOP | Anchor::LEFT);
            layer.set_size(bw, bh);
            // Margem = posição absoluta menos a origem do output ancorado (multi-monitor).
            layer.set_margin((by - oy).max(0), 0, 0, (bx - ox).max(0));
            // O core já descontou a altura da barra do conteúdo: NÃO reservar zona exclusiva.
            layer.set_exclusive_zone(0);
            layer.set_keyboard_interactivity(KeyboardInteractivity::None);
            // Commit inicial sem buffer → dispara o `configure`, quando configuramos o wgpu e desenhamos.
            layer.commit();

            let gpu = match self.create_gpu_surface(&layer) {
                Some(s) => s,
                None => continue,
            };
            self.surfaces.push(BarSurface { stack_id, gpu, wl: layer, width: bw, height: bh });
        }
    }

    /// Cria a `wgpu::Surface` a partir da `wl_surface` da layer-surface (via `create_surface_unsafe`).
    fn create_gpu_surface(&self, layer: &LayerSurface) -> Option<wgpu::Surface<'static>> {
        let surface_ptr = NonNull::new(layer.wl_surface().id().as_ptr() as *mut c_void)?;
        let display_ptr = NonNull::new(self.conn.backend().display_ptr() as *mut c_void)?;
        // SAFETY: a `LayerSurface` (que mantém a `wl_surface` viva) é guardada junto da `wgpu::Surface`
        // em `BarSurface` e dropada DEPOIS dela; a `Connection` vive enquanto o loop roda.
        let target = unsafe { wgpu_surface_target(surface_ptr, display_ptr) };
        match unsafe { self.overlay.render_ctx().instance.create_surface_unsafe(target) } {
            Ok(s) => Some(s),
            Err(err) => {
                eprintln!("Etherbit daemon — falha ao criar wgpu::Surface da barra: {err}");
                None
            }
        }
    }

    /// Configura a swapchain da superfície `idx` para `(w, h)` e desenha sua barra.
    fn configure_and_draw(&mut self, idx: usize, w: u32, h: u32) {
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: self.format,
            width: w.max(1),
            height: h.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            // `Auto`: deixa o driver/compositor escolher o modo de composição alfa (evita supor
            // pré/pós-multiplicado). Ajustável na validação em hardware se a translucidez precisar.
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            view_formats: vec![],
        };
        self.surfaces[idx].gpu.configure(&self.overlay.render_ctx().device, &config);
        self.surfaces[idx].width = w;
        self.surfaces[idx].height = h;
        self.draw(idx);
    }

    /// Desenha a barra da superfície `idx` (estática: só redesenha em configure/recriação).
    fn draw(&self, idx: usize) {
        let bs = &self.surfaces[idx];
        let bar = match self.overlay.bar_for_stack(bs.stack_id) {
            Some(b) => b,
            None => return,
        };
        match bs.gpu.get_current_texture() {
            Ok(frame) => {
                let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
                self.overlay.render_bar(&view, bar);
                frame.present();
            }
            Err(err) => eprintln!("Etherbit daemon — get_current_texture falhou: {err}"),
        }
    }

    /// Índice da superfície cuja `wl_surface` é `surface`.
    fn surface_index(&self, surface: &wl_surface::WlSurface) -> Option<usize> {
        self.surfaces.iter().position(|b| b.wl.wl_surface() == surface)
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
        // Barra estática: não solicitamos frame callbacks; nada a redesenhar por frame.
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

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _output: wl_output::WlOutput,
    ) {
    }
}

impl LayerShellHandler for App {
    fn closed(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, layer: &LayerSurface) {
        // O compositor destruiu UMA superfície (ex.: output removido): remove só ela, não encerra o
        // loop. As nossas recriações em `apply_bars` substituem o conjunto normalmente.
        if let Some(idx) = self.surface_index(layer.wl_surface()) {
            self.surfaces.remove(idx);
        }
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _serial: u32,
    ) {
        let Some(idx) = self.surface_index(layer.wl_surface()) else {
            return;
        };
        let (w, h) = if configure.new_size.0 != 0 && configure.new_size.1 != 0 {
            configure.new_size
        } else {
            (self.surfaces[idx].width, self.surfaces[idx].height)
        };
        self.configure_and_draw(idx, w, h);
    }
}

impl SeatHandler for App {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _seat: wl_seat::WlSeat) {}

    fn new_capability(
        &mut self,
        _conn: &Connection,
        qh: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Pointer && self.pointer.is_none() {
            match self.seat_state.get_pointer(qh, &seat) {
                Ok(pointer) => self.pointer = Some(pointer),
                Err(err) => eprintln!("Etherbit daemon — falha ao obter wl_pointer: {err}"),
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
            if let Some(pointer) = self.pointer.take() {
                pointer.release();
            }
        }
    }

    fn remove_seat(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, _seat: wl_seat::WlSeat) {
    }
}

impl PointerHandler for App {
    fn pointer_frame(
        &mut self,
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
        _pointer: &wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        for event in events {
            let button = match &event.kind {
                PointerEventKind::Press { button, .. } => *button,
                _ => continue,
            };
            let Some(idx) = self.surface_index(&event.surface) else {
                continue;
            };
            let stack_id = self.surfaces[idx].stack_id;
            // Posição local da surface → absoluta de tela (origem da faixa). `bar` empresta o overlay
            // só até calcular `ax`/`ay`.
            let (ax, ay) = match self.overlay.bar_for_stack(stack_id) {
                Some(bar) => {
                    (bar.bar.x + event.position.0 as i32, bar.bar.y + event.position.1 as i32)
                }
                None => continue,
            };
            let button = match button {
                BTN_LEFT => PointerButton::Left,
                BTN_RIGHT => PointerButton::Right,
                _ => PointerButton::Other,
            };
            if let Some((stack, member, action)) = self.overlay.enqueue_click(ax, ay, button) {
                // Emite o sinal `TabAction` fora do loop síncrono (zbus é async): spawna na runtime.
                let conn = self.overlay.connection().clone();
                self.rt.spawn(async move {
                    if let Err(err) = service::emit_tab_action(&conn, stack, member, action).await {
                        eprintln!("Etherbit daemon — falha ao emitir TabAction: {err:#}");
                    }
                });
            }
        }
    }
}

delegate_compositor!(App);
delegate_output!(App);
delegate_seat!(App);
delegate_pointer!(App);
delegate_layer!(App);
delegate_registry!(App);

impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState, SeatState];
}

/// Sobe o event loop Wayland do overlay (layer-shell + ponteiro) numa sessão KWin. É o ÚNICO ponto
/// dependente de uma sessão Wayland real com `wlr-layer-shell` — por isso é validado em hardware (KWin),
/// não no CI. Fora dela, encerra GRACIOSO (sem erro). O corpo bloqueante roda em `block_in_place` para
/// não travar o executor tokio.
pub async fn run_event_loop(
    overlay: TabBarOverlay,
    bars_rx: watch::Receiver<Vec<BarInput>>,
) -> Result<()> {
    let rt = tokio::runtime::Handle::current();
    tokio::task::block_in_place(move || run_blocking(overlay, bars_rx, rt))
}

fn run_blocking(
    overlay: TabBarOverlay,
    mut bars_rx: watch::Receiver<Vec<BarInput>>,
    rt: tokio::runtime::Handle,
) -> Result<()> {
    let conn = match Connection::connect_to_env() {
        Ok(conn) => conn,
        Err(err) => {
            eprintln!("Etherbit daemon — sem sessão Wayland para a barra wgpu: {err}");
            return Ok(());
        }
    };
    let (globals, mut event_queue) = match registry_queue_init::<App>(&conn) {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("Etherbit daemon — registro Wayland indisponível: {err}");
            return Ok(());
        }
    };
    let qh = event_queue.handle();

    let compositor = match CompositorState::bind(&globals, &qh) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Etherbit daemon — wl_compositor indisponível: {err}");
            return Ok(());
        }
    };
    let layer_shell = match LayerShell::bind(&globals, &qh) {
        Ok(l) => l,
        Err(_) => {
            eprintln!(
                "Etherbit daemon — wlr-layer-shell indisponível (compositor sem suporte, ex.: \
                 Mutter/headless); barra wgpu desativada."
            );
            return Ok(());
        }
    };

    let format = overlay.format();

    let mut app = App {
        registry_state: RegistryState::new(&globals),
        seat_state: SeatState::new(&globals, &qh),
        output_state: OutputState::new(&globals, &qh),
        compositor,
        layer_shell,
        conn: conn.clone(),
        qh: qh.clone(),
        format,
        overlay,
        surfaces: Vec::new(),
        pointer: None,
        rt,
        exit: false,
        last_bars: Vec::new(),
    };

    // Roundtrip inicial: popula outputs/seats antes de materializar superfícies.
    if let Err(err) = event_queue.roundtrip(&mut app) {
        eprintln!("Etherbit daemon — roundtrip Wayland inicial falhou: {err}");
        return Ok(());
    }

    // Barras iniciais (em geral vazias até o primeiro SyncWindows com um stack).
    let initial = bars_rx.borrow_and_update().clone();
    app.last_bars = initial.clone();
    app.apply_bars(&initial);

    let mut event_loop: EventLoop<App> =
        EventLoop::try_new().map_err(|e| anyhow!("calloop EventLoop::try_new: {e}"))?;
    WaylandSource::new(conn, event_queue)
        .insert(event_loop.handle())
        .map_err(|e| anyhow!("inserir WaylandSource no calloop: {e:?}"))?;

    loop {
        event_loop
            .dispatch(Some(Duration::from_millis(100)), &mut app)
            .map_err(|e| anyhow!("dispatch calloop: {e}"))?;
        if app.exit {
            break;
        }
        // Poll do `watch`: aplica novas barras só quando o estado MUDA (evita churn de superfícies, já
        // que o `SyncWindows` republica a cada evento de janela).
        if bars_rx.has_changed().unwrap_or(false) {
            let inputs = bars_rx.borrow_and_update().clone();
            if inputs != app.last_bars {
                app.last_bars = inputs.clone();
                app.apply_bars(&inputs);
            }
        }
    }
    Ok(())
}
