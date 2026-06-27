import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, type TilingConfig } from './config.js';

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
    expect(cfg.border_color).toBe(DEFAULT_CONFIG.border_color);
    expect(cfg.autostart).toBe(DEFAULT_CONFIG.autostart);
  });

  it('reproduz todos os campos de um JSON completo', () => {
    const full: TilingConfig = {
      inner_gap: 4,
      outer_gap: 16,
      active_border: false,
      border_color: '#bf616a',
      border_width: 3,
      ignore_list: ['obs', 'microsoft-word'],
      autostart: true,
    };
    expect(parseConfig(JSON.stringify(full))).toEqual(full);
  });

  it('não muta DEFAULT_CONFIG (cópia defensiva)', () => {
    const cfg = parseConfig('{"ignore_list": ["x"]}');
    cfg.ignore_list.push('y');
    expect(DEFAULT_CONFIG.ignore_list).toEqual([]);
    expect(cfg).not.toBe(DEFAULT_CONFIG);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('casa 1:1 com Config::default() do daemon', () => {
    // Espelho do `impl Default for Config` em daemon/src/config.rs. Se o daemon
    // mudar um padrão, este teste falha e força atualizar as duas pontas.
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
