// layer.rs — superfície de overlay (wlr-layer-shell) + input do ponteiro para a barra de abas.
//
// Esta é a "cola" entre o pipeline wgpu (`render.rs`), o modelo/hit-testing (`tabbar.rs`) e o contrato
// D-Bus (`service::emit_tab_action`). Sob KWin (que suporta `wlr-layer-shell`) o daemon cria UMA
// superfície de overlay por barra de abas, posicionada sobre o quadrante empilhado, e:
//   - desenha a faixa + guias + "x" com `QuadRenderer`;
//   - lê o ponteiro (`wl_pointer`) e resolve o clique com `tabbar::hit_test`;
//   - devolve a ação à ponte por `TabAction` (activate/close/ungroup), que aplica e re-tila.
// Isso NÃO viola o ADR 0016 (é superfície PRÓPRIA do daemon, não overlay sobre janelas alheias).
//
// O `TabBarOverlay` abaixo concentra a ORQUESTRAÇÃO (compilável e independente de hardware). O bind da
// `wl_surface` de layer-shell e o despacho do event loop (`smithay-client-toolkit`) vivem em
// `run_event_loop`, que roda dentro de uma sessão Wayland (KWin) — validado em hardware, não no CI.

// A API do overlay (renderização e despacho de input) é consumida pelo event loop `wlr-layer-shell`,
// que só roda numa sessão KWin real — validado em hardware, não no CI. Por isso parte dela aparece
// como "não usada" num build headless; é fundação aguardando o bind de hardware (ver ADR 0022).
#![allow(dead_code)]

use anyhow::Result;
use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle, WaylandWindowHandle,
};
use std::collections::VecDeque;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

use crate::protocol::TabActionDto;
use crate::render::{QuadRenderer, RenderContext};
use crate::service;
use crate::tabbar::{hit_test, layout_bars, BarInput, PointerButton, TabBar, TabHit};

/// Estado de uma barra de abas projetada numa superfície própria de overlay.
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
    /// Cria o overlay a partir do contexto wgpu (device/queue), da connection de sessão (para emitir
    /// `TabAction`) e da fila de ações pendentes (entrega por PULL). O `format` casa com o da
    /// superfície de overlay (BGRA pré-multiplicado é o comum).
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

    /// Atualiza as barras a partir das faixas devolvidas pelo core (após `SyncWindows`). Cada `BarInput`
    /// já vem em coordenadas absolutas de tela.
    pub fn update_bars(&mut self, inputs: &[BarInput]) {
        self.bars = layout_bars(inputs);
    }

    pub fn bars(&self) -> &[TabBar] {
        &self.bars
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

    /// Resolve um clique do ponteiro `(x, y)` (coords absolutas de tela) e emite a `TabAction`
    /// correspondente. Esquerdo na guia → `activate`; esquerdo no "x" → `close`; direito → `ungroup`.
    pub async fn on_pointer_click(&self, x: i32, y: i32, button: PointerButton) {
        let (stack_id, member_id, action) = match hit_test(&self.bars, x, y, button) {
            TabHit::Activate(m) => (self.stack_of(m), m, "activate"),
            TabHit::Close(m) => (self.stack_of(m), m, "close"),
            TabHit::Context(m) => (self.stack_of(m), m, "ungroup"),
            TabHit::None => return,
        };
        // Enfileira para a entrega por PULL — é o caminho que a ponte KDE realmente consome (drena no
        // próximo `SyncWindows`). Ver ADR 0022/0025.
        if let Ok(mut queue) = self.pending_actions.lock() {
            queue.push_back(TabActionDto { stack_id, member_id, action: action.to_string() });
        }
        // Mantém também o sinal `TabAction` (diagnóstico / GNOME / futuro KWin Effect); a ponte KDE,
        // por ser pull-only, não o assina.
        if let Err(err) =
            service::emit_tab_action(&self.connection, stack_id, member_id, action).await
        {
            eprintln!("Etherbit daemon — falha ao emitir TabAction: {err:#}");
        }
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
/// loop que os mantém). Encapsula a ponte raw-window-handle ↔ wgpu usada por `run_event_loop`.
///
/// # Safety
/// `surface_ptr` e `display_ptr` precisam ser ponteiros válidos e não-nulos para os objetos Wayland
/// vivos durante todo o uso da `wgpu::Surface` resultante.
pub unsafe fn wgpu_surface_target(
    surface_ptr: NonNull<std::ffi::c_void>,
    display_ptr: NonNull<std::ffi::c_void>,
) -> wgpu::SurfaceTargetUnsafe {
    let mut wh = WaylandWindowHandle::new(surface_ptr);
    let _ = &mut wh;
    let dh = WaylandDisplayHandle::new(display_ptr);
    wgpu::SurfaceTargetUnsafe::RawHandle {
        raw_display_handle: RawDisplayHandle::Wayland(dh),
        raw_window_handle: RawWindowHandle::Wayland(wh),
    }
}

/// Sobe o event loop Wayland do overlay (layer-shell + ponteiro) numa sessão KWin. Implementado sobre
/// `smithay-client-toolkit`: registra os globais, cria uma `LayerSurface` por barra na camada
/// `Overlay`, ancora-a em (x, y) com o tamanho da faixa, cria a `wgpu::Surface` via
/// [`wgpu_surface_target`], e despacha eventos do `wl_pointer` para [`TabBarOverlay::on_pointer_click`].
///
/// É o ÚNICO ponto dependente de uma sessão Wayland real — por isso fica isolado aqui e é validado em
/// hardware (KWin), não no CI. A assinatura e a sequência estão fixadas; o corpo é montado na
/// integração de hardware (ver ADR 0022 — "Trabalho futuro").
pub async fn run_event_loop(
    _overlay: TabBarOverlay,
    _bars_rx: watch::Receiver<Vec<BarInput>>,
) -> Result<()> {
    // Sequência (SCTK 0.19): registry_queue_init → CompositorState + LayerShell → para cada barra:
    // LayerSurface (Layer::Overlay, Anchor::TOP|LEFT, exclusive_zone, margens = x/y, size = w/h) →
    // wgpu::Instance.create_surface_unsafe(wgpu_surface_target(..)) → configure → render_bar; loop de
    // eventos do wl_pointer → on_pointer_click. As barras vêm do `_bars_rx` (watch): a cada
    // `changed()`, `update_bars` + diff das LayerSurfaces. Mantido fora do CI (precisa de compositor
    // com wlr-layer-shell, i.e. KWin).
    anyhow::bail!("run_event_loop requer uma sessão Wayland com wlr-layer-shell (KWin)")
}
