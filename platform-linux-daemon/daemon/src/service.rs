// service.rs — interface D-Bus `dev.ediano.etherbit.Tiling`.
//
// A extensão GNOME consome estes métodos para ler e alterar a configuração em tempo real.
// Toda mutação persiste no disco e emite `ConfigChanged` para que múltiplos clientes fiquem
// sincronizados. O contrato trafega a config como JSON string (ver ADR de nomenclatura D-Bus).

use anyhow::Result;
use etherbit_tiling_core::LayoutOptions;
use zbus::object_server::SignalEmitter;
use zbus::{fdo, interface};

use crate::autostart;
use crate::config::Config;
use crate::protocol;

pub const BUS_NAME: &str = "dev.ediano.etherbit.Tiling";
pub const OBJECT_PATH: &str = "/dev/ediano/etherbit/Tiling";

/// Travas globais (px): o daemon faz clamp independentemente do cliente (UI ou D-Bus direto), para o
/// gap nunca engolir a área útil e o raio nunca cortar barras de título/menus (ver ADR 0019).
const GAP_MAX: u32 = 100;
const CORNER_RADIUS_MAX: u32 = 50;

/// Objeto servido no barramento de sessão.
pub struct Tiling {
    config: Config,
}

impl Tiling {
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    /// Opções de layout derivadas da config atual (gap único aplicado a inner e outer + altura da
    /// barra de abas). O `gap` da config controla ambos os eixos e ambas as costuras.
    fn layout_options(&self) -> LayoutOptions {
        LayoutOptions {
            inner_gap: self.config.gap,
            outer_gap: self.config.gap,
            tab_bar_height: self.config.tab_bar_height,
        }
    }

    /// Persiste a config e propaga o erro como `fdo::Error` (mapeado para D-Bus).
    fn persist(&self) -> fdo::Result<()> {
        self.config
            .persist()
            .map_err(|e| fdo::Error::Failed(format!("falha ao persistir config: {e}")))
    }

    /// Emite `ConfigChanged` com o estado atual em JSON.
    async fn notify(&self, emitter: &SignalEmitter<'_>) -> fdo::Result<()> {
        Self::config_changed(emitter, self.config.to_json())
            .await
            .map_err(|e| fdo::Error::Failed(format!("falha ao emitir ConfigChanged: {e}")))
    }
}

#[interface(name = "dev.ediano.etherbit.Tiling")]
impl Tiling {
    /// Handshake/health-check barato: confirma que o daemon está vivo e respondendo. Usado pela ponte
    /// ao (re)detectar o daemon no barramento (pós-wake/reativação) e útil para diagnóstico.
    async fn ping(&self) -> String {
        "ok".to_string()
    }

    /// Retorna a configuração atual serializada em JSON.
    async fn get_config(&self) -> String {
        self.config.to_json()
    }

    /// Ajusta o gap único (espaçamento entre janelas e bordas, ambos os eixos). Travado em 0..=100.
    async fn set_gap(
        &mut self,
        gap: u32,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.config.gap = gap.min(GAP_MAX);
        self.persist()?;
        self.notify(&emitter).await
    }

    /// Liga/desliga a borda na janela focada e define cor e espessura.
    async fn set_active_border(
        &mut self,
        enabled: bool,
        color: String,
        width: u32,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.config.active_border = enabled;
        self.config.border_color = color;
        self.config.border_width = width;
        self.persist()?;
        self.notify(&emitter).await
    }

    /// Substitui a lista de classes/app-ids ignorados pelo algoritmo.
    async fn set_ignore_list(
        &mut self,
        app_ids: Vec<String>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.config.ignore_list = app_ids;
        self.persist()?;
        self.notify(&emitter).await
    }

    /// Liga/desliga os cantos arredondados das janelas e define o raio (px). Raio travado em 0..=50.
    async fn set_rounded_corners(
        &mut self,
        enabled: bool,
        radius: u32,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.config.rounded_corners = enabled;
        self.config.corner_radius = radius.min(CORNER_RADIUS_MAX);
        self.persist()?;
        self.notify(&emitter).await
    }

    /// Liga/desliga o início com o sistema, gerenciando o `.desktop` de autostart.
    async fn set_autostart(
        &mut self,
        enabled: bool,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        autostart::apply(enabled)
            .map_err(|e| fdo::Error::Failed(format!("falha ao aplicar autostart: {e}")))?;
        self.config.autostart = enabled;
        self.persist()?;
        self.notify(&emitter).await
    }

    /// Decide o layout das janelas. A ponte (extensão/KWin) envia o conjunto atual de janelas e
    /// as áreas úteis dos monitores como JSON; o daemon aplica o filtro cirúrgico (ignore_list),
    /// chama o core (Ether Flow) e devolve os retângulos-alvo `[{id,x,y,width,height}]`.
    ///
    /// Request/response (sem estado de janelas no daemon): serve GNOME e KDE igualmente — o KWin
    /// script não assina sinais, então usa o retorno deste método (pull).
    async fn sync_windows(
        &self,
        windows_json: String,
        monitors_json: String,
        state_json: String,
    ) -> fdo::Result<String> {
        let opts = self.layout_options();
        protocol::sync_windows(
            &windows_json,
            &monitors_json,
            &state_json,
            &self.config.ignore_list,
            opts,
        )
        .map_err(|e| fdo::Error::InvalidArgs(format!("sync_windows: {e}")))
    }

    /// Resolve o destino de um drop sob o ponto `(x, y)`. A ponte chama isto em alta frequência
    /// durante o arrasto e desenha o indicador com o retângulo devolvido. `target_json` é o retângulo
    /// da janela sob o cursor (ou `""`), usado para detectar empilhamento (zona `stack`).
    /// Request/response puro (daemon sem estado): a ponte envia monitores e alvo na chamada.
    async fn resolve_drop_zone(
        &self,
        x: i32,
        y: i32,
        monitors_json: String,
        target_json: String,
    ) -> fdo::Result<String> {
        let opts = self.layout_options();
        protocol::resolve_drop_zone(&monitors_json, x, y, &target_json, opts)
            .map_err(|e| fdo::Error::InvalidArgs(format!("resolve_drop_zone: {e}")))
    }

    /// Aplica um drag-to-tile: move `dragged_id` para junto de `target_id` no lado da `zone`
    /// (left/right/top/bottom). Recebe o `state_json` (com as árvores) e devolve `{"trees":[...]}`
    /// atualizado para a ponte persistir; a geometria vem do `SyncWindows` seguinte. Sem estado.
    async fn move_window(
        &self,
        state_json: String,
        dragged_id: u64,
        target_id: u64,
        zone: String,
    ) -> fdo::Result<String> {
        protocol::move_window(&state_json, dragged_id, target_id, &zone)
            .map_err(|e| fdo::Error::InvalidArgs(format!("move_window: {e}")))
    }

    /// Resize manual elástico: arrasta a borda `edge` (left/right/top/bottom) da janela `id` em
    /// `delta_px` (positivo = cresceu). Recebe `monitors_json` (para a área do grupo) + `state_json`
    /// (árvores) e devolve `{"trees":[...]}` atualizado; a geometria vem do `SyncWindows` seguinte.
    async fn resize_window(
        &self,
        monitors_json: String,
        state_json: String,
        id: u64,
        edge: String,
        delta_px: i32,
    ) -> fdo::Result<String> {
        let opts = self.layout_options();
        protocol::resize_window(&monitors_json, &state_json, id, &edge, delta_px, opts)
            .map_err(|e| fdo::Error::InvalidArgs(format!("resize_window: {e}")))
    }

    /// Sinal emitido sempre que a configuração muda. Carrega a config completa em JSON.
    #[zbus(signal)]
    async fn config_changed(emitter: &SignalEmitter<'_>, config_json: String) -> zbus::Result<()>;

    /// Sinal emitido quando o usuário interage com a barra de abas RENDERIZADA PELO DAEMON (wgpu, no
    /// KDE): clique na guia (`action = "activate"`), no ícone "x" (`"close"`) ou no menu de contexto
    /// (`"ungroup"`). A ponte assina, aplica a ação (ativar/fechar/desagrupar) e re-tila. No GNOME a
    /// barra é desenhada pela extensão, que trata esses cliques localmente — então este sinal só é
    /// emitido pela UI wgpu. `stack_id` é o id do stack (primeiro membro); `member_id` a janela alvo.
    #[zbus(signal)]
    async fn tab_action(
        emitter: &SignalEmitter<'_>,
        stack_id: u64,
        member_id: u64,
        action: String,
    ) -> zbus::Result<()>;
}

/// Emite o sinal `TabAction` pela connection de sessão (usado pela UI wgpu da barra de abas, que roda
/// fora do contexto de um método D-Bus). `action` ∈ {`"activate"`, `"close"`, `"ungroup"`}.
#[cfg(feature = "wgpu-ui")]
pub async fn emit_tab_action(
    connection: &zbus::Connection,
    stack_id: u64,
    member_id: u64,
    action: &str,
) -> zbus::Result<()> {
    connection
        .emit_signal(
            Option::<&str>::None,
            OBJECT_PATH,
            BUS_NAME,
            "TabAction",
            &(stack_id, member_id, action.to_string()),
        )
        .await
}

/// Sobe o serviço no barramento de sessão e o mantém vivo.
pub async fn serve(config: Config) -> Result<zbus::Connection> {
    let connection = zbus::connection::Builder::session()?
        .name(BUS_NAME)?
        .serve_at(OBJECT_PATH, Tiling::new(config))?
        .build()
        .await?;
    Ok(connection)
}
