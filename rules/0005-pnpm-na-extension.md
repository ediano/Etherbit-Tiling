# 0005 — pnpm (via corepack) como package manager da extension

**Status:** ✅ Aceita

## Contexto

A `extension` do GNOME usa Vite + TypeScript (ESM) e precisa de um gerenciador de pacotes Node. Opções
avaliadas: npm (padrão) e pnpm (mais rápido/eficiente em disco).

## Decisão

Usar **pnpm**, habilitado via **corepack** no `postCreateCommand` do Dev Container:

```jsonc
"postCreateCommand": "corepack enable && corepack prepare pnpm@latest --activate"
```

A feature Node (`ghcr.io/devcontainers/features/node:1`) fornece Node + corepack.

## Consequências

- Instalações mais rápidas e store eficiente em disco.
- `pnpm` disponível no container sem instalação manual.
- Em shell **fish**, encadear com `; and` (ex.: `corepack enable; and pnpm install`).
