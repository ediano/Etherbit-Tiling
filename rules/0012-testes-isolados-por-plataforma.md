# 0012 — Testes automatizados isolados por plataforma

**Status:** ✅ Aceita

## Contexto

O monorepo é poliglota (ADR 0003): núcleo agnóstico em Rust, daemon Rust, extensão TypeScript e
landing em JS, cada um com sua própria toolchain. Até aqui não havia **nenhum** teste automatizado e
o CI (`release.yml`) ia direto para build/release, sem validação prévia. Faltava fixar **como** cada
plataforma é testada e **como** os testes barram um release defeituoso.

## Decisão

- **Uma suíte e um runner por plataforma — independentes entre si.** Rodar os testes de uma
  plataforma nunca exige a toolchain de outra.
  - **core/** e **etherbit-tiling-daemon/daemon/** (Rust): testes nativos `#[cfg(test)]` + `cargo test`,
    cada um no seu workspace Cargo (o daemon é workspace separado, excluído da raiz).
  - **platform-linux-gnome/extension/** (TS): **`tsc --noEmit`** (type-check) + **vitest** em
    ambiente `node` — ambos no job de CI. O type-check ficou viável após alinhar os tipos `@girs`
    numa geração estável única (ver [ADR 0010](0010-tooling-extensao-e-zbus.md)).
  - **platform-macos/** (Swift): reservado para `swift test` no host/runner macOS (placeholder até
    existir `Package.swift`).
  - **web/**: **fora do escopo de testes** — é landing estática (ADR 0011), sem lógica de negócio
    que justifique suíte automatizada. Mudanças em `web/` já não disparam release (filtro de `paths`
    no `release.yml`).
- **Testar lógica pura, não o ambiente.** Para evitar mocks frágeis de GJS, disco e DOM, extraímos a
  lógica testável para módulos sem dependências de ambiente:
  - extensão: `parseConfig`/`DEFAULT_CONFIG`/`TilingConfig` vivem em `src/config.ts` (zero `gi://`);
    `dbus.ts` re-exporta esses símbolos e mantém apenas o transporte Gio.
  - daemon: testes de serialização/contrato sem tocar `$HOME`/disco; `desktop_contents_for(&str)`
    é puro. Os caminhos de I/O (`persist`/`load_or_default`/`apply`) ficam para um passo futuro
    (com `tempdir`).
- **vitest é `devDependency` de teste** — não entra no bundle nem no runtime; **não** colide com a
  externalização `gi://` do ADR 0010.
- **CI dedicado e reutilizável.** `.github/workflows/test.yml` tem jobs separados por plataforma e
  declara `workflow_call`. O `release.yml` o invoca via `needs`, de modo que **o release só inicia se
  todos os testes passarem**. O `release.yml` permanece intacto no resto. O job macOS fica comentado,
  espelhando o `release-macos` comentado.

## Consequências

- A cobertura inicial foca em serialização/contrato e lógica pura. O contrato `Config` (daemon) ↔
  `TilingConfig`/`DEFAULT_CONFIG` (extensão) passa a ter teste que detecta divergência entre as duas
  pontas — antes só garantido por convenção (ADR 0009).
- Os caminhos de I/O do daemon ficam sem cobertura direta por ora (são invólucros finos sobre `fs`);
  registrar aqui quando forem cobertos com `tempdir`.
- Refinos futuros (path-filters por job, cobertura/`llvm-cov`, `swift test` real) são incrementais e
  não mudam esta decisão — atualizar este ADR se a estratégia mudar.
