// core/src/lib.rs — algoritmo agnóstico Ether Flow (stub inicial)
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
