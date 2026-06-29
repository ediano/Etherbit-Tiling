// obs.rs — observabilidade leve do daemon, SEM dependências novas.
//
// O daemon já loga com `println!`/`eprintln!`; aqui só adicionamos um detalhamento OPCIONAL ligado
// por ambiente, no idioma `RUST_LOG=debug` (ver DIAGNOSTICO-IPC.md). Sem subscriber/tracing: mantém
// o binário leve e o CI sem dependências extras. Erros e pânicos são SEMPRE logados (ver service.rs);
// só o detalhamento por chamada (nº de janelas/rects) fica atrás do `verbose()`.

use std::sync::OnceLock;

static VERBOSE: OnceLock<bool> = OnceLock::new();

/// `true` quando o detalhamento está ligado: `RUST_LOG` ou `ETHERBIT_LOG` contendo `debug`/`trace`.
/// Resolvido uma vez (o ambiente não muda em runtime) e memoizado.
pub fn verbose() -> bool {
    *VERBOSE.get_or_init(|| {
        let v = std::env::var("RUST_LOG")
            .or_else(|_| std::env::var("ETHERBIT_LOG"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        v.contains("debug") || v.contains("trace")
    })
}

/// Loga uma linha de depuração (stderr → journal) só quando `verbose()`. Prefixo estável para
/// `journalctl ... | grep etherbit-daemon`.
#[macro_export]
macro_rules! dlog {
    ($($arg:tt)*) => {
        if $crate::obs::verbose() {
            eprintln!("[etherbit-daemon] {}", format!($($arg)*));
        }
    };
}
