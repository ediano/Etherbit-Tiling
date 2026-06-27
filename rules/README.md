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

## Como adicionar uma nova decisão
1. Copie o formato de um ADR existente.
2. Numere sequencialmente (`NNNN-titulo-curto.md`).
3. Adicione a linha correspondente na tabela acima.
4. Decisões revogadas não são apagadas — mude o status para *Substituída por #NNNN*.
