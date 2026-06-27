import { defineConfig } from "vite";

// Deploy de produção na Vercel em domínio raiz (https://etherbit-tiling.vercel.app/),
// portanto base '/'. Para servir em subpath, ajuste aqui.
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
