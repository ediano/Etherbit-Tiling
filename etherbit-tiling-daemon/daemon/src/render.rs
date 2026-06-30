// render.rs — pipeline gráfico do daemon (wgpu). Atrás da feature `wgpu-ui`.
//
// Por que aqui (e não no core): renderizar é COMPORTAMENTO GRÁFICO de plataforma; o core permanece
// matemática pura sem dependências (ver ADR 0002/0003 e rules/0016). E por que no daemon (e não na
// extensão): sob KWin (que suporta `wlr-layer-shell`) o daemon cria SUAS PRÓPRIAS superfícies de
// overlay e desenha o HUD de preview nelas — isso NÃO é overlay sobre janelas alheias (privilégio do
// compositor), é surface própria, então respeita o ADR 0016. Ver `layer.rs` para a criação da
// superfície e o event loop.
//
// Resiliência: pede um adapter de HARDWARE primeiro e, se ausente (VM/LLVMpipe), recai automática e
// transparentemente para um adapter de SOFTWARE (`force_fallback_adapter`) — nunca congela por falta
// de GPU.
//
// Estado: o pipeline de QUADS (preenchimento translúcido do HUD) está implementado e compila; a
// integração com a superfície real e o event loop vivem em `layer.rs`.

// O pipeline de quads (QuadRenderer/draw_fill) é consumido pelo overlay layer-shell (`layer.rs`), que
// só roda numa sessão KWin real. Num build headless parte dele aparece como "não usada" — é fundação
// aguardando o bind de hardware (ver ADR 0022).
#![allow(dead_code)]

use anyhow::{anyhow, Result};
use wgpu::util::DeviceExt;

/// Cor RGBA linear (0..1).
pub type Color = [f32; 4];

// HUD do jogo da velha (overlay do daemon, KDE): preenchimento translúcido das 9 células durante o
// arrasto; a célula sob o cursor (`hot`) é mais opaca. Família azul Nord do tiling.
pub const HUD_FILL: Color = [0.37, 0.51, 0.67, 0.16]; // célula fria
pub const HUD_HOT: Color = [0.37, 0.51, 0.67, 0.44]; // célula sob o cursor

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
                label: Some("etherbit-hud-device"),
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

/// Pipeline de quads coloridos para o HUD de preview. Um único shader (posição clip-space + cor),
/// blending alpha por cima do conteúdo da janela.
#[cfg(feature = "wgpu-ui")]
pub struct QuadRenderer {
    pipeline: wgpu::RenderPipeline,
}

#[cfg(feature = "wgpu-ui")]
impl QuadRenderer {
    /// Cria o pipeline para o formato de superfície `format`.
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("etherbit-hud-shader"),
            source: wgpu::ShaderSource::Wgsl(QUAD_WGSL.into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("etherbit-hud-layout"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("etherbit-hud-pipeline"),
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

    /// Pinta um único quad translúcido cobrindo TODA a superfície com `color`. Usado pelo HUD do jogo
    /// da velha (uma superfície layer-shell por célula): a célula realçada usa `HUD_HOT`, as demais
    /// `HUD_FILL`. Sem texto, sem geometria de abas — só o preenchimento.
    pub fn draw_fill(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        view: &wgpu::TextureView,
        color: Color,
    ) {
        // Quad de tela cheia em clip-space (-1..1): dois triângulos (tl,bl,br) e (tl,br,tr).
        let tl = Vertex { position: [-1.0, 1.0], color };
        let tr = Vertex { position: [1.0, 1.0], color };
        let bl = Vertex { position: [-1.0, -1.0], color };
        let br = Vertex { position: [1.0, -1.0], color };
        let verts = [tl, bl, br, tl, br, tr];
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("etherbit-hud-vertices"),
            contents: bytemuck::cast_slice(&verts),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("etherbit-hud-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
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
    }
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
