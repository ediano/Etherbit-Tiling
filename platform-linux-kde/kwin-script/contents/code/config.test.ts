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
    const cfg = parseConfig('{"gap": 20}');
    expect(cfg.gap).toBe(20);
  });
});

describe('DEFAULT_CONFIG', () => {
  // Espelho de `impl Default for Config` em etherbit-tiling-daemon/daemon/src/config.rs.
  // Se o daemon mudar um padrão, ATUALIZE aqui — o daemon é a fonte de verdade.
  it('casa 1:1 com o Config::default() do daemon', () => {
    expect(DEFAULT_CONFIG).toEqual({
      gap: 8,
      active_border: true,
      border_color: '#5e81ac',
      border_width: 2,
      ignore_list: [],
      autostart: false,
      rounded_corners: true,
      corner_radius: 12,
    });
  });
});
