import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// Deploy de produção na Vercel em domínio raiz (https://etherbit-tiling.vercel.app/),
// portanto base '/'. Para servir em subpath, ajuste aqui.
const BASE = "/";

const resolve = (rel) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  base: BASE,
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    cssMinify: true,
    // Multi-page: a home e a página de desinstalação. `inlineDynamicImports`
    // é incompatível com múltiplas entradas — ambas compartilham o mesmo
    // main.js, então o Rollup faz o chunk comum sozinho.
    rollupOptions: {
      input: {
        main: resolve("./index.html"),
        desinstalar: resolve("./desinstalar.html"),
      },
    },
  },
});
