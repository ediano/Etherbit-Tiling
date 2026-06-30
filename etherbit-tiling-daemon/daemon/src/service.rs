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

#[cfg(feature = "wgpu-ui")]
use tokio::sync::watch;

pub const BUS_NAME: &str = "dev.ediano.etherbit.Tiling";
pub const OBJECT_PATH: &str = "/dev/ediano/etherbit/Tiling";

/// Travas globais (px): o daemon faz clamp independentemente do cliente (UI ou D-Bus direto), para o
/// gap nunca engolir a área útil e o raio nunca cortar barras de título/menus (ver ADR 0019).
const GAP_MAX: u32 = 100;
const CORNER_RADIUS_MAX: u32 = 50;

/// Objeto servido no barramento de sessão.
pub struct Tiling {
    config: Config,
    /// Publica as células do HUD do jogo da velha para o overlay wgpu (KDE) desenhar durante o
    /// arrasto. `None` = HUD escondido. UI transitória (não estado de janelas/layout). Só com wgpu-ui.
    #[cfg(feature = "wgpu-ui")]
    hud_tx: watch::Sender<Option<Vec<protocol::HudCellDto>>>,
}

impl Tiling {
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

/// Executa uma chamada SÍNCRONA ao core capturando PÂNICO. Sem isso, um pânico no core (ex.: índice
/// fora de faixa, `unwrap` em entrada degenerada) abortaria a task do método D-Bus em SILÊNCIO — o
/// cliente recebe `NoReply` e a ponte fica INERTE sem nenhum log (foi o modo de falha investigado na
/// regressão do GNOME; ver ADR 0020). Com o guard, o pânico vira erro D-Bus recuperável + log no
/// journal, e a PRÓXIMA chamada volta a funcionar. `f` devolve `Result<String>` (o protocol já
/// anexa o contexto do erro). Erros e pânicos são SEMPRE logados (não dependem de `RUST_LOG`).
fn guard<T, F>(method: &str, f: F) -> fdo::Result<T>
where
    F: FnOnce() -> Result<T>,
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => {
            eprintln!("[etherbit-daemon] {method}: erro ao computar layout: {e:#}");
            Err(fdo::Error::InvalidArgs(format!("{method}: {e}")))
        }
        Err(payload) => {
            let msg = panic_message(payload.as_ref());
            eprintln!("[etherbit-daemon] {method}: PÂNICO no core (recuperado pelo guard): {msg}");
            Err(fdo::Error::Failed(format!("{method}: pânico no core: {msg}")))
        }
    }
}

/// Extrai a mensagem textual de um payload de pânico (`&str`/`String`), com marcador genérico se não
/// for texto.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "pânico não-textual".to_string()
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

    /// Chave geral do tiling. `false` faz as pontes pararem de enviar snapshots e liberarem as janelas
    /// para flutuar (o daemon segue vivo); `true` re-tila. O estado só persiste e propaga aqui — quem
    /// pausa o laço é a ponte, ao ler `enabled` da config (ConfigChanged/GetConfig).
    async fn set_enabled(
        &mut self,
        enabled: bool,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.config.enabled = enabled;
        self.persist()?;
        self.notify(&emitter).await
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
        // Computa o layout sob o guard de pânico e serializa o DTO de volta à ponte. O daemon segue
        // sem estado de janelas/layout: request/response puro (as `tab_bars` ainda viajam para o GNOME).
        let dto = guard("sync_windows", || {
            protocol::sync_windows_dto(
                &windows_json,
                &monitors_json,
                &state_json,
                &self.config.ignore_list,
                opts,
            )
        })?;

        serde_json::to_string(&dto)
            .map_err(|e| fdo::Error::Failed(format!("sync_windows: serialização: {e}")))
    }

    /// Resolve o destino de um drop sob o ponto `(x, y)`. A ponte chama isto em alta frequência
    /// durante o arrasto e desenha o indicador com o retângulo devolvido. `target_json` é o retângulo
    /// da janela sob o cursor (ou `""`), usado para detectar empilhamento (zona `stack`).
    /// `dragged_min_w`/`dragged_min_h` são os mínimos (px) da janela ARRASTADA: o preview da metade
    /// local é esticado se exigirem (ADR 0028); `0`/`0` = metade pura. Request/response puro (sem estado).
    async fn resolve_drop_zone(
        &self,
        x: i32,
        y: i32,
        monitors_json: String,
        target_json: String,
        dragged_min_w: i32,
        dragged_min_h: i32,
    ) -> fdo::Result<String> {
        let opts = self.layout_options();
        guard("resolve_drop_zone", || {
            protocol::resolve_drop_zone(
                &monitors_json,
                x,
                y,
                &target_json,
                (dragged_min_w, dragged_min_h),
                opts,
            )
        })
    }

    /// Mostra/atualiza o HUD do jogo da velha (overlay wgpu do daemon, KDE) durante o arrasto. A ponte
    /// envia as 9 células (ou 1 bloco) em coords ABSOLUTAS de tela, com `hot=true` na célula sob o
    /// cursor. Chamada por TRANSIÇÃO de célula (não por pixel): o cálculo da zona é local na ponte
    /// (ADR 0026), o daemon só pinta. UI transitória — não toca no estado de janelas/layout. Sem a UI
    /// wgpu é no-op (a ponte degrada para o `showOutline` nativo do KWin).
    async fn show_drop_hud(&self, cells_json: String) -> fdo::Result<()> {
        #[cfg(feature = "wgpu-ui")]
        {
            let cells = guard("show_drop_hud", || protocol::parse_hud_cells(&cells_json))?;
            let _ = self.hud_tx.send_replace(Some(cells));
        }
        #[cfg(not(feature = "wgpu-ui"))]
        let _ = cells_json;
        Ok(())
    }

    /// Esconde o HUD do jogo da velha (fim do arrasto / drop).
    async fn hide_drop_hud(&self) -> fdo::Result<()> {
        #[cfg(feature = "wgpu-ui")]
        {
            let _ = self.hud_tx.send_replace(None);
        }
        Ok(())
    }

    /// Aplica um drag-to-tile do jogo da velha (ADR 0026): move `dragged_id` para junto de `target_id`
    /// no lado da `zone`, com o `scope` definindo a escala (`local` = faixa de 1/3 na submatriz do alvo;
    /// `global` = bloco de 50% como nó principal do workspace). Recebe o `state_json` (com as árvores) e
    /// devolve `{"trees":[...]}` atualizado para a ponte persistir; a geometria vem do `SyncWindows`
    /// seguinte. Sem estado.
    async fn move_window(
        &self,
        state_json: String,
        dragged_id: String,
        target_id: String,
        zone: String,
        scope: String,
    ) -> fdo::Result<String> {
        // IDs trafegam como string decimal (`s`): o `callDBus` do KWin não empacota `uint64`. Parse
        // tolerante (IDs reais são ≥ 1; `0` nunca casa → core vira no-op). Ver ADR 0009.
        let dragged_id = dragged_id.parse::<u64>().unwrap_or(0);
        let target_id = target_id.parse::<u64>().unwrap_or(0);
        guard("move_window", || {
            protocol::move_window(&state_json, dragged_id, target_id, &zone, &scope)
        })
    }

    /// Resize manual elástico: arrasta a borda `edge` (left/right/top/bottom) da janela `id` em
    /// `delta_px` (positivo = cresceu). Recebe `monitors_json` (para a área do grupo) + `state_json`
    /// (árvores) e devolve `{"trees":[...]}` atualizado; a geometria vem do `SyncWindows` seguinte.
    async fn resize_window(
        &self,
        monitors_json: String,
        state_json: String,
        id: String,
        edge: String,
        delta_px: i32,
    ) -> fdo::Result<String> {
        let opts = self.layout_options();
        // `id` como string decimal (`s`): o `callDBus` do KWin não empacota `uint64`. Parse tolerante
        // (IDs reais são ≥ 1; `0` nunca casa → core vira no-op). Ver ADR 0009.
        let id = id.parse::<u64>().unwrap_or(0);
        guard("resize_window", || {
            protocol::resize_window(&monitors_json, &state_json, id, &edge, delta_px, opts)
        })
    }

    /// Sinal emitido sempre que a configuração muda. Carrega a config completa em JSON.
    #[zbus(signal)]
    async fn config_changed(emitter: &SignalEmitter<'_>, config_json: String) -> zbus::Result<()>;
}

/// Handles compartilhados entre o serviço D-Bus e o overlay wgpu (KDE), devolvidos por `serve` para o
/// `main` fiar o event loop layer-shell. Sem a feature `wgpu-ui` fica vazio.
pub struct Shared {
    /// Receptor das células do HUD do jogo da velha (`None` = escondido) para o event loop desenhar.
    #[cfg(feature = "wgpu-ui")]
    pub hud_rx: watch::Receiver<Option<Vec<protocol::HudCellDto>>>,
}

/// Sobe o serviço no barramento de sessão e o mantém vivo. Devolve a conexão e os `Shared` (receptor
/// de células do HUD) para o overlay wgpu (quando habilitado).
pub async fn serve(config: Config) -> Result<(zbus::Connection, Shared)> {
    #[cfg(feature = "wgpu-ui")]
    let (hud_tx, hud_rx) = watch::channel(None);

    let tiling = Tiling {
        config,
        #[cfg(feature = "wgpu-ui")]
        hud_tx,
    };
    let connection = zbus::connection::Builder::session()?
        .name(BUS_NAME)?
        .serve_at(OBJECT_PATH, tiling)?
        .build()
        .await?;
    let shared = Shared {
        #[cfg(feature = "wgpu-ui")]
        hud_rx,
    };
    Ok((connection, shared))
}
