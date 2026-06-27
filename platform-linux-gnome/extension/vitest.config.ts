import { defineConfig } from 'vitest/config';

// Testes da extensão rodam em Node puro: cobrem apenas a lógica pura (config.ts),
// sem tocar nos módulos GJS (`gi://…`), que só existem no GNOME Shell em runtime.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
