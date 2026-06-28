import { describe, it, expect } from 'vitest';

import { DEFAULT_CONFIG, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('retorna os padrões para um objeto vazio', () => {
    expect(parseConfig('{}')).toEqual(DEFAULT_CONFIG);
  });

  it('cai nos padrões para JSON inválido', () => {
    expect(parseConfig('not json')).toEqual(DEFAULT_CONFIG);
  });

  it('mescla JSON parcial com os padrões', () => {
    const cfg = parseConfig('{"inner_gap": 20}');
    expect(cfg.inner_gap).toBe(20);
    expect(cfg.outer_gap).toBe(DEFAULT_CONFIG.outer_gap);
  });
});

describe('DEFAULT_CONFIG', () => {
  // Espelho de `impl Default for Config` em platform-linux-daemon/daemon/src/config.rs.
  // Se o daemon mudar um padrão, ATUALIZE aqui — o daemon é a fonte de verdade.
  it('casa 1:1 com o Config::default() do daemon', () => {
    expect(DEFAULT_CONFIG).toEqual({
      inner_gap: 8,
      outer_gap: 12,
      active_border: true,
      border_color: '#5e81ac',
      border_width: 2,
      ignore_list: [],
      autostart: false,
    });
  });
});
