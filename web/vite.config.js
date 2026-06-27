import { defineConfig } from "vite";

// Subpath do GitHub Pages do repositório (ediano/Etherbit-Tiling).
// Para domínio próprio servido na raiz, troque por '/'.
const BASE = "/";

export default defineConfig({
  base: BASE,
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    cssMinify: true,
    // Bundle enxuto: sem code-splitting para uma página única.
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
