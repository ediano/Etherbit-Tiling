# 0011 — Módulo `web/`: landing page com Vite + CSS3 puro (sem CDN)

**Status:** ✅ Aceita

## Contexto
O ecossistema precisa de um **hub oficial de distribuição**: uma landing page única, global e
agnóstica de SO, que apresente o manifesto da marca e centralize os downloads (macOS, Linux/GNOME e
futuros ambientes). O foco é **latência mínima e SEO máximo** (Core Web Vitals). Faltava fixar onde
o módulo vive, qual stack usa e a regra estrita anti-CDN.

## Decisão
- **Localização:** `web/` na **raiz** do monorepo — projeto independente, como
  `platform-linux-gnome/extension/` (não há workspace pnpm na raiz; cada módulo Node é isolado).
- **Stack:** **Vite** em modo aplicação (SPA estática), **HTML5 semântico + CSS3 puro nativo**
  (variáveis `--primary`, nesting, Grid/Flexbox), JS vanilla mínimo. **Sem TypeScript** e **sem
  framework** — `vite.config.js`.
- **Regra estrita anti-CDN:** **zero** recursos externos em runtime. Nada de Tailwind/CSS via
  `<link>`/`<script>` de CDN. Tipografia usa **system font stack** (`system-ui …`) — sem download de
  fonte. O CSS é compilado e **minificado pelo Vite** (`cssMinify`), gerando arquivo estático local.
- **SEO:** `lang="pt-BR"`, `title`/`description`, `<link rel="canonical">`, Open Graph, Twitter Card,
  `theme-color` e JSON-LD `SoftwareApplication`. Conteúdo em PT-BR (ADR 0001).
- **Deploy/base:** produção na **Vercel** em domínio raiz; `base: '/'` no `vite.config.js`
  (constante isolada). Canônica: `https://etherbit-tiling.vercel.app/`.
- **pnpm (ADR 0005):** o gate de build do pnpm 11 é tratado via **`pnpm-workspace.yaml`** com
  `verifyDepsBeforeRun: false` e `onlyBuiltDependencies: [esbuild]` (em pnpm 11 o `.npmrc` não aplica
  essas chaves de forma confiável). Sem isso, `pnpm build` falha no pré-check de dependências.

## Consequências
- Carregamento praticamente instantâneo: HTML + 1 CSS minificado + ~1 KB de JS, sem fontes/CDNs.
- Os links de download, `install.sh` e `og-image.png` são **placeholders** apontando para o repo
  (privado) / Pages; passam a resolver quando houver releases/Pages públicos. Marcados como TODO.
- A grade de cards já está pronta para novos sistemas (card "Futuro"), refletindo o core agnóstico.
- Divergência consciente com a extensão (que usa `.npmrc`): o `web/` adota `pnpm-workspace.yaml` por
  ser o mecanismo que funciona no pnpm 11 instalado.
