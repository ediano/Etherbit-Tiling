import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// O KWin avalia `contents/code/main.js` num contexto de script CLÁSSICO (QJSEngine do Qt),
// sem suporte a `import`/`export` em runtime. Por isso empacotamos TUDO num único arquivo
// no formato IIFE (auto-executável, sem imports/exports). Os globais do KWin
// (`workspace`, `callDBus`, `readConfig`, `print`, `KWin`) são resolvidos pelo motor e
// referenciados diretamente dentro do bundle.
export default defineConfig({
  build: {
    // QJSEngine (Qt 6) cobre ES2019 com folga; evita downleveling agressivo.
    target: 'es2019',
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
