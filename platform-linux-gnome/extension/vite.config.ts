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
    // Duas saídas (ADR 0071): `extension.js` é o loader estável que o Shell carrega; `main.js` é a
    // implementação versionada que o loader importa de `impl/<versão>/` e troca ao vivo.
    lib: {
      entry: {
        extension: resolve(__dirname, 'src/loader.ts'),
        main: resolve(__dirname, 'src/extension.ts'),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: GJS_EXTERNAL,
      output: {
        entryFileNames: '[name].js',
        // Loader e impl não compartilham código: nenhum chunk comum pode surgir entre eles.
        manualChunks: undefined,
      },
    },
  },
});
