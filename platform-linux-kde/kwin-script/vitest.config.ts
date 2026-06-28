import { defineConfig } from 'vitest/config';

// Os testes cobrem APENAS os módulos puros (config.ts, tiling.ts) — sem tocar nos globais
// do KWin. Por isso o ambiente é Node puro, sem mocks de QJSEngine.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['contents/code/**/*.test.ts'],
  },
});
