// layer.rs — superfícies de overlay (wlr-layer-shell) do HUD de preview.
//
// Esta é a "cola" entre o pipeline wgpu (`render.rs`) e o contrato D-Bus. Sob KWin (que suporta
// `wlr-layer-shell`) o daemon cria UMA superfície de overlay por célula do HUD do jogo da velha
// (durante o arrasto), com preenchimento translúcido, e a pinta com `QuadRenderer::draw_fill`. Isso
// NÃO viola o ADR 0016 (é superfície PRÓPRIA do daemon, não overlay sobre janelas alheias).
//
// O `run_event_loop` é o ÚNICO ponto dependente de uma sessão Wayland real com layer-shell (KWin):
// fora dela (CI/headless/GNOME-Mutter) o `LayerShell::bind` falha e ele encerra GRACIOSO. As células
// do HUD vêm por um canal `tokio::watch` (último estado) alimentado a cada `ShowDropHud`/`HideDropHud`.

// Parte da API aparece como "não usada" em análises estáticas (é fundação de hardware): silenciado.
#![allow(dead_code)]

use std::ffi::c_void;
use std::ptr::NonNull;
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
    seat::{pointer::PointerHandler, Capability, SeatHandler, SeatState},
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
};

use crate::render::{QuadRenderer, RenderContext};

/// Pipeline wgpu do HUD (independente de hardware). Conhece o `QuadRenderer` e o contexto wgpu; NÃO
/// conhece a `LayerSurface` (isso vive no event loop).
pub struct HudOverlay {
    ctx: RenderContext,
    renderer: QuadRenderer,
    /// Formato da superfície (escolhido ao configurar a layer-surface).
    format: wgpu::TextureFormat,
}

impl HudOverlay {
    /// Cria o overlay a partir do contexto wgpu (device/queue/instance). O `format` casa com o da
    /// superfície de overlay (BGRA é o comum).
    pub fn new(ctx: RenderContext) -> Self {
        let format = wgpu::TextureFormat::Bgra8UnormSrgb;
        let renderer = QuadRenderer::new(&ctx.device, format);
        Self { ctx, renderer, format }
    }

    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }

    pub fn render_ctx(&self) -> &RenderContext {
        &self.ctx
    }

    /// Pinta o preenchimento translúcido de UMA célula do HUD do jogo da velha (cobre a superfície
    /// inteira): `HUD_HOT` para a célula sob o cursor, `HUD_FILL` para as demais.
    pub fn render_fill(&self, view: &wgpu::TextureView, color: crate::render::Color) {
        self.renderer.draw_fill(&self.ctx.device, &self.ctx.queue, view, color);
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

/// Uma célula do HUD materializada numa superfície de overlay própria. A ordem dos campos importa: a
/// `wgpu::Surface` empresta o ponteiro da `wl_surface` (dentro da `LayerSurface`) e DEVE ser destruída
/// ANTES dela — por isso `gpu` vem antes de `wl` (Rust dropa os campos na ordem de declaração).
struct HudSurface {
    gpu: wgpu::Surface<'static>,
    wl: LayerSurface,
    width: u32,
    height: u32,
    /// `true` se é a célula sob o cursor (cor mais opaca).
    hot: bool,
}

/// Estado do event loop Wayland: globais, seat/output, o overlay (render) e as superfícies por célula.
/// `last_hud` evita recriar superfícies quando o `watch` repete o mesmo estado.
struct App {
    registry_state: RegistryState,
    seat_state: SeatState,
    output_state: OutputState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    conn: Connection,
    qh: QueueHandle<App>,
    format: wgpu::TextureFormat,
    overlay: HudOverlay,
    surfaces: Vec<HudSurface>,
    pointer: Option<wl_pointer::WlPointer>,
    exit: bool,
    /// Último estado do HUD aplicado (`None` = escondido), para não recriar superfícies à toa.
    last_hud: Option<Vec<crate::protocol::HudCellDto>>,
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

    /// Recria as superfícies do HUD do jogo da velha (overlay translúcido durante o arrasto, KDE). Uma
    /// superfície layer-shell `Overlay` por célula, com preenchimento translúcido (a célula `hot` é
    /// mais opaca). `cells` vazio = esconde o HUD. Estratégia "recriar do zero": o HUD muda por
    /// TRANSIÇÃO de célula (não por pixel — a ponte só chama `ShowDropHud` quando a célula realçada
    /// muda), então o custo é tolerável (otimização possível: criar as 9 uma vez e só redesenhar a
    /// flag `hot`).
    fn apply_hud(&mut self, cells: &[crate::protocol::HudCellDto]) {
        // Solta as superfícies antigas (`gpu` é dropado antes de `wl` pela ordem de campos).
        self.surfaces.clear();
        for c in cells {
            let (bw, bh) = (c.width.max(1) as u32, c.height.max(1) as u32);
            let (output, (ox, oy)) = self.output_for(c.x, c.y);
            let surface = self.compositor.create_surface(&self.qh);
            let layer = self.layer_shell.create_layer_surface(
                &self.qh,
                surface,
                Layer::Overlay,
                Some("etherbit-drop-hud"),
                output.as_ref(),
            );
            layer.set_anchor(Anchor::TOP | Anchor::LEFT);
            layer.set_size(bw, bh);
            // Margem = posição absoluta menos a origem do output ancorado (multi-monitor).
            layer.set_margin((c.y - oy).max(0), 0, 0, (c.x - ox).max(0));
            layer.set_exclusive_zone(0);
            // Não captura teclado nem deve interceptar o move interativo (o arrasto está em curso).
            layer.set_keyboard_interactivity(KeyboardInteractivity::None);
            layer.commit();

            let gpu = match self.create_gpu_surface(&layer) {
                Some(s) => s,
                None => continue,
            };
            self.surfaces.push(HudSurface { gpu, wl: layer, width: bw, height: bh, hot: c.hot });
        }
    }

    /// Cria a `wgpu::Surface` a partir da `wl_surface` da layer-surface (via `create_surface_unsafe`).
    fn create_gpu_surface(&self, layer: &LayerSurface) -> Option<wgpu::Surface<'static>> {
        let surface_ptr = NonNull::new(layer.wl_surface().id().as_ptr() as *mut c_void)?;
        let display_ptr = NonNull::new(self.conn.backend().display_ptr() as *mut c_void)?;
        // SAFETY: a `LayerSurface` (que mantém a `wl_surface` viva) é guardada junto da `wgpu::Surface`
        // em `HudSurface` e dropada DEPOIS dela; a `Connection` vive enquanto o loop roda.
        let target = unsafe { wgpu_surface_target(surface_ptr, display_ptr) };
        match unsafe { self.overlay.render_ctx().instance.create_surface_unsafe(target) } {
            Ok(s) => Some(s),
            Err(err) => {
                eprintln!("Etherbit daemon — falha ao criar wgpu::Surface do HUD: {err}");
                None
            }
        }
    }

    /// Configura a swapchain da superfície `idx` para `(w, h)` e desenha sua célula.
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

    /// Desenha a célula da superfície `idx` (estática: só redesenha em configure/recriação): preenchimento
    /// translúcido (hot = mais opaca).
    fn draw(&mut self, idx: usize) {
        let frame = match self.surfaces[idx].gpu.get_current_texture() {
            Ok(frame) => frame,
            Err(err) => {
                eprintln!("Etherbit daemon — get_current_texture falhou: {err}");
                return;
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let color =
            if self.surfaces[idx].hot { crate::render::HUD_HOT } else { crate::render::HUD_FILL };
        self.overlay.render_fill(&view, color);
        frame.present();
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
        // HUD estático: não solicitamos frame callbacks; nada a redesenhar por frame.
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
        // loop. As nossas recriações em `apply_hud` substituem o conjunto normalmente.
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
        _events: &[smithay_client_toolkit::seat::pointer::PointerEvent],
    ) {
        // O HUD é puramente visual: não reagimos a cliques (o arrasto interativo está em curso no
        // compositor; a ponte calcula a zona localmente — ADR 0026).
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

/// Sobe o event loop Wayland do overlay (layer-shell) numa sessão KWin. É o ÚNICO ponto dependente de
/// uma sessão Wayland real com `wlr-layer-shell` — por isso é validado em hardware (KWin), não no CI.
/// Fora dela, encerra GRACIOSO (sem erro). O corpo bloqueante roda em `block_in_place` para não travar
/// o executor tokio.
pub async fn run_event_loop(
    overlay: HudOverlay,
    hud_rx: watch::Receiver<Option<Vec<crate::protocol::HudCellDto>>>,
) -> Result<()> {
    tokio::task::block_in_place(move || run_blocking(overlay, hud_rx))
}

fn run_blocking(
    overlay: HudOverlay,
    mut hud_rx: watch::Receiver<Option<Vec<crate::protocol::HudCellDto>>>,
) -> Result<()> {
    let conn = match Connection::connect_to_env() {
        Ok(conn) => conn,
        Err(err) => {
            eprintln!("Etherbit daemon — sem sessão Wayland para o overlay wgpu: {err}");
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
                 Mutter/headless); overlay wgpu desativado."
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
        exit: false,
        last_hud: None,
    };

    // Roundtrip inicial: popula outputs/seats antes de materializar superfícies.
    if let Err(err) = event_queue.roundtrip(&mut app) {
        eprintln!("Etherbit daemon — roundtrip Wayland inicial falhou: {err}");
        return Ok(());
    }

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
        // Poll do HUD do jogo da velha: recria as células só quando o estado MUDA (a ponte só republica
        // por transição de célula durante o arrasto, evitando churn de superfícies).
        if hud_rx.has_changed().unwrap_or(false) {
            let cells = hud_rx.borrow_and_update().clone();
            if cells != app.last_hud {
                app.last_hud = cells.clone();
                app.apply_hud(cells.as_deref().unwrap_or(&[]));
            }
        }
    }
    Ok(())
}
