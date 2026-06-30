import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parseFloating,
  parseLayoutTrees,
  parsePreview,
  orderKey,
  appendToOrder,
  removeFromOrder,
  sortByOrder,
  serializeState,
  serializeTarget,
  toggleGroupDisabled,
  treeToTransport,
  treeFromTransport,
  resizeDeltaFrom,
  resolveHotZone,
  serializeScope,
  serializeHudCells,
  type TreeNode,
  type TransportNode,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';

const win: WindowSnapshot = {
  id: 7,
  app_id: 'konsole',
  title: 'Konsole',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  normal: true,
  resizable: true,
  maximizable: true,
  monitor: 0,
  workspace: 0,
  min_width: 0,
  min_height: 0,
  maximized: false,
};

describe('serializeWindows / serializeMonitors', () => {
  it('produz JSON com os campos do contrato (espelho do DTO do daemon)', () => {
    expect(JSON.parse(serializeWindows([win]))).toEqual([win]);
  });

  it('serializa monitores (áreas úteis)', () => {
    const mons: MonitorSnapshot[] = [{ index: 0, x: 0, y: 0, width: 2560, height: 1440 }];
    expect(JSON.parse(serializeMonitors(mons))).toEqual(mons);
  });
});

describe('parseLayout', () => {
  it('parseia uma lista de comandos válida', () => {
    const json = '[{"id":1,"x":12,"y":12,"width":484,"height":776}]';
    expect(parseLayout(json)).toEqual([{ id: 1, x: 12, y: 12, width: 484, height: 776 }]);
  });

  it('retorna vazio para JSON inválido ou não-array', () => {
    expect(parseLayout('not json')).toEqual([]);
    expect(parseLayout('{"id":1}')).toEqual([]);
  });

  it('descarta entradas malformadas', () => {
    const json = '[{"id":1,"x":0,"y":0,"width":10,"height":10},{"id":"x"}]';
    expect(parseLayout(json)).toEqual([{ id: 1, x: 0, y: 0, width: 10, height: 10 }]);
  });

  it('lê os rects do formato objeto novo { rects, tab_bars }', () => {
    const json = '{"rects":[{"id":2,"x":1,"y":2,"width":3,"height":4}],"tab_bars":[]}';
    expect(parseLayout(json)).toEqual([{ id: 2, x: 1, y: 2, width: 3, height: 4 }]);
  });
});

describe('parseFloating', () => {
  it('lê as janelas flutuantes do formato objeto { floating }', () => {
    const json = JSON.stringify({
      rects: [],
      tab_bars: [],
      floating: [{ id: 7, x: 100, y: 50, width: 800, height: 600 }],
    });
    expect(parseFloating(json)).toEqual([{ id: 7, x: 100, y: 50, width: 800, height: 600 }]);
  });

  it('ausente (daemon antigo) → vazio', () => {
    expect(parseFloating('{"rects":[],"tab_bars":[]}')).toEqual([]);
  });

  it('formato legado (array) → vazio', () => {
    expect(parseFloating('[{"id":1,"x":0,"y":0,"width":1,"height":1}]')).toEqual([]);
  });

  it('descarta entradas malformadas e JSON inválido', () => {
    expect(parseFloating('not json')).toEqual([]);
    const json = '{"floating":[{"id":1,"x":0,"y":0,"width":10,"height":10},{"id":"x"}]}';
    expect(parseFloating(json)).toEqual([{ id: 1, x: 0, y: 0, width: 10, height: 10 }]);
  });
});

describe('estado de tiling por grupo e árvores (ids string)', () => {
  it('toggleGroupDisabled liga e desliga', () => {
    const disabled = new Set<string>();
    toggleGroupDisabled(disabled, orderKey(0, 1));
    expect(disabled.has(orderKey(0, 1))).toBe(true);
    toggleGroupDisabled(disabled, orderKey(0, 1));
    expect(disabled.has(orderKey(0, 1))).toBe(false);
  });

  it('serializeState traduz as folhas das árvores e os grupos desligados (sem stacks)', () => {
    const disabled = new Set<string>([orderKey(1, 2)]);
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const trees = new Map<string, TreeNode | null>([[orderKey(0, 0), { win: 'a' }]]);
    // Tiling puro (ADR 0028): `stacks` viaja vazio (compat); foco 'b' → 2.
    expect(JSON.parse(serializeState(disabled, transportOf, trees, 'b'))).toEqual({
      stacks: [],
      disabled_groups: [[1, 2]],
      trees: [{ monitor: 0, workspace: 0, root: { win: 1 } }],
      focused_id: 2,
    });
  });

  it('serializeState com estado vazio → JSON mínimo', () => {
    expect(JSON.parse(serializeState(new Set(), new Map(), new Map(), ''))).toEqual({
      stacks: [],
      disabled_groups: [],
      trees: [],
      focused_id: 0,
    });
  });

  it('árvore: nó `stack` legado COLAPSA para a folha do 1º membro traduzível (migração ADR 0028)', () => {
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const toStable = new Map<number, string>([
      [1, 'a'],
      [2, 'b'],
    ]);
    // Árvore antiga com um `stack` de 2 membros: a conversão colapsa no 1º membro (sem reconstruir).
    const legacy: TreeNode = { stack: { members: ['a', 'b'], active: 'b' } };
    expect(treeToTransport(legacy, transportOf)).toEqual({ win: 1 });
    // 'a' sem transporte → cai para o próximo membro traduzível ('b' → 2).
    expect(treeToTransport(legacy, new Map([['b', 2]]))).toEqual({ win: 2 });
    // Mesma migração na volta (transporte → internalId).
    const legacyT: TransportNode = { stack: { members: [1, 2], active: 2 } };
    expect(treeFromTransport(legacyT, toStable)).toEqual({ win: 'a' });
  });

  it('árvore: round-trip internalId ↔ transporte e colapso de célula intraduzível (grid)', () => {
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const toStable = new Map<number, string>([
      [1, 'a'],
      [2, 'b'],
    ]);
    // Grid de 2 colunas (split binário) — ADR 0028.
    const tree: TreeNode = {
      grid: {
        cols: [0.5, 0.5],
        rows: [1],
        cells: [
          { node: { win: 'a' }, col: 0, row: 0, col_span: 1, row_span: 1 },
          { node: { win: 'b' }, col: 1, row: 0, col_span: 1, row_span: 1 },
        ],
      },
    };
    const transport = treeToTransport(tree, transportOf);
    expect(transport).toEqual({
      grid: {
        cols: [0.5, 0.5],
        rows: [1],
        cells: [
          { node: { win: 1 }, col: 0, row: 0, col_span: 1, row_span: 1 },
          { node: { win: 2 }, col: 1, row: 0, col_span: 1, row_span: 1 },
        ],
      },
    });
    expect(treeFromTransport(transport as TransportNode, toStable)).toEqual(tree);
    // 'b' sem transporte → a célula cai e o grid ACHATA para a folha 'a' (o sobrevivente sobe).
    const partial = treeToTransport(tree, new Map([['a', 1]]));
    expect(partial).toEqual({ win: 1 });
  });

  it('parseLayoutTrees traduz transporte → internalId por grupo', () => {
    const toStable = new Map<number, string>([[1, 'a']]);
    const json = JSON.stringify({
      rects: [],
      trees: [{ monitor: 0, workspace: 0, root: { win: 1 } }],
    });
    const trees = parseLayoutTrees(json, toStable);
    expect(trees.get(orderKey(0, 0))).toEqual({ win: 'a' });
  });

  it('resizeDeltaFrom infere bordas e canto', () => {
    expect(resizeDeltaFrom({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 160, height: 50 })).toEqual([
      { edge: 'right', deltaPx: 60 },
    ]);
    expect(
      resizeDeltaFrom({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 140, height: 130 }),
    ).toEqual([
      { edge: 'right', deltaPx: 40 },
      { edge: 'bottom', deltaPx: 30 },
    ]);
  });

  it('serializeTarget devolve "" sem alvo e JSON com alvo', () => {
    expect(serializeTarget(null)).toBe('');
    expect(JSON.parse(serializeTarget({ x: 1, y: 2, width: 3, height: 4 }))).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });
});

describe('parsePreview', () => {
  it('parseia um preview válido', () => {
    const json = '{"zone":"right","x":504,"y":12,"width":484,"height":776}';
    expect(parsePreview(json)).toEqual({ zone: 'right', x: 504, y: 12, width: 484, height: 776 });
  });

  it('aceita zona "none" com retângulo zerado', () => {
    const json = '{"zone":"none","x":0,"y":0,"width":0,"height":0}';
    expect(parsePreview(json)).toEqual({ zone: 'none', x: 0, y: 0, width: 0, height: 0 });
  });

  it('retorna null para JSON inválido ou campos faltando', () => {
    expect(parsePreview('not json')).toBeNull();
    expect(parsePreview('{"zone":"left"}')).toBeNull();
    expect(parsePreview('{"zone":1,"x":0,"y":0,"width":0,"height":0}')).toBeNull();
  });
});

describe('ordem estável das janelas (ids string/internalId)', () => {
  it('append acrescenta sem duplicar e mantém ordem de chegada', () => {
    const order = new Map<string, string[]>();
    const key = orderKey(0, 0);
    appendToOrder(order, key, 'a');
    appendToOrder(order, key, 'b');
    appendToOrder(order, key, 'a'); // duplicata ignorada
    expect(order.get(key)).toEqual(['a', 'b']);
  });

  it('remove tira o id de todos os grupos e limpa grupos vazios', () => {
    const order = new Map<string, string[]>([
      ['0:0', ['a', 'b']],
      ['1:0', ['b']],
    ]);
    removeFromOrder(order, 'b');
    expect(order.get('0:0')).toEqual(['a']);
    expect(order.has('1:0')).toBe(false);
  });

  it('sortByOrder respeita a ordem registrada e joga ids novos para o fim', () => {
    const order = new Map<string, string[]>([['0:0', ['c', 'a', 'b']]]);
    expect(sortByOrder(order, '0:0', ['a', 'z', 'b', 'c'])).toEqual(['c', 'a', 'b', 'z']);
  });

  // ---- HUD dos "eixos limpos" (resolveHotZone — ADR 0028, tiling puro sem abas) ----
  const MON = { x: 0, y: 0, width: 900, height: 900 };
  const FULL = { x: 0, y: 0, width: 900, height: 900 }; // janela cobrindo o monitor
  const NOMIN = { width: 0, height: 0 }; // sem min-size → 50/50 puro

  it('miolo central de uma janela → SWAP (center local), outline = alvo inteiro', () => {
    const hz = resolveHotZone({ x: 450, y: 450 }, FULL, MON, NOMIN);
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('center');
    expect(hz.outline).toEqual(FULL);
  });

  it('fora do centro, lado esquerdo de uma janela → split 50/50 local (left)', () => {
    const hz = resolveHotZone({ x: 100, y: 450 }, FULL, MON, NOMIN);
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('left');
    expect(hz.outline).toEqual({ x: 0, y: 0, width: 450, height: 900 });
  });

  it('fora do centro, base de uma janela → split 50/50 local (bottom)', () => {
    const hz = resolveHotZone({ x: 450, y: 800 }, FULL, MON, NOMIN);
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('bottom');
    expect(hz.outline).toEqual({ x: 0, y: 450, width: 900, height: 450 });
  });

  it('min da arrastada ESTICA a metade local no eixo do split (ADR 0028)', () => {
    // Lado esquerdo (split horizontal); min de largura 600 > metade 450 → extent = 600 (≤ 95%).
    const hz = resolveHotZone({ x: 100, y: 450 }, FULL, MON, { width: 600, height: 0 });
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('left');
    expect(hz.outline).toEqual({ x: 0, y: 0, width: 600, height: 900 });
  });

  it('gap sem janela, borda da tela → global 50%', () => {
    const hz = resolveHotZone({ x: 10, y: 450 }, null, MON, NOMIN);
    expect(hz.scope).toBe('global');
    expect(hz.dropZone).toBe('left');
    expect(hz.outline).toEqual({ x: 0, y: 0, width: 450, height: 900 });
  });

  it('gap sem janela, miolo central da tela → maximizar (center global)', () => {
    const hz = resolveHotZone({ x: 450, y: 450 }, null, MON, NOMIN);
    expect(hz.scope).toBe('global');
    expect(hz.dropZone).toBe('center');
    expect(hz.outline).toEqual(MON);
  });

  it('serializeScope mapeia local/global', () => {
    expect(serializeScope('global')).toBe('global');
    expect(serializeScope('local')).toBe('local');
  });

  it('serializeHudCells marca a célula realçada e usa literais (sem object spread)', () => {
    const cells = [
      { x: 0, y: 0, width: 300, height: 300 },
      { x: 300, y: 0, width: 300, height: 300 },
    ];
    const json = serializeHudCells(cells, 1);
    expect(JSON.parse(json)).toEqual([
      { x: 0, y: 0, width: 300, height: 300, hot: false },
      { x: 300, y: 0, width: 300, height: 300, hot: true },
    ]);
  });
});
