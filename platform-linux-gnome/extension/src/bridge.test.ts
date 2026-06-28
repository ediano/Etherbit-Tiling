import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parseTabBars,
  parseLayoutTrees,
  parsePreview,
  resizeDeltaFrom,
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
  parseOrderKey,
  type Stack,
  type TreeNode,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';

const win: WindowSnapshot = {
  id: 42,
  app_id: 'kitty',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  normal: true,
  resizable: true,
  maximizable: true,
  monitor: 0,
  workspace: 1,
};

describe('serializeWindows / serializeMonitors', () => {
  it('produz JSON com os campos do contrato (espelho do DTO do daemon)', () => {
    const json = serializeWindows([win]);
    expect(JSON.parse(json)).toEqual([win]);
  });

  it('serializa monitores (áreas úteis)', () => {
    const mons: MonitorSnapshot[] = [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }];
    expect(JSON.parse(serializeMonitors(mons))).toEqual(mons);
  });
});

describe('parseLayout', () => {
  it('parseia uma lista de comandos válida', () => {
    const json = '[{"id":1,"x":12,"y":12,"width":484,"height":776}]';
    expect(parseLayout(json)).toEqual([{ id: 1, x: 12, y: 12, width: 484, height: 776 }]);
  });

  it('retorna vazio para JSON inválido', () => {
    expect(parseLayout('not json')).toEqual([]);
  });

  it('retorna vazio quando não é um array', () => {
    expect(parseLayout('{"id":1}')).toEqual([]);
  });

  it('descarta entradas malformadas (campos ausentes ou não numéricos)', () => {
    const json = '[{"id":1,"x":0,"y":0,"width":10,"height":10},{"id":"x"},{"x":1}]';
    expect(parseLayout(json)).toEqual([{ id: 1, x: 0, y: 0, width: 10, height: 10 }]);
  });

  it('descarta números não finitos', () => {
    // JSON não tem NaN/Infinity nativos; null cai fora do filtro numérico.
    expect(parseLayout('[{"id":1,"x":null,"y":0,"width":10,"height":10}]')).toEqual([]);
  });

  it('lê os rects do formato objeto novo { rects, tab_bars }', () => {
    const json = '{"rects":[{"id":1,"x":12,"y":40,"width":484,"height":748}],"tab_bars":[]}';
    expect(parseLayout(json)).toEqual([{ id: 1, x: 12, y: 40, width: 484, height: 748 }]);
  });
});

describe('parseTabBars', () => {
  const bar = {
    stack_id: 1,
    x: 12,
    y: 12,
    width: 976,
    height: 28,
    content: { x: 12, y: 40, width: 976, height: 748 },
    members: [1, 2, 3],
    active: 2,
  };

  it('parseia as barras de abas do formato objeto', () => {
    const json = JSON.stringify({ rects: [], tab_bars: [bar] });
    expect(parseTabBars(json)).toEqual([bar]);
  });

  it('formato legado (array) → sem barras', () => {
    expect(parseTabBars('[{"id":1,"x":0,"y":0,"width":1,"height":1}]')).toEqual([]);
  });

  it('descarta barra malformada (content ausente / members não numérico)', () => {
    const json = JSON.stringify({
      tab_bars: [{ ...bar, content: undefined }, { ...bar, members: ['x'] }],
    });
    expect(parseTabBars(json)).toEqual([]);
  });

  it('retorna vazio para JSON inválido', () => {
    expect(parseTabBars('not json')).toEqual([]);
  });
});

describe('estado de abas (stacks) e tiling por grupo', () => {
  it('parseOrderKey reverte orderKey', () => {
    expect(parseOrderKey(orderKey(2, 3))).toEqual([2, 3]);
  });

  it('toggleStackGroup empilha todos os ids e depois desfaz', () => {
    const stacks = new Map<string, Stack[]>();
    const key = orderKey(0, 0);
    expect(toggleStackGroup(stacks, key, [1, 2, 3], 2)).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: [1, 2, 3], active: 2 }]);
    // segunda chamada desfaz o grupo
    expect(toggleStackGroup(stacks, key, [1, 2, 3], 2)).toBe(true);
    expect(stacks.has(key)).toBe(false);
  });

  it('toggleStackGroup é no-op com menos de 2 janelas', () => {
    const stacks = new Map<string, Stack[]>();
    expect(toggleStackGroup(stacks, orderKey(0, 0), [1], 1)).toBe(false);
  });

  it('addToStack cria stack novo e depois adiciona à pilha do alvo', () => {
    const stacks = new Map<string, Stack[]>();
    const key = orderKey(0, 0);
    expect(addToStack(stacks, key, 1, 2)).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: [1, 2], active: 2 }]);
    // arrastar 3 sobre 1 (que já está no stack) adiciona 3 a ele e o torna ativo
    expect(addToStack(stacks, key, 1, 3)).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: [1, 2, 3], active: 3 }]);
  });

  it('addToStack move o arrastado de um stack anterior', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: [1, 2, 5], active: 1 }]]]);
    // arrasta 5 sobre 2... 5 sai do stack e volta (no-op de pertencimento), vira ativo
    expect(addToStack(stacks, orderKey(0, 0), 2, 5)).toBe(true);
    expect(stacks.get(orderKey(0, 0))).toEqual([{ members: [1, 2, 5], active: 5 }]);
  });

  it('setActiveMember muda a aba ativa do stack que contém o membro', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: [1, 2, 3], active: 1 }]]]);
    expect(setActiveMember(stacks, 3)).toBe(true);
    expect(stacks.get(orderKey(0, 0))?.[0]?.active).toBe(3);
    expect(setActiveMember(stacks, 3)).toBe(false); // já ativa
  });

  it('removeIdFromStacks dissolve stack que fica com 1 membro', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: [1, 2], active: 2 }]]]);
    expect(removeIdFromStacks(stacks, 2)).toBe(true);
    // sobrou 1 membro → stack dissolvido → grupo vazio removido
    expect(stacks.has(orderKey(0, 0))).toBe(false);
  });

  it('toggleGroupDisabled liga e desliga o grupo', () => {
    const disabled = new Set<string>();
    const key = orderKey(0, 1);
    toggleGroupDisabled(disabled, key);
    expect(disabled.has(key)).toBe(true);
    toggleGroupDisabled(disabled, key);
    expect(disabled.has(key)).toBe(false);
  });

  it('serializeState emite stacks (≥2 membros), grupos desligados, árvores e foco', () => {
    const stacks = new Map<string, Stack[]>([
      [orderKey(0, 0), [{ members: [1, 2], active: 2 }]],
      [orderKey(1, 0), [{ members: [9], active: 9 }]], // 1 membro → não serializa
    ]);
    const disabled = new Set<string>([orderKey(0, 1)]);
    const trees = new Map<string, TreeNode | null>([[orderKey(0, 0), { win: 7 }]]);
    expect(JSON.parse(serializeState(stacks, disabled, trees, 5))).toEqual({
      stacks: [{ monitor: 0, workspace: 0, members: [1, 2], active: 2 }],
      disabled_groups: [[0, 1]],
      trees: [{ monitor: 0, workspace: 0, root: { win: 7 } }],
      focused_id: 5,
    });
  });

  it('parseLayoutTrees lê as árvores por grupo e ignora entradas malformadas', () => {
    const json = JSON.stringify({
      rects: [],
      tab_bars: [],
      trees: [
        { monitor: 0, workspace: 0, root: { win: 3 } },
        { monitor: 1, workspace: 0, root: null },
        { workspace: 0, root: { win: 9 } }, // sem monitor → ignorada
      ],
    });
    const trees = parseLayoutTrees(json);
    expect(trees.get(orderKey(0, 0))).toEqual({ win: 3 });
    expect(trees.get(orderKey(1, 0))).toBeNull();
    expect(trees.size).toBe(2);
  });

  it('parseLayoutTrees é defensivo (JSON inválido → vazio)', () => {
    expect(parseLayoutTrees('not json').size).toBe(0);
    expect(parseLayoutTrees('{}').size).toBe(0);
  });

  it('resizeDeltaFrom infere borda direita (cresceu) e esquerda', () => {
    // Largura 100→160 com x fixo → borda direita cresceu 60.
    expect(resizeDeltaFrom({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 160, height: 50 })).toEqual([
      { edge: 'right', deltaPx: 60 },
    ]);
    // x 100→70, largura 100→130 → borda esquerda cresceu 30.
    expect(resizeDeltaFrom({ x: 100, y: 0, width: 100, height: 50 }, { x: 70, y: 0, width: 130, height: 50 })).toEqual([
      { edge: 'left', deltaPx: 30 },
    ]);
  });

  it('resizeDeltaFrom de canto devolve duas bordas', () => {
    const out = resizeDeltaFrom(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 140, height: 130 },
    );
    expect(out).toEqual([
      { edge: 'right', deltaPx: 40 },
      { edge: 'bottom', deltaPx: 30 },
    ]);
  });

  it('resizeDeltaFrom sem mudança → vazio', () => {
    expect(resizeDeltaFrom({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 })).toEqual([]);
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
    const json = '{"zone":"left","x":12,"y":12,"width":484,"height":776}';
    expect(parsePreview(json)).toEqual({ zone: 'left', x: 12, y: 12, width: 484, height: 776 });
  });

  it('aceita zona "none" com retângulo zerado (o chamador esconde o overlay)', () => {
    const json = '{"zone":"none","x":0,"y":0,"width":0,"height":0}';
    expect(parsePreview(json)).toEqual({ zone: 'none', x: 0, y: 0, width: 0, height: 0 });
  });

  it('retorna null para JSON inválido', () => {
    expect(parsePreview('not json')).toBeNull();
  });

  it('retorna null quando faltam campos numéricos', () => {
    expect(parsePreview('{"zone":"left"}')).toBeNull();
  });

  it('retorna null quando zone não é string', () => {
    expect(parsePreview('{"zone":1,"x":0,"y":0,"width":0,"height":0}')).toBeNull();
  });
});

describe('ordem estável das janelas', () => {
  it('append acrescenta sem duplicar e mantém ordem de chegada', () => {
    const order = new Map<string, number[]>();
    const key = orderKey(0, 1);
    appendToOrder(order, key, 10);
    appendToOrder(order, key, 20);
    appendToOrder(order, key, 10); // duplicata ignorada
    expect(order.get(key)).toEqual([10, 20]);
  });

  it('remove tira o id de todos os grupos e limpa grupos vazios', () => {
    const order = new Map<string, number[]>([
      ['0:0', [1, 2]],
      ['1:0', [2]],
    ]);
    removeFromOrder(order, 2);
    expect(order.get('0:0')).toEqual([1]);
    expect(order.has('1:0')).toBe(false);
  });

  it('sortByOrder respeita a ordem registrada e joga ids novos para o fim', () => {
    const order = new Map<string, number[]>([['0:1', [30, 10, 20]]]);
    // ids presentes em ordem arbitrária + um id novo (99) ainda não registrado
    expect(sortByOrder(order, '0:1', [10, 99, 20, 30])).toEqual([30, 10, 20, 99]);
  });
});
