// kglobalaccel.rs — gatilho de retorno helper → KWin Script. ADR 0039.
//
// O KWin Script é uma ponte burra de PULL: não assina sinais D-Bus nem tem timers. Para que um clique
// numa aba seja aplicado, o helper precisa ACORDAR o script. Mecanismo: o script registra um atalho
// global OCULTO (sem tecla) chamado `ACTION`; após enfileirar uma ação, o helper chama
// `org.kde.kglobalaccel /component/kwin invokeShortcut(ACTION)`, cujo callback drena `DrainTabActions`.
//
// ⚠️ A capacidade de `invokeShortcut` acordar um atalho registrado por KWin Script é o ponto a VALIDAR
// em sessão KDE real (ADR 0039). Tudo aqui é best-effort: sem barramento ou método, vira no-op e o canal
// é drenado para não acumular (o script ainda pode drenar de forma oportunista em eventos de janela).

use tokio::sync::mpsc::UnboundedReceiver;

const KGA_SERVICE: &str = "org.kde.kglobalaccel";
const KGA_PATH: &str = "/component/kwin";
const KGA_IFACE: &str = "org.kde.kglobalaccel.Component";

/// Nome único do atalho oculto — DEVE casar com o `registerShortcut(...)` do KWin Script.
pub const ACTION: &str = "etherbit-tiling-tab-action";

/// Laço que, a cada wake, dispara `invokeShortcut(ACTION)`. Encerra quando o `Sender` morre.
pub async fn run(mut wake_rx: UnboundedReceiver<()>) {
    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Etherbit tabs — sem barramento de sessão p/ kglobalaccel: {err}");
            // Ainda drena o canal para não acumular memória.
            while wake_rx.recv().await.is_some() {}
            return;
        }
    };
    let action = ACTION.to_string();
    while wake_rx.recv().await.is_some() {
        // Coalesce wakes pendentes: um único invoke drena toda a fila de ações.
        while wake_rx.try_recv().is_ok() {}
        let res = conn
            .call_method(Some(KGA_SERVICE), KGA_PATH, Some(KGA_IFACE), "invokeShortcut", &action)
            .await;
        if let Err(err) = res {
            eprintln!("Etherbit tabs — invokeShortcut falhou (validar em sessão KDE): {err}");
        }
    }
}
