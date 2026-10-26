// core/src/lib.rs — algoritmo agnóstico Ether Flow.
//
// O núcleo é puro e sem dependências (sem SO, sem GL): recebe metadados de janelas e áreas
// úteis e devolve retângulos-alvo. As camadas nativas só aplicam o resultado (ver ADR 0002 e
// rules/0016). A decisão de layout vive em `layout`.

pub mod layout;

pub use layout::{
    build_min_sizes, compute_constrained, compute_geometry, compute_layout, compute_layout_with,
    detect_drop_target, detect_drop_zone, is_tileable, matches_exception, move_window, reconcile,
    reconcile_focused, resize_window, retain_tileable_when_maximized, toggle_orientation, Axis,
    DropPreview, DropScope, DropZone, Edge, GridChild, LayoutOptions, LayoutResult, LayoutTree,
    MinSizes, Node, PreviewRect, StackDescriptor, StackGroup, TabBarRect, WindowInfo, WindowRect,
    WorkArea, MIN_RATIO,
};

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
