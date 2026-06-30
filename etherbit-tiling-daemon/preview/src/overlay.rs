// overlay.rs — superfície de overlay (wlr-layer-shell) que desenha o retângulo translúcido do preview.
//
// Uma ÚNICA `LayerSurface` na camada Overlay, preenchida via SHM (buffer ARGB pré-multiplicado) com a
// cor de realce e opacidade no intervalo pedido (0.3–0.4). Sem GPU/shaders — um retângulo plano não
// precisa de wgpu. O estado (mostrar/reposicionar/esconder) chega por um canal `watch` alimentado pelo
// serviço D-Bus. Reposicionar REUSA a superfície (sem churn de surfaces a cada passo do arrasto).
//
// `run` é o ÚNICO ponto dependente de uma sessão Wayland real com `wlr-layer-shell` (KWin): fora dela
// (Mutter/headless/CI) o bind falha e ele encerra GRACIOSO (sem erro) — o serviço D-Bus segue vivo.

// Parte da API de handlers aparece como "não usada" em análise estática (fundação de hardware).
#![allow(dead_code)]

use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::sync::watch;

use smithay_client_toolkit::reexports::calloop::EventLoop;
use smithay_client_toolkit::reexports::calloop_wayland_source::WaylandSource;
use smithay_client_toolkit::reexports::client::{
    globals::registry_queue_init,
    protocol::{wl_output, wl_shm, wl_surface},
    Connection, QueueHandle,
};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_layer, delegate_output, delegate_registry, delegate_shm,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
    shm::{slot::SlotPool, Shm, ShmHandler},
};

/// Retângulo físico do preview (coordenadas globais do compositor).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PreviewRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Cor de realce (Nord `#5e81ac`) e opacidade do preview (ADR: 0.3–0.4 → 0.35).
const FILL_R: u32 = 0x5e;
const FILL_G: u32 = 0x81;
const FILL_B: u32 = 0xac;
const FILL_ALPHA: f32 = 0.35;

struct App {
    registry_state: RegistryState,
    output_state: OutputState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    shm: Shm,
    qh: QueueHandle<App>,
    pool: SlotPool,
    /// Superfície de overlay ATUAL (None = preview escondido).
    layer: Option<LayerSurface>,
    rect: Option<PreviewRect>,
    exit: bool,
}

impl App {
    /// Aplica o último estado do canal: cria/reposiciona a superfície (Some) ou a esconde (None).
    fn apply(&mut self, next: Option<PreviewRect>) {
        match next {
            Some(r) if r.width > 0 && r.height > 0 => {
                self.rect = Some(r);
                if self.layer.is_some() {
                    // REUSA a superfície existente (sem churn): só reposiciona e redesenha.
                    if let Some(layer) = self.layer.as_ref() {
                        layer.set_size(r.width as u32, r.height as u32);
                        layer.set_margin(r.y, 0, 0, r.x);
                        layer.commit();
                    }
                    self.draw(r.width as u32, r.height as u32);
                } else {
                    let surface = self.compositor.create_surface(&self.qh);
                    let layer = self.layer_shell.create_layer_surface(
                        &self.qh,
                        surface,
                        Layer::Overlay,
                        Some("etherbit-preview"),
                        None,
                    );
                    // Âncora no canto superior-esquerdo; a margem = posição física do retângulo.
                    layer.set_anchor(Anchor::TOP | Anchor::LEFT);
                    layer.set_size(r.width as u32, r.height as u32);
                    layer.set_margin(r.y, 0, 0, r.x);
                    layer.set_keyboard_interactivity(KeyboardInteractivity::None);
                    // Não reserva espaço: passa POR CIMA das janelas, sem empurrá-las.
                    layer.set_exclusive_zone(-1);
                    layer.commit();
                    self.layer = Some(layer);
                    // O 1º `draw` acontece no `configure` inicial (protocolo layer-shell).
                }
            }
            // None ou tamanho inválido → esconde (dropar a LayerSurface a desmonta no compositor).
            _ => {
                self.layer = None;
                self.rect = None;
            }
        }
    }

    /// Preenche a superfície (`w`×`h`) com o retângulo translúcido (SHM, alfa pré-multiplicado).
    fn draw(&mut self, w: u32, h: u32) {
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
        // Argb8888 é 0xAARRGGBB nativo. Pré-multiplica RGB pelo alfa (alpha premultiplicado do Wayland).
        let a = (FILL_ALPHA.clamp(0.0, 1.0) * 255.0) as u32;
        let pr = FILL_R * a / 255;
        let pg = FILL_G * a / 255;
        let pb = FILL_B * a / 255;
        let pixel: u32 = (a << 24) | (pr << 16) | (pg << 8) | pb;
        {
            // Escopo do empréstimo de `canvas` (mut do pool): preenche e libera antes de usar a surface.
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
        // Preview estático: não pedimos frame callbacks; nada a redesenhar por frame.
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

impl LayerShellHandler for App {
    fn closed(&mut self, _conn: &Connection, _qh: &QueueHandle<Self>, layer: &LayerSurface) {
        // O compositor destruiu a superfície (ex.: output removido): esquece-a (a próxima `apply`
        // recria conforme o estado do canal).
        if self.layer.as_ref().map(|l| l.wl_surface()) == Some(layer.wl_surface()) {
            self.layer = None;
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
        if self.layer.as_ref().map(|l| l.wl_surface()) != Some(layer.wl_surface()) {
            return;
        }
        let (w, h) = if configure.new_size.0 != 0 && configure.new_size.1 != 0 {
            configure.new_size
        } else {
            let r = self.rect.unwrap_or(PreviewRect { x: 0, y: 0, width: 0, height: 0 });
            (r.width.max(0) as u32, r.height.max(0) as u32)
        };
        self.draw(w, h);
    }
}

impl ShmHandler for App {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

delegate_compositor!(App);
delegate_output!(App);
delegate_layer!(App);
delegate_shm!(App);
delegate_registry!(App);

impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }
    registry_handlers![OutputState];
}

/// Sobe o event loop Wayland do overlay. Fora de uma sessão com `wlr-layer-shell`, encerra GRACIOSO.
pub fn run(mut rx: watch::Receiver<Option<PreviewRect>>) -> Result<()> {
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
    // Pool inicial pequeno; cresce sob demanda no `create_buffer`.
    let pool = SlotPool::new(256, &shm).map_err(|e| anyhow!("SlotPool::new: {e}"))?;

    let mut app = App {
        registry_state: RegistryState::new(&globals),
        output_state: OutputState::new(&globals, &qh),
        compositor,
        layer_shell,
        shm,
        qh: qh.clone(),
        pool,
        layer: None,
        rect: None,
        exit: false,
    };

    // Roundtrip inicial: popula outputs antes de materializar superfícies.
    if let Err(err) = event_queue.roundtrip(&mut app) {
        eprintln!("Etherbit preview — roundtrip Wayland inicial falhou: {err}");
        return Ok(());
    }

    let mut event_loop: EventLoop<App> =
        EventLoop::try_new().map_err(|e| anyhow!("calloop EventLoop::try_new: {e}"))?;
    WaylandSource::new(conn, event_queue)
        .insert(event_loop.handle())
        .map_err(|e| anyhow!("inserir WaylandSource no calloop: {e:?}"))?;

    let mut last: Option<PreviewRect> = None;
    loop {
        event_loop
            .dispatch(Some(Duration::from_millis(100)), &mut app)
            .map_err(|e| anyhow!("dispatch calloop: {e}"))?;
        if app.exit {
            break;
        }
        // Poll do canal: aplica só quando o estado MUDA (a ponte republica por transição de zona).
        match rx.has_changed() {
            Ok(true) => {
                let next = *rx.borrow_and_update();
                if next != last {
                    last = next;
                    app.apply(next);
                }
            }
            Ok(false) => {}
            // O `Sender` morreu (serviço D-Bus caiu): encerra o loop.
            Err(_) => break,
        }
    }
    Ok(())
}
