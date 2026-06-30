# 0003 — Monorepo poliglota com workspace Cargo

**Status:** ✅ Aceita

## Contexto

O projeto reúne componentes em Rust (core + daemon), Swift (macOS) e TypeScript (extension GNOME). É
desejável versioná-los juntos, mas com **builds isolados** ao estilo monorepo — a raiz é agnóstica e
não deve depender de código específico de plataforma.

## Decisão

Adotar um **monorepo com workspaces Cargo independentes**, um por domínio de build:

```toml
# Cargo.toml (raiz, agnóstico)
[workspace]
resolver = "2"
members = ["core"]
exclude = ["etherbit-tiling-daemon"]
```

```toml
# etherbit-tiling-daemon/Cargo.toml (daemon Linux, compartilhado por GNOME/KDE)
[workspace]
resolver = "2"
members = ["daemon"]
```

- `etherbit-tiling-daemon` depende de `etherbit-tiling-core` por path (`{ path = "../../core" }`) — dependência de
  path funciona entre workspaces.
- A raiz usa `exclude` para não puxar crates de plataforma (evita acoplamento e o erro de workspace
  aninhado).
- Cada workspace tem seu próprio `Cargo.lock`. Crates usam `edition = "2021"`.
- `platform-macos` (Swift) **não** entra em workspace Cargo — é compilado por Xcode/SwiftPM no host.
- **Diretório do daemon = nome do binário (`etherbit-tiling-daemon/`).** O diretório foi renomeado de
  `platform-linux-daemon/` para espelhar o crate/binário `etherbit-tiling-daemon` (agnóstico de DE).
  Como o caminho é resolvido por `--manifest-path` (build) e o runtime pelo bus name D-Bus — nunca pelo
  nome da pasta — alinhar pasta e binário remove ambiguidade. O prefixo `platform-linux-*` fica reservado
  às camadas de **UI** de fato específicas de plataforma (`platform-linux-gnome/`, `platform-linux-kde/`).

## Consequências

- **Builds isolados:** o core compila sem nada de plataforma; o daemon compila no seu próprio workspace.
- A raiz permanece agnóstica; cada plataforma evolui de forma autocontida.
- Componentes não-Rust convivem no mesmo repo, com builds próprios.
- Estrutura detalhada em [docs/ESTRUTURA.md](../docs/ESTRUTURA.md).
