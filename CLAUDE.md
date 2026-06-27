# CLAUDE.md

Índice e convenções do **Etherbit Tiling** para agentes de IA e para quem chega ao repositório.
Este arquivo **não duplica** conteúdo — aponta para a fonte de cada assunto.

## O que é
Gerenciador automático de janelas (*tiling*). Núcleo agnóstico em Rust (**Ether Flow**), alvo
principal **macOS** (Swift), suporte **Linux/GNOME** (daemon Rust + extension GNOME). Inspirado no
**COSMIC** do Pop!_OS.

## Mapa da documentação
| Assunto | Fonte |
|---------|-------|
| Visão geral e quickstart | [README.md](README.md) |
| Estrutura do monorepo | [docs/ESTRUTURA.md](docs/ESTRUTURA.md) |
| Arquitetura de alto nível | [docs/ARQUITETURA.md](docs/ARQUITETURA.md) |
| Dev Container, build e execução | [docs/DESENVOLVIMENTO.md](docs/DESENVOLVIMENTO.md) |
| Manifesto e nome | [docs/NOMENCLATURA.md](docs/NOMENCLATURA.md) |
| **Decisões de projeto (ADR)** | [rules/](rules/README.md) |

## Convenções (resumo — detalhe em `rules/`)
- **Idioma:** docs e comunicação em **português**; código/identificadores em inglês. → [rules/0001](rules/0001-idioma-portugues.md)
- **Arquitetura:** core agnóstico decide o layout; camadas nativas finas aplicam. → [rules/0002](rules/0002-arquitetura-core-agnostico.md)
- **Rust:** workspaces isolados — raiz agnóstica (`core`) e `platform-linux-gnome` (`daemon`); `edition 2021`; `Cargo.lock` versionado por workspace. → [rules/0003](rules/0003-monorepo-poliglota.md), [rules/0006](rules/0006-cargo-lock-versionado.md)
- **Docker:** centralizado em `docker/Dockerfile.core` (sem `.devcontainer/Dockerfile`). → [rules/0004](rules/0004-docker-centralizado.md)
- **Extension:** pnpm via corepack. → [rules/0005](rules/0005-pnpm-na-extension.md)
- **Shell:** o ambiente local usa **fish** — encadeie com `; and`, não `&&`.

## Regra de ouro
Antes de mudar uma convenção, registre/atualize o ADR correspondente em [rules/](rules/README.md).
Decisões não são apagadas — mudam de status.
