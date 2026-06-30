import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parseCollisions,
  collisionKey,
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
  parseTabBars,
  addToStack,
  removeIdFromStacks,
  setActiveMember,
  toggleStackGroup,
  buildTabBarViews,
  serializeTabBars,
  parseTabActions,
  type Stack,
  type TabBar,
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

describe('parseCollisions', () => {
  it('lê os grupos de colisão do formato objeto { collisions }', () => {
    const json = JSON.stringify({
      rects: [],
      tab_bars: [],
      collisions: [{ cell_id: 1, members: [1, 2] }],
    });
    expect(parseCollisions(json)).toEqual([{ cellId: 1, members: [1, 2] }]);
  });

  it('ausente (daemon antigo = comportamento 0040) → vazio', () => {
    expect(parseCollisions('{"rects":[],"tab_bars":[]}')).toEqual([]);
  });

  it('formato legado (array) → vazio', () => {
    expect(parseCollisions('[{"cell_id":1,"members":[1,2]}]')).toEqual([]);
  });

  it('descarta grupos com < 2 membros e entradas malformadas, e JSON inválido', () => {
    expect(parseCollisions('not json')).toEqual([]);
    const json = JSON.stringify({
      collisions: [
        { cell_id: 1, members: [1] }, // < 2 → descartado (nada a agrupar)
        { cell_id: 2, members: [3, 4] }, // ok
        { cell_id: 'x', members: [5, 6] }, // cell_id inválido → descartado
        { members: [7, 8] }, // sem cell_id → descartado
      ],
    });
    expect(parseCollisions(json)).toEqual([{ cellId: 2, members: [3, 4] }]);
  });
});

describe('collisionKey', () => {
  it('é ordem-insensível sobre ids estáveis (string)', () => {
    expect(collisionKey(['w2', 'w1'])).toBe(collisionKey(['w1', 'w2']));
    expect(collisionKey(['w1', 'w2'])).toBe('w1,w2');
  });

  it('distingue conjuntos diferentes', () => {
    expect(collisionKey(['w1', 'w2'])).not.toBe(collisionKey(['w1', 'w3']));
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

  it('serializeState traduz as folhas das árvores, os stacks reais e os grupos desligados', () => {
    const disabled = new Set<string>([orderKey(1, 2)]);
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const trees = new Map<string, TreeNode | null>([[orderKey(0, 0), { win: 'a' }]]);
    const stacks = new Map<string, Stack[]>([
      [orderKey(0, 0), [{ members: ['a', 'b'], active: 'b' }]],
    ]);
    // ADR 0033: os stacks reais (≥ 2 membros traduzíveis) viajam para o core materializar; foco 'b' → 2.
    expect(JSON.parse(serializeState(stacks, disabled, transportOf, trees, 'b'))).toEqual({
      stacks: [{ monitor: 0, workspace: 0, members: [1, 2], active: 2 }],
      disabled_groups: [[1, 2]],
      trees: [{ monitor: 0, workspace: 0, root: { win: 1 } }],
      focused_id: 2,
    });
  });

  it('serializeState com estado vazio → JSON mínimo', () => {
    expect(JSON.parse(serializeState(new Map(), new Set(), new Map(), new Map(), ''))).toEqual({
      stacks: [],
      disabled_groups: [],
      trees: [],
      focused_id: 0,
    });
  });

  it('árvore: nó `stack` é PRESERVADO na tradução; poda membros sem transporte (ADR 0033)', () => {
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const toStable = new Map<number, string>([
      [1, 'a'],
      [2, 'b'],
    ]);
    // Stack de 2 membros: a conversão PRESERVA o stack (não colapsa) com `active` traduzido.
    const node: TreeNode = { stack: { members: ['a', 'b'], active: 'b' } };
    expect(treeToTransport(node, transportOf)).toEqual({ stack: { members: [1, 2], active: 2 } });
    // 'a' sem transporte → resta só 'b' (1 membro) → colapsa na folha do sobrevivente.
    expect(treeToTransport(node, new Map([['b', 2]]))).toEqual({ win: 2 });
    // Mesma preservação na volta (transporte → internalId).
    const nodeT: TransportNode = { stack: { members: [1, 2], active: 2 } };
    expect(treeFromTransport(nodeT, toStable)).toEqual({
      stack: { members: ['a', 'b'], active: 'b' },
    });
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
    expect(
      resizeDeltaFrom(
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 0, y: 0, width: 160, height: 50 },
      ),
    ).toEqual([{ edge: 'right', deltaPx: 60 }]);
    expect(
      resizeDeltaFrom(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 140, height: 130 },
      ),
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
});

describe('Merge Fallback / abas (ADR 0033, paridade com GNOME — ids string)', () => {
  const key = orderKey(0, 0);

  it('addToStack cria stack [target, dragged] com o arrastado ativo', () => {
    const stacks = new Map<string, Stack[]>();
    expect(addToStack(stacks, key, 'a', 'b')).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: ['a', 'b'], active: 'b' }]);
    // Adicionar 'c' ao stack que já contém 'a' → entra no mesmo stack e vira ativo.
    expect(addToStack(stacks, key, 'a', 'c')).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: ['a', 'b', 'c'], active: 'c' }]);
  });

  it('removeIdFromStacks dissolve o stack que fica com < 2 membros', () => {
    const stacks = new Map<string, Stack[]>([[key, [{ members: ['a', 'b'], active: 'b' }]]]);
    expect(removeIdFromStacks(stacks, 'b')).toBe(true);
    expect(stacks.has(key)).toBe(false); // sobrou 1 membro → dissolve, grupo vazio removido
  });

  it('setActiveMember troca a aba ativa do stack que contém o membro', () => {
    const stacks = new Map<string, Stack[]>([[key, [{ members: ['a', 'b'], active: 'b' }]]]);
    expect(setActiveMember(stacks, 'a')).toBe(true);
    expect(stacks.get(key)?.[0]?.active).toBe('a');
    expect(setActiveMember(stacks, 'a')).toBe(false); // já ativa → sem mudança
  });

  it('parseTabBars lê as barras do layout_json (objeto) e descarta malformadas', () => {
    const json = JSON.stringify({
      rects: [],
      tab_bars: [
        {
          stack_id: 1,
          x: 0,
          y: 0,
          width: 400,
          height: 28,
          content: { x: 0, y: 28, width: 400, height: 372 },
          members: [1, 2],
          active: 2,
        },
        { stack_id: 9 }, // malformada → descartada
      ],
    });
    const bars = parseTabBars(json);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.members).toEqual([1, 2]);
    expect(bars[0]?.active).toBe(2);
    // Formato legado (array) → sem barras.
    expect(parseTabBars('[]')).toEqual([]);
  });
});

describe('barras de abas visuais (ADR 0039 — helper de overlay)', () => {
  const bar = (members: number[], active: number, stackId = members[0] ?? 0): TabBar => ({
    stack_id: stackId,
    x: 10,
    y: 20,
    width: 300,
    height: 28,
    content: { x: 10, y: 48, width: 300, height: 300 },
    members,
    active,
  });

  it('buildTabBarViews traduz transporte→estável, injeta título e marca a ativa', () => {
    const toStable = new Map<number, string>([
      [1, 'uuid-a'],
      [2, 'uuid-b'],
    ]);
    const titleOf = (sid: string) => (sid === 'uuid-a' ? 'Firefox' : 'Konsole');
    const views = buildTabBarViews([bar([1, 2], 2)], toStable, titleOf);
    expect(views).toHaveLength(1);
    expect(views[0]?.stack_id).toBe('uuid-a');
    expect(views[0]?.x).toBe(10);
    expect(views[0]?.w).toBe(300);
    expect(views[0]?.tabs).toEqual([
      { member_id: 'uuid-a', title: 'Firefox', active: false },
      { member_id: 'uuid-b', title: 'Konsole', active: true },
    ]);
  });

  it('buildTabBarViews pula membros sem tradução e descarta barra sem abas', () => {
    const toStable = new Map<number, string>([[2, 'uuid-b']]); // 1 não traduz
    const views = buildTabBarViews([bar([1, 2], 2), bar([7, 8], 7)], toStable, () => 't');
    // 1ª barra fica só com o membro 2; 2ª barra (7,8) não traduz nenhum → descartada.
    expect(views).toHaveLength(1);
    expect(views[0]?.tabs).toEqual([{ member_id: 'uuid-b', title: 't', active: true }]);
    // stack_id cai para o 1º membro traduzível quando o stack_id não traduz.
    expect(views[0]?.stack_id).toBe('uuid-b');
  });

  it('serializeTabBars produz JSON consumível pelo helper (ShowTabs)', () => {
    const json = serializeTabBars([
      {
        stack_id: 's',
        x: 1,
        y: 2,
        w: 3,
        h: 4,
        tabs: [{ member_id: 's', title: 'T', active: true }],
      },
    ]);
    expect(JSON.parse(json)).toEqual([
      {
        stack_id: 's',
        x: 1,
        y: 2,
        w: 3,
        h: 4,
        tabs: [{ member_id: 's', title: 'T', active: true }],
      },
    ]);
  });

  it('parseTabActions lê ações válidas e descarta kind desconhecido/malformado', () => {
    const json = JSON.stringify([
      { stack_id: 's', member_id: 'a', kind: 'activate' },
      { stack_id: 's', member_id: 'b', kind: 'close' },
      { stack_id: 's', member_id: 'c', kind: 'ungroup' },
      { stack_id: 's', member_id: 'd', kind: 'explode' }, // kind inválido → descartado
      { stack_id: 's', kind: 'close' }, // sem member_id → descartado
    ]);
    const actions = parseTabActions(json);
    expect(actions).toEqual([
      { stack_id: 's', member_id: 'a', kind: 'activate' },
      { stack_id: 's', member_id: 'b', kind: 'close' },
      { stack_id: 's', member_id: 'c', kind: 'ungroup' },
    ]);
    // JSON inválido / não-array → vazio.
    expect(parseTabActions('{')).toEqual([]);
    expect(parseTabActions('{"x":1}')).toEqual([]);
  });

  it('toggleStackGroup agrupa todas as janelas e depois desfaz', () => {
    const stacks = new Map<string, Stack[]>();
    const key = orderKey(0, 0);
    // Agrupa as 3 janelas numa aba, ativando a 2ª.
    expect(toggleStackGroup(stacks, key, ['a', 'b', 'c'], 'b')).toBe(true);
    expect(stacks.get(key)).toEqual([{ members: ['a', 'b', 'c'], active: 'b' }]);
    // Chamar de novo desfaz (remove a chave).
    expect(toggleStackGroup(stacks, key, ['a', 'b', 'c'], 'b')).toBe(true);
    expect(stacks.has(key)).toBe(false);
    // Menos de 2 janelas não agrupa.
    expect(toggleStackGroup(stacks, key, ['a'], 'a')).toBe(false);
  });

  it('toggleStackGroup cai para o 1º id quando o ativo não está no grupo', () => {
    const stacks = new Map<string, Stack[]>();
    const key = orderKey(0, 0);
    expect(toggleStackGroup(stacks, key, ['a', 'b'], 'z')).toBe(true);
    expect(stacks.get(key)?.[0]?.active).toBe('a');
  });
});
