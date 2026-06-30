import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// O KWin avalia `contents/code/main.js` num contexto de script CLÁSSICO (QJSEngine do Qt),
// sem suporte a `import`/`export` em runtime. Por isso empacotamos TUDO num único arquivo
// no formato IIFE (auto-executável, sem imports/exports). Os globais do KWin
// (`workspace`, `callDBus`, `readConfig`, `print`, `KWin`) são resolvidos pelo motor e
// referenciados diretamente dentro do bundle.
export default defineConfig({
  build: {
    // O QJSEngine (Qt 6) do KWin é um motor clássico com lacunas de sintaxe moderna: além do
    // `optional catch binding` (`catch {` sem variável, ES2019), também NÃO suporta `object spread`
    // (`{ ...x }`, ES2018) — em ambos os casos o `kwin_scripting` aborta o bundle com
    // `Unexpected token` na compilação. Por isso o alvo é `es2017`: o esbuild reescreve `catch {` →
    // `catch (e) {` E transpila `{ ...x }` → `__spreadValues(...)`, mantendo array spread `[...]` e
    // rest `(...args)` (ES2015, aceitos pelo motor). Ver ADR rules/0013 (emenda 2026-06).
    target: 'es2017',
    // Não manglar nomes — facilita depurar via journalctl e mantém o bundle legível.
    minify: false,
    sourcemap: false,
    // O output convive com os fontes .ts em contents/code; NÃO esvaziar o diretório.
    outDir: 'contents/code',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'contents/code/main.ts'),
      formats: ['iife'],
      name: 'EtherbitTiling',
      fileName: () => 'main.js',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        inlineDynamicImports: true,
        manualChunks: undefined,
        // IIFE não usa `extend`; sem exports nomeados não há poluição de escopo global.
      },
    },
  },
});
