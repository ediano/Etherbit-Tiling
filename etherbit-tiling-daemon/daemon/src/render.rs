// render.rs — pipeline gráfico do daemon (wgpu). Atrás da feature `wgpu-ui`.
//
// Por que aqui (e não no core): renderizar é COMPORTAMENTO GRÁFICO de plataforma; o core permanece
// matemática pura sem dependências (ver ADR 0002/0003 e rules/0016). E por que no daemon (e não na
// extensão): sob KWin (que suporta `wlr-layer-shell`) o daemon cria SUAS PRÓPRIAS superfícies de
// overlay e desenha a barra de abas nelas — isso NÃO é overlay sobre janelas alheias (privilégio do
// compositor), é surface própria, então respeita o ADR 0016. No GNOME (Mutter sem layer-shell) a barra
// segue desenhada pela extensão. Ver `layer.rs` para a criação da superfície e o input do ponteiro.
//
// Resiliência: pede um adapter de HARDWARE primeiro e, se ausente (VM/LLVMpipe), recai automática e
// transparentemente para um adapter de SOFTWARE (`force_fallback_adapter`) — nunca congela por falta
// de GPU.
//
// Estado: o pipeline de QUADS (faixa + guias + ícone "x") está implementado e compila; a integração
// com a superfície real e o loop de input vivem em `layer.rs`. A renderização de TEXTO (título/ícone do
// app) é o próximo passo (exige um atlas de glifos, ex.: cosmic-text/glyphon) — ver TODO em `draw`.

// O pipeline de quads (QuadRenderer/draw) é consumido pelo overlay layer-shell (`layer.rs`), que só
// roda numa sessão KWin real. Num build headless parte dele aparece como "não usada" — é fundação
// aguardando o bind de hardware (ver ADR 0022). `build_quads` continua coberto por testes.
#![allow(dead_code)]

use anyhow::{anyhow, Result};
use wgpu::util::DeviceExt;

#[cfg(any(feature = "wgpu-ui", test))]
use crate::tabbar::{Rect, TabBar};

/// Cor RGBA linear (0..1).
pub type Color = [f32; 4];

// Paleta Nord (mesma da barra do GNOME), em RGBA linear aproximado.
const BAR_BG: Color = [0.18, 0.20, 0.25, 0.92]; // faixa de fundo
const TAB_ACTIVE: Color = [0.37, 0.51, 0.67, 0.95]; // aba ativa (azul)
const TAB_INACTIVE: Color = [0.30, 0.34, 0.40, 0.55]; // aba inativa (cinza)
const CLOSE_FG: Color = [0.92, 0.94, 0.96, 0.95]; // marca do "x"

/// Vértice do pipeline de quads: posição em clip-space (-1..1) + cor.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    position: [f32; 2],
    color: [f32; 4],
}

impl Vertex {
    fn layout() -> wgpu::VertexBufferLayout<'static> {
        const ATTRS: [wgpu::VertexAttribute; 2] =
            wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4];
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &ATTRS,
        }
    }
}

/// Resultado da inicialização do wgpu: identifica o backend, o device/queue e se caímos no
/// rasterizador por software.
pub struct RenderContext {
    backend: String,
    adapter_name: String,
    device_type: String,
    software_fallback: bool,
    /// A `Instance` é RETIDA: `layer.rs::run_event_loop` precisa dela (mesma instância que originou o
    /// adapter/device) para `create_surface_unsafe` da `wlr-layer-shell`. Descartá-la aqui invalidaria
    /// o backend ao criar a superfície.
    pub instance: wgpu::Instance,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl RenderContext {
    /// Linha legível para log, evidenciando hardware vs. software.
    pub fn describe(&self) -> String {
        format!(
            "backend={} adapter=\"{}\" tipo={} fallback_software={}",
            self.backend, self.adapter_name, self.device_type, self.software_fallback
        )
    }

    pub fn is_software_fallback(&self) -> bool {
        self.software_fallback
    }
}

/// Inicializa o wgpu escolhendo hardware-first com fallback automático para software, e cria o
/// `device`/`queue` (usados pelas superfícies da barra de abas).
pub async fn init_render() -> Result<RenderContext> {
    let instance = wgpu::Instance::default();

    // 1) Tentativa em hardware (GPU dedicada/integrada).
    let hardware = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        })
        .await;

    let (adapter, forced_software) = match hardware {
        Some(adapter) => (adapter, false),
        None => {
            // 2) Fallback transparente para rasterização por software (lavapipe/LLVMpipe).
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    force_fallback_adapter: true,
                    compatible_surface: None,
                })
                .await
                .ok_or_else(|| {
                    anyhow!("nenhum adapter wgpu disponível (nem hardware nem software)")
                })?;
            (adapter, true)
        }
    };

    let info = adapter.get_info();
    let software_fallback = forced_software || info.device_type == wgpu::DeviceType::Cpu;

    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("etherbit-tabbar-device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        )
        .await
        .map_err(|e| anyhow!("falha ao obter device wgpu: {e}"))?;

    Ok(RenderContext {
        backend: format!("{:?}", info.backend),
        adapter_name: info.name,
        device_type: format!("{:?}", info.device_type),
        software_fallback,
        instance,
        device,
        queue,
    })
}

/// Pipeline de quads coloridos para a barra de abas. Um único shader (posição clip-space + cor),
/// blending alpha por cima do conteúdo da janela ativa.
#[cfg(feature = "wgpu-ui")]
pub struct QuadRenderer {
    pipeline: wgpu::RenderPipeline,
}

#[cfg(feature = "wgpu-ui")]
impl QuadRenderer {
    /// Cria o pipeline para o formato de superfície `format`.
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("etherbit-tabbar-shader"),
            source: wgpu::ShaderSource::Wgsl(QUAD_WGSL.into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("etherbit-tabbar-layout"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("etherbit-tabbar-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[Vertex::layout()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        Self { pipeline }
    }

    /// Desenha a barra `bar` na superfície de tamanho `(surface_w, surface_h)` px (= tamanho da
    /// faixa). Os retângulos das abas estão em coords ABSOLUTAS de tela; convertemos para locais da
    /// superfície subtraindo a origem da barra.
    pub fn draw(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        view: &wgpu::TextureView,
        bar: &TabBar,
        surface_w: u32,
        surface_h: u32,
    ) {
        let verts = build_quads(bar, surface_w, surface_h);
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("etherbit-tabbar-vertices"),
            contents: bytemuck::cast_slice(&verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("etherbit-tabbar-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Transparente: só a barra é opaca; o resto do quadrante mostra a janela ativa.
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_vertex_buffer(0, buffer.slice(..));
            pass.draw(0..verts.len() as u32, 0..1);
        }
        queue.submit(std::iter::once(encoder.finish()));
        // TODO(wgpu-ui): desenhar TÍTULO e ÍCONE do app por aba (atlas de glifos via cosmic-text/
        // glyphon). O `member_ids` viaja no contrato; o título virá da ponte por IPC.
    }
}

/// Converte uma barra em vértices de quads (clip-space), em coords LOCAIS da superfície. Puro e
/// testável (não toca a GPU): faixa de fundo + cada guia (ativa/inativa) + a marca do "x".
#[cfg(any(feature = "wgpu-ui", test))]
fn build_quads(bar: &TabBar, surface_w: u32, surface_h: u32) -> Vec<Vertex> {
    let (sw, sh) = (surface_w.max(1) as f32, surface_h.max(1) as f32);
    let ox = bar.bar.x;
    let oy = bar.bar.y;
    let mut verts = Vec::new();

    // px (local) → clip-space (-1..1), y invertido (topo da tela = +1).
    let to_clip = |x: f32, y: f32| -> [f32; 2] { [(x / sw) * 2.0 - 1.0, 1.0 - (y / sh) * 2.0] };
    let mut push_rect = |r: Rect, color: Color| {
        let x0 = (r.x - ox) as f32;
        let y0 = (r.y - oy) as f32;
        let x1 = x0 + r.w as f32;
        let y1 = y0 + r.h as f32;
        let tl = Vertex { position: to_clip(x0, y0), color };
        let tr = Vertex { position: to_clip(x1, y0), color };
        let bl = Vertex { position: to_clip(x0, y1), color };
        let br = Vertex { position: to_clip(x1, y1), color };
        // Dois triângulos (tl,bl,br) e (tl,br,tr).
        verts.extend_from_slice(&[tl, bl, br, tl, br, tr]);
    };

    // Faixa de fundo cobrindo toda a superfície.
    push_rect(Rect { x: ox, y: oy, w: bar.bar.w, h: bar.bar.h }, BAR_BG);
    // Guias + marca do "x".
    for slot in &bar.slots {
        let color = if slot.member_id == bar.active_id { TAB_ACTIVE } else { TAB_INACTIVE };
        // Guia com uma pequena margem para destacar do fundo.
        let inset = Rect {
            x: slot.tab.x + 2,
            y: slot.tab.y + 2,
            w: (slot.tab.w - 4).max(0),
            h: (slot.tab.h - 4).max(0),
        };
        push_rect(inset, color);
        // Marca do "x": dois traços diagonais aproximados por um pequeno quad central (placeholder
        // até o atlas de glifos). Indica a área clicável de fechar.
        let cx = slot.close.x + slot.close.w / 2;
        let cy = slot.close.y + slot.close.h / 2;
        push_rect(Rect { x: cx - 4, y: cy - 1, w: 8, h: 2 }, CLOSE_FG);
        push_rect(Rect { x: cx - 1, y: cy - 4, w: 2, h: 8 }, CLOSE_FG);
    }
    verts
}

/// Shader WGSL: passa posição (clip-space) e cor; o fragment retorna a cor (com alpha).
#[cfg(feature = "wgpu-ui")]
const QUAD_WGSL: &str = r#"
struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>) -> VsOut {
    var out: VsOut;
    out.pos = vec4<f32>(position, 0.0, 1.0);
    out.color = color;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return in.color;
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabbar::{layout_bars, BarInput};

    #[test]
    fn build_quads_emits_six_vertices_per_rect_in_clip_space() {
        let bars = layout_bars(&[BarInput {
            stack_id: 1,
            x: 100,
            y: 50,
            w: 200,
            h: 28,
            members: vec![1, 2],
            active: 1,
            titles: vec![],
        }]);
        let verts = build_quads(&bars[0], 200, 28);
        // Fundo (1) + por aba: guia (1) + 2 traços do "x" (2) = 3 quads × 2 abas = 6; total 7 quads.
        assert_eq!(verts.len(), 7 * 6);
        // Todos os vértices em clip-space [-1, 1].
        for v in &verts {
            assert!(v.position[0] >= -1.0 && v.position[0] <= 1.0, "x fora de clip: {:?}", v);
            assert!(v.position[1] >= -1.0 && v.position[1] <= 1.0, "y fora de clip: {:?}", v);
        }
    }

    #[test]
    fn build_quads_uses_active_color_for_active_tab() {
        let bars = layout_bars(&[BarInput {
            stack_id: 1,
            x: 0,
            y: 0,
            w: 200,
            h: 28,
            members: vec![1, 2],
            active: 2,
            titles: vec![],
        }]);
        let verts = build_quads(&bars[0], 200, 28);
        // Alguma guia deve usar a cor ativa (a aba 2).
        assert!(verts.iter().any(|v| v.color == TAB_ACTIVE));
        assert!(verts.iter().any(|v| v.color == TAB_INACTIVE));
    }
}
