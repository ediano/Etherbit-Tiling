// core/src/lib.rs — algoritmo agnóstico Ether Flow.
//
// O núcleo é puro e sem dependências (sem SO, sem GL): recebe metadados de janelas e áreas
// úteis e devolve retângulos-alvo. As camadas nativas só aplicam o resultado (ver ADR 0002 e
// rules/0016). A decisão de layout vive em `layout`.

pub mod layout;

pub use layout::{compute_layout, is_tileable, LayoutOptions, WindowInfo, WindowRect, WorkArea};

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_crate_version() {
        // A versão exposta deve casar com a do Cargo e nunca ser vazia.
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
        assert!(!version().is_empty());
    }
}
