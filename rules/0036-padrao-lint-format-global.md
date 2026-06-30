# 0036 — Padrão global de lint e formatação (Prettier + ESLint)

**Status:** ✅ Aceita

## Contexto

O monorepo é poliglota (ADR 0003). Até aqui só o lado **Rust** tinha padrão de estilo (`rustfmt.toml`
na raiz e no daemon; CI roda `cargo fmt --check`). Os três projetos JS/TS —
`platform-linux-gnome/extension/`, `platform-linux-kde/kwin-script/` e `web/` — **não tinham nenhum
lint nem formatação**: apenas `tsc --noEmit` (type-check, ADR 0012) e `vitest`. Não havia
`package.json` na raiz, nenhuma config de ESLint/Prettier, e a validação só acontecia em CI, sem hook
local. O resultado era estilo inconsistente entre arquivos e ausência de checagem de erros de lint
(variáveis não usadas, etc.) fora do que o compilador TS já pega.

Faltava fixar **um padrão único de estilo para o repositório inteiro** e **como** ele é aplicado
(local + CI) sem quebrar o isolamento dos workspaces (ADR 0003).

## Decisão

- **Prettier (formatação) + ESLint (lint) para todo JS/TS/JSON/YAML/CSS/Markdown.** O Rust continua
  no `rustfmt` (inalterado); Swift fica para quando existir código (ADR 0012). O Prettier formata
  inclusive os Markdown (docs/ADRs) com `proseWrap: "preserve"` (não reflui prosa pt-BR).
- **Orquestração por um `package.json` na raiz — camada de dev-tooling, NÃO um pnpm workspace.** A
  raiz declara `prettier`, `eslint`, `typescript-eslint`, `eslint-config-prettier`, `lefthook` e os
  scripts globais (`format`, `format:check`, `lint`, `lint:fix`, `format:rust`). Os subprojetos
  mantêm seus próprios `package.json`, `pnpm-lock.yaml` e `pnpm-workspace.yaml` — o isolamento do
  ADR 0003 é preservado.
  - **`pnpm-workspace.yaml` na raiz existe, mas SEM `packages:`** — no pnpm v11 esse arquivo é o home
    de configurações; aqui ele só autoriza o build do `lefthook` (`onlyBuiltDependencies`). Sem
    `packages:`, a raiz **não** engloba os subprojetos nem funde seus grafos de dependência (o pin de
    `@girs` da extension, ADR 0010, fica intacto).
- **ESLint de correção, não de estilo.** Flat config (`eslint.config.mjs`): `@eslint/js` +
  `typescript-eslint` recommended (NÃO type-checked) + `eslint-config-prettier` por último (desliga
  conflitos de formatação). Sem type-aware linting porque os três projetos têm ambientes de globais
  distintos (GJS, KWin/QJSEngine, navegador) e o `tsc --noEmit` de cada subprojeto já cobre tipos.
  `no-undef` é desligado em `*.ts` (o TS resolve os globais ambientes dos `*.d.ts`); `no-unused-vars`
  usa `caughtErrors: 'none'` — `catch (e) {}` é intencional e, no KWin (target es2017), o optional
  catch binding (`catch {`) nem existe.
- **Enforcement em duas camadas:**
  - **Local:** `lefthook.yml` com hook `pre-commit` que roda Prettier/ESLint só nos `{staged_files}`
    e re-staga o resultado (`stage_fixed`). O lefthook filtra staged nativamente — **dispensa
    lint-staged**. O hook é instalado pelo script `prepare` (`lefthook install`) no `pnpm install`
    da raiz (também no `postCreateCommand` do devcontainer).
  - **CI:** job `lint` em `.github/workflows/test.yml` (`prettier --check` + `eslint`). Como o
    `release.yml` invoca `test.yml` via `workflow_call` (ADR 0012), o lint passa a barrar release.
- **`.editorconfig` reconciliado com o Prettier:** `insert_final_newline` e
  `trim_trailing_whitespace` viraram `true` (antes `false`, conflitavam com o Prettier).

## Consequências

- A adoção exigiu **um commit grande de reformatação** de todo o JS/TS/MD/CSS existente (isolado num
  commit próprio para não poluir diffs futuros).
- Quem clona precisa rodar `pnpm install` na raiz (além do install de cada subprojeto) para ativar o
  hook; o devcontainer já faz isso no `postCreateCommand`.
- Há agora **dois níveis de pnpm** no repo (raiz dev-tooling + cada subprojeto), cada um com seu
  lockfile. É intencional e coerente com o ADR 0003.
- O ESLint começou enxuto (recommended). Regras adicionais ou type-aware linting podem ser ligados
  depois sem mudar esta decisão — atualizar este ADR se a estratégia mudar. Clippy para o Rust
  permanece fora de escopo por ora (registrar aqui se/quando entrar).
