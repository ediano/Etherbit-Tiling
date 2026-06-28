// render.rs — esqueleto do pipeline gráfico do daemon (wgpu). Atrás da feature `wgpu-ui`.
//
// Por que aqui (e não no core): renderizar é COMPORTAMENTO GRÁFICO de plataforma; o core
// permanece matemática pura sem dependências (ver ADR 0002/0003 e rules/0016). E por que no
// daemon (e não na extensão): sob Wayland um processo separado só desenha em suas PRÓPRIAS
// superfícies — nunca um overlay sobre janelas de outros apps (isso é privilégio do compositor).
// Logo, o wgpu serve às janelas próprias do daemon (ex.: futuro painel de configurações rápidas),
// nunca à "borda ativa" ao redor de janelas alheias.
//
// Resiliência: pede um adapter de HARDWARE primeiro e, se ausente (VM/LLVMpipe, hardware antigo),
// recai automática e transparentemente para um adapter de SOFTWARE (`force_fallback_adapter`),
// garantindo que o app nunca congele por falta de GPU.
//
// Estado atual: esqueleto — inicializa instância/adapter e descreve o backend escolhido. A criação
// da surface/janela (winit/smithay) e o render loop são o próximo passo de implementação.

use anyhow::{anyhow, Result};

/// Resultado da inicialização do wgpu: identifica o backend e se caímos no rasterizador por software.
pub struct RenderContext {
    backend: String,
    adapter_name: String,
    device_type: String,
    software_fallback: bool,
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

/// Inicializa o wgpu escolhendo hardware-first com fallback automático para software.
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

    Ok(RenderContext {
        backend: format!("{:?}", info.backend),
        adapter_name: info.name,
        device_type: format!("{:?}", info.device_type),
        software_fallback,
    })

    // TODO(wgpu-ui): a partir do `adapter`, requisitar `device`/`queue`, criar a surface da janela
    // própria do daemon (winit/smithay) e montar o render loop do painel de configurações rápidas.
}
