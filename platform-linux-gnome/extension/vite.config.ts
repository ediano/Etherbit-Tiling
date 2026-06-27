import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GJS resolve `gi://` e `resource:///` em runtime, dentro do processo do GNOME Shell.
// Esses imports NUNCA podem ser bundlados nem reescritos — devem permanecer literais no
// `extension.js` final. Por isso são marcados como externos. (`system`/`gettext` são builtins GJS.)
const GJS_EXTERNAL = /^(gi:\/\/|resource:\/\/|system$|gettext$)/;

export default defineConfig({
  build: {
    // SpiderMonkey do GNOME 45+ (SM 115+) suporta ES2022 completo; firefox115 evita downleveling.
    target: 'firefox115',
    // Não manglar nomes — GObject.registerClass usa o nome da classe como GType.
    minify: false,
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      formats: ['es'],
      fileName: () => 'extension.js',
    },
    rollupOptions: {
      external: GJS_EXTERNAL,
      output: {
        entryFileNames: 'extension.js',
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
