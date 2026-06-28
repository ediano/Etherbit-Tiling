import { describe, it, expect } from 'vitest';

import { shouldTile, tileColumns, type WindowLike } from './tiling.js';

function win(overrides: Partial<WindowLike> = {}): WindowLike {
  return {
    resourceClass: 'app',
    resourceName: 'app',
    normalWindow: true,
    resizeable: true,
    maximizable: true,
    ...overrides,
  };
}

describe('shouldTile', () => {
  it('aceita uma janela normal redimensionável e maximizável', () => {
    expect(shouldTile(win(), [])).toBe(true);
  });

  it('ignora janelas na ignore_list (case-insensitive)', () => {
    expect(shouldTile(win({ resourceClass: 'Firefox' }), ['firefox'])).toBe(false);
  });

  it('ignora janelas não redimensionáveis', () => {
    expect(shouldTile(win({ resizeable: false }), [])).toBe(false);
  });

  it('ignora janelas não maximizáveis (diálogos rígidos)', () => {
    expect(shouldTile(win({ maximizable: false }), [])).toBe(false);
  });

  it('ignora janelas não normais (dock/utility/dialog/splash)', () => {
    expect(shouldTile(win({ normalWindow: false }), [])).toBe(false);
  });
});

describe('tileColumns', () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 };

  it('retorna vazio para zero janelas', () => {
    expect(tileColumns(area, 0, 8, 12)).toEqual([]);
  });

  it('uma janela ocupa a área interna (descontando o outer gap)', () => {
    const [rect] = tileColumns(area, 1, 8, 12);
    expect(rect).toEqual({ x: 12, y: 12, width: 976, height: 776 });
  });

  it('duas janelas dividem em colunas com inner gap entre elas', () => {
    const rects = tileColumns(area, 2, 8, 12);
    expect(rects).toHaveLength(2);
    // largura interna = 1000 - 24 = 976; menos 1 inner gap (8) = 968; /2 = 484
    expect(rects[0]).toEqual({ x: 12, y: 12, width: 484, height: 776 });
    expect(rects[1]).toEqual({ x: 504, y: 12, width: 484, height: 776 });
  });
});
