import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// O KWin avalia `contents/code/main.js` num contexto de script CLÁSSICO (QJSEngine do Qt),
// sem suporte a `import`/`export` em runtime. Por isso empacotamos TUDO num único arquivo
// no formato IIFE (auto-executável, sem imports/exports). Os globais do KWin
// (`workspace`, `callDBus`, `readConfig`, `print`, `KWin`) são resolvidos pelo motor e
// referenciados diretamente dentro do bundle.
export default defineConfig({
  build: {
    // QJSEngine (Qt 6) NÃO suporta o `optional catch binding` (`catch {` sem a variável de erro),
    // que é justamente uma feature ES2019 — na prática o `kwin_scripting` rejeita o bundle com
    // `Syntax error` já na primeira ocorrência. Por isso o alvo é `es2018`: o esbuild reescreve
    // `catch {` → `catch (e) {` (e demais sintaxes ≥ES2019), mantendo o bundle interpretável pelo
    // motor clássico do KWin. Ver ADR rules/0013 (emenda 2026-06).
    target: 'es2018',
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
