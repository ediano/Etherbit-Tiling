import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parseTabBars,
  parseLayoutTrees,
  parsePreview,
  orderKey,
  appendToOrder,
  removeFromOrder,
  sortByOrder,
  serializeState,
  serializeTarget,
  removeIdFromStacks,
  toggleStackGroup,
  addToStack,
  setActiveMember,
  toggleGroupDisabled,
  treeToTransport,
  treeFromTransport,
  resizeDeltaFrom,
  type Stack,
  type TreeNode,
  type TransportNode,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';

const win: WindowSnapshot = {
  id: 7,
  app_id: 'konsole',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  normal: true,
  resizable: true,
  maximizable: true,
  monitor: 0,
  workspace: 0,
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

describe('parseTabBars', () => {
  const bar = {
    stack_id: 7,
    x: 12,
    y: 12,
    width: 976,
    height: 28,
    content: { x: 12, y: 40, width: 976, height: 748 },
    members: [7, 8],
    active: 8,
  };

  it('parseia as barras do formato objeto', () => {
    expect(parseTabBars(JSON.stringify({ rects: [], tab_bars: [bar] }))).toEqual([bar]);
  });

  it('formato legado (array) → sem barras', () => {
    expect(parseTabBars('[{"id":1,"x":0,"y":0,"width":1,"height":1}]')).toEqual([]);
  });

  it('descarta barra malformada', () => {
    expect(parseTabBars(JSON.stringify({ tab_bars: [{ ...bar, members: ['x'] }] }))).toEqual([]);
  });
});

describe('estado de abas (stacks, ids string) e tiling por grupo', () => {
  it('toggleStackGroup empilha e desfaz (ids internalId)', () => {
    const stacks = new Map<string, Stack[]>();
    const key = orderKey(0, 0);
    expect(toggleStackGroup(stacks, key, ['a', 'b', 'c'], 'b')).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: ['a', 'b', 'c'], active: 'b' }]);
    expect(toggleStackGroup(stacks, key, ['a', 'b', 'c'], 'b')).toBe(true);
    expect(stacks.has(key)).toBe(false);
  });

  it('addToStack cria e depois adiciona à pilha do alvo', () => {
    const stacks = new Map<string, Stack[]>();
    const key = orderKey(0, 0);
    expect(addToStack(stacks, key, 'a', 'b')).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: ['a', 'b'], active: 'b' }]);
    expect(addToStack(stacks, key, 'a', 'c')).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: ['a', 'b', 'c'], active: 'c' }]);
  });

  it('setActiveMember muda a aba ativa', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: ['a', 'b'], active: 'a' }]]]);
    expect(setActiveMember(stacks, 'b')).toBe(true);
    expect(stacks.get(orderKey(0, 0))?.[0]?.active).toBe('b');
  });

  it('removeIdFromStacks dissolve stack que fica com 1 membro', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: ['a', 'b'], active: 'b' }]]]);
    expect(removeIdFromStacks(stacks, 'b')).toBe(true);
    expect(stacks.has(orderKey(0, 0))).toBe(false);
  });

  it('toggleGroupDisabled liga e desliga', () => {
    const disabled = new Set<string>();
    toggleGroupDisabled(disabled, orderKey(0, 1));
    expect(disabled.has(orderKey(0, 1))).toBe(true);
    toggleGroupDisabled(disabled, orderKey(0, 1));
    expect(disabled.has(orderKey(0, 1))).toBe(false);
  });

  it('serializeState traduz internalId → id de transporte e ignora membros ausentes', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: ['a', 'b', 'z'], active: 'b' }]]]);
    const disabled = new Set<string>([orderKey(1, 2)]);
    // 'z' não tem transporte → fica de fora; sobra [1,2], ativa 'b'→2.
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const trees = new Map<string, TreeNode | null>([[orderKey(0, 0), { win: 'a' }]]);
    expect(JSON.parse(serializeState(stacks, disabled, transportOf, trees, 'b'))).toEqual({
      stacks: [{ monitor: 0, workspace: 0, members: [1, 2], active: 2 }],
      disabled_groups: [[1, 2]],
      trees: [{ monitor: 0, workspace: 0, root: { win: 1 } }],
      focused_id: 2,
    });
  });

  it('serializeState omite stack que fica com < 2 membros traduzíveis', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: ['a', 'z'], active: 'a' }]]]);
    const transportOf = new Map<string, number>([['a', 1]]);
    expect(JSON.parse(serializeState(stacks, new Set(), transportOf, new Map(), ''))).toEqual({
      stacks: [],
      disabled_groups: [],
      trees: [],
      focused_id: 0,
    });
  });

  it('árvore: round-trip internalId ↔ transporte e colapso de folha intraduzível', () => {
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const toStable = new Map<number, string>([
      [1, 'a'],
      [2, 'b'],
    ]);
    const tree: TreeNode = {
      split: { axis: 'h', ratio: 0.5, first: { win: 'a' }, second: { win: 'b' } },
    };
    const transport = treeToTransport(tree, transportOf);
    expect(transport).toEqual({
      split: { axis: 'h', ratio: 0.5, first: { win: 1 }, second: { win: 2 } },
    });
    expect(treeFromTransport(transport as TransportNode, toStable)).toEqual(tree);
    // 'b' sem transporte → o nó colapsa para a folha 'a'.
    const partial = treeToTransport(tree, new Map([['a', 1]]));
    expect(partial).toEqual({ win: 1 });
  });

  it('parseLayoutTrees traduz transporte → internalId por grupo', () => {
    const toStable = new Map<number, string>([[1, 'a']]);
    const json = JSON.stringify({
      rects: [],
      tab_bars: [],
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
});
