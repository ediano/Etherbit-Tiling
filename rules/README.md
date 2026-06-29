# Rules — Registro de Decisões (ADR)

Esta pasta registra **todas as decisões de projeto** do Etherbit Tiling no formato
*Architecture Decision Record* (ADR): um arquivo por decisão, com contexto, decisão e consequências.

O objetivo é que qualquer pessoa (ou agente) entenda **por que** as coisas são como são, sem precisar
arqueologia de commits.

## Índice

| # | Decisão | Status |
|---|---------|--------|
| [0001](0001-idioma-portugues.md) | Comunicação e documentação em português | ✅ Aceita |
| [0002](0002-arquitetura-core-agnostico.md) | Core agnóstico em Rust + camadas nativas por plataforma | ✅ Aceita |
| [0003](0003-monorepo-poliglota.md) | Monorepo poliglota com workspace Cargo | ✅ Aceita |
| [0004](0004-docker-centralizado.md) | Docker centralizado em `docker/Dockerfile.core` | ✅ Aceita |
| [0005](0005-pnpm-na-extension.md) | pnpm (via corepack) como package manager da extension | ✅ Aceita |
| [0006](0006-cargo-lock-versionado.md) | `Cargo.lock` versionado | ✅ Aceita |
| [0007](0007-vscode-versionado-parcial.md) | `.vscode/` versionado parcialmente | ✅ Aceita |
| [0008](0008-nome-etherbit.md) | Nome e identidade "Etherbit Tiling" | ✅ Aceita |
| [0009](0009-nomenclatura-dbus-uuid.md) | Nomenclatura D-Bus, UUID da extensão e contrato JSON | ✅ Aceita |
| [0010](0010-tooling-extensao-e-zbus.md) | Tooling da extensão (Vite/ESM) e D-Bus puro com zbus | ✅ Aceita |
| [0011](0011-web-landing-vite-css-puro.md) | Módulo `web/`: landing page com Vite + CSS3 puro (sem CDN) | ✅ Aceita |
| [0012](0012-testes-isolados-por-plataforma.md) | Testes automatizados isolados por plataforma (gate do release) | ✅ Aceita |
| [0013](0013-camada-kde-kwin-script.md) | Camada KDE via KWin Script (Wayland-only) | ✅ Aceita |
| [0014](0014-daemon-linux-compartilhado.md) | Daemon Linux compartilhado entre GNOME e KDE | ✅ Aceita |
| [0015](0015-notas-release-sem-url.md) | Notas de release sem URLs (download manual de assets versionados) | ✅ Aceita |
| [0016](0016-extensao-ponte-burra-render-no-daemon.md) | Extensão "ponte burra", layout no core e renderização no daemon | ✅ Aceita |
| [0017](0017-dominio-proprio-ediano-dev.md) | Migração para domínio próprio (`ediano.dev`) | ✅ Aceita |
| [0018](0018-abas-atalhos-globais-drag-to-group.md) | Abas (StackNode), atalhos globais e agrupar por arraste | 🔄 Topologia substituída por #0026 |
| [0019](0019-arvore-bsp-persistente-resize-elastico.md) | Árvore BSP persistente, resize elástico, gap único e cantos arredondados | 🔄 Topologia substituída por #0026 |
| [0020](0020-resiliencia-ipc-dbus.md) | Resiliência de IPC (D-Bus): ativação, reconexão e wake handshake | ✅ Aceita |
| [0021](0021-tamanhos-minimos-geometry-hints.md) | Tamanhos mínimos (geometry hints): splits assimétricos e auto-floating | 🔄 Topologia substituída por #0026 |
| [0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md) | `Node::Stack` na árvore, fechar/desagrupar na barra de abas e Unmaximize Recovery | 🔄 Topologia substituída por #0026 |
| [0023](0023-compat-api-mutter-feature-detection.md) | Compatibilidade da API do Mutter na ponte GNOME (feature-detection defensiva) | ✅ Aceita |
| [0024](0024-instaladores-upgrade-idempotente-autostart.md) | Instaladores idempotentes: autostart, upgrade com checagem de versão e parada segura do daemon | ✅ Aceita |
| [0025](0025-barra-abas-clicavel-kde-entrega-por-pull.md) | Barra de abas clicável no KDE: entrega da ação por pull e fila efêmera no daemon | ✅ Aceita |
| [0026](0026-grid-fractal-3x3-elastico-e-hud.md) | Grid fractal 3×3 elástico (substitui o BSP) e HUD de preview com 9 zonas | ✅ Aceita |

## Como adicionar uma nova decisão
1. Copie o formato de um ADR existente.
2. Numere sequencialmente (`NNNN-titulo-curto.md`).
3. Adicione a linha correspondente na tabela acima.
4. Decisões revogadas não são apagadas — mude o status para *Substituída por #NNNN*.
