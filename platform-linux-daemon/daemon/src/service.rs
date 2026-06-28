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

/// Objeto servido no barramento de sessão.
pub struct Tiling {
    config: Config,
}

impl Tiling {
    pub fn new(config: Config) -> Self {
        Self { config }
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
    /// Retorna a configuração atual serializada em JSON.
    async fn get_config(&self) -> String {
        self.config.to_json()
    }

    /// Ajusta os gaps (espaçamento) interno e externo.
    async fn set_gaps(
        &mut self,
        inner: u32,
        outer: u32,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.config.inner_gap = inner;
        self.config.outer_gap = outer;
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
    ) -> fdo::Result<String> {
        let opts =
            LayoutOptions { inner_gap: self.config.inner_gap, outer_gap: self.config.outer_gap };
        protocol::sync_windows(&windows_json, &monitors_json, &self.config.ignore_list, opts)
            .map_err(|e| fdo::Error::InvalidArgs(format!("sync_windows: {e}")))
    }

    /// Resolve a zona de drop sob o ponto `(x, y)`. A ponte chama isto em alta frequência durante o
    /// arrasto e desenha o indicador com o retângulo devolvido. Request/response puro (daemon sem
    /// estado): a ponte envia os monitores na chamada, como em `SyncWindows`.
    async fn resolve_drop_zone(
        &self,
        x: i32,
        y: i32,
        monitors_json: String,
    ) -> fdo::Result<String> {
        let opts =
            LayoutOptions { inner_gap: self.config.inner_gap, outer_gap: self.config.outer_gap };
        protocol::resolve_drop_zone(&monitors_json, x, y, opts)
            .map_err(|e| fdo::Error::InvalidArgs(format!("resolve_drop_zone: {e}")))
    }

    /// Sinal emitido sempre que a configuração muda. Carrega a config completa em JSON.
    #[zbus(signal)]
    async fn config_changed(emitter: &SignalEmitter<'_>, config_json: String) -> zbus::Result<()>;
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
