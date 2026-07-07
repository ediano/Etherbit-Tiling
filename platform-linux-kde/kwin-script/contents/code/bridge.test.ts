import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  shouldSuppressSpawnMaximize,
  parseLayoutTrees,
  parsePreview,
  orderKey,
  appendToOrder,
  removeFromOrder,
  sortByOrder,
  serializeState,
  serializeTarget,
  toggleGroupDisabled,
  toggleAxisDisabled,
  treeToTransport,
  treeFromTransport,
  resizeDeltaFrom,
  resolveHotZone,
  serializeScope,
  parseTabBars,
  addToStack,
  removeIdFromStacks,
  isStackMember,
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

  it('arredonda coordenadas fracionárias de janela (escala HiDPI) para inteiros', () => {
    // Regressão real do log KDE: `frameGeometry` fracionário faria o daemon recusar o array inteiro.
    const frac: WindowSnapshot = {
      ...win,
      x: 2649.063230904885,
      y: 40.5,
      width: 1708.4,
      height: 1392.0,
      min_width: 300.9,
      min_height: 0,
    };
    const out = JSON.parse(serializeWindows([frac]))[0];
    expect([out.x, out.y, out.width, out.height, out.min_width]).toEqual([
      2649, 41, 1708, 1392, 301,
    ]);
    // Nenhum campo de pixel permanece fracionário.
    for (const v of [out.x, out.y, out.width, out.height, out.min_width, out.min_height]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('arredonda coordenadas fracionárias de monitor (clientArea sob escala) para inteiros', () => {
    const mons: MonitorSnapshot[] = [{ index: 0, x: 0, y: 0, width: 3440.9, height: 1439.6 }];
    const out = JSON.parse(serializeMonitors(mons))[0];
    expect([out.x, out.y, out.width, out.height]).toEqual([0, 0, 3441, 1440]);
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

describe('shouldSuppressSpawnMaximize', () => {
  it('nunca suprime com o Tiling desligado nem quando não está maximizada', () => {
    expect(
      shouldSuppressSpawnMaximize({
        enabled: false,
        isMaximized: true,
        everTiled: false,
        withinSpawnGrace: true,
      }),
    ).toBe(false);
    expect(
      shouldSuppressSpawnMaximize({
        enabled: true,
        isMaximized: false,
        everTiled: false,
        withinSpawnGrace: true,
      }),
    ).toBe(false);
  });

  it('suprime a nascida maximizada nunca tilada; dentro da graça suprime mesmo já tilada', () => {
    expect(
      shouldSuppressSpawnMaximize({
        enabled: true,
        isMaximized: true,
        everTiled: false,
        withinSpawnGrace: false,
      }),
    ).toBe(true);
    expect(
      shouldSuppressSpawnMaximize({
        enabled: true,
        isMaximized: true,
        everTiled: true,
        withinSpawnGrace: true,
      }),
    ).toBe(true);
  });

  it('preserva a maximização MANUAL: já tilada e fora da graça → não suprime', () => {
    expect(
      shouldSuppressSpawnMaximize({
        enabled: true,
        isMaximized: true,
        everTiled: true,
        withinSpawnGrace: false,
      }),
    ).toBe(false);
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

  it('toggleAxisDisabled desliga o eixo inteiro quando algum está ligado', () => {
    const disabled = new Set<string>();
    const keys = [orderKey('DP-1', 0), orderKey('DP-1', 1), orderKey('DP-1', 2)];
    // Nenhum desligado → desliga todos (retorna true = eixo ficou DESLIGADO).
    expect(toggleAxisDisabled(disabled, keys)).toBe(true);
    expect(keys.every((k) => disabled.has(k))).toBe(true);
  });

  it('toggleAxisDisabled religa o eixo inteiro só quando TODOS estão desligados', () => {
    const keys = [orderKey('DP-1', 0), orderKey('DP-1', 1)];
    const disabled = new Set<string>(keys);
    // Todos desligados → religa todos (retorna false = eixo ficou LIGADO).
    expect(toggleAxisDisabled(disabled, keys)).toBe(false);
    expect(keys.some((k) => disabled.has(k))).toBe(false);
  });

  it('toggleAxisDisabled com eixo parcial desliga o restante (não religa)', () => {
    const keys = [orderKey('DP-1', 0), orderKey('DP-1', 1)];
    const disabled = new Set<string>([orderKey('DP-1', 0)]); // só um desligado
    expect(toggleAxisDisabled(disabled, keys)).toBe(true);
    expect(keys.every((k) => disabled.has(k))).toBe(true);
  });

  it('toggleAxisDisabled com keys vazio é no-op', () => {
    const disabled = new Set<string>([orderKey('DP-1', 0)]);
    expect(toggleAxisDisabled(disabled, [])).toBe(false);
    expect(disabled.has(orderKey('DP-1', 0))).toBe(true);
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
    // ADR 0056: as chaves usam o token de monitor (aqui "0"/"1"); `nameToIndex` traduz para o índice do
    // contrato do core. Com "0"→0 e "1"→1 os DTOs saem idênticos ao contrato anterior por índice.
    const nameToIndex = new Map<string, number>([
      ['0', 0],
      ['1', 1],
    ]);
    expect(
      JSON.parse(serializeState(stacks, disabled, transportOf, trees, 'b', nameToIndex)),
    ).toEqual({
      stacks: [{ monitor: 0, workspace: 0, members: [1, 2], active: 2 }],
      disabled_groups: [[1, 2]],
      trees: [{ monitor: 0, workspace: 0, root: { win: 1 } }],
      focused_id: 2,
      mins: [], // sem mins no caminho de sync (ADR 0064; só o resize popula)
    });
  });

  it('serializeState com estado vazio → JSON mínimo', () => {
    expect(
      JSON.parse(serializeState(new Map(), new Set(), new Map(), new Map(), '', new Map())),
    ).toEqual({
      stacks: [],
      disabled_groups: [],
      trees: [],
      focused_id: 0,
      mins: [],
    });
  });

  it('serializeState traduz os mins stable→transport e omite ids sem transporte (ADR 0064)', () => {
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const mins = [
      { stableId: 'a', min_width: 600, min_height: 0 },
      { stableId: 'b', min_width: 0, min_height: 500 },
      { stableId: 'ghost', min_width: 400, min_height: 0 }, // sem transporte → omitido
      { stableId: 'a', min_width: 0, min_height: 0 }, // min 0 → omitido
    ];
    const out = JSON.parse(
      serializeState(new Map(), new Set(), transportOf, new Map(), '', new Map(), mins),
    );
    expect(out.mins).toEqual([
      { id: 1, min_width: 600, min_height: 0 },
      { id: 2, min_width: 0, min_height: 500 },
    ]);
  });

  it('serializeState OMITE grupos de monitor DESCONECTADO (nome ausente no mapa) — ADR 0056', () => {
    // Estado da ponte tem árvores em dois monitores por NOME; só "DP-1" está conectado agora.
    const trees = new Map<string, TreeNode | null>([
      [orderKey('DP-1', 0), { win: 'a' }],
      [orderKey('HDMI-1', 0), { win: 'b' }],
    ]);
    const transportOf = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const nameToIndex = new Map<string, number>([['DP-1', 0]]); // HDMI-1 desconectado
    const out = JSON.parse(
      serializeState(new Map(), new Set(), transportOf, trees, '', nameToIndex),
    );
    // Só o grupo do monitor conectado viaja; o de "HDMI-1" fica preservado na ponte (não some).
    expect(out.trees).toEqual([{ monitor: 0, workspace: 0, root: { win: 1 } }]);
  });

  it('estado por NOME sobrevive à REORDENAÇÃO de índice do monitor (hotplug) — ADR 0056', () => {
    // Árvore ancorada em "DP-1". Numa 1ª ordem, DP-1=índice 0; depois de reordenar, DP-1=índice 1.
    const trees = new Map<string, TreeNode | null>([[orderKey('DP-1', 0), { win: 'a' }]]);
    const transportOf = new Map<string, number>([['a', 1]]);
    const before = JSON.parse(
      serializeState(new Map(), new Set(), transportOf, trees, '', new Map([['DP-1', 0]])),
    );
    const after = JSON.parse(
      serializeState(
        new Map(),
        new Set(),
        transportOf,
        trees,
        '',
        new Map([
          ['HDMI-1', 0],
          ['DP-1', 1],
        ]),
      ),
    );
    // A MESMA árvore de DP-1 é enviada ao índice 0 antes e ao índice 1 depois — sem trocar de tela.
    expect(before.trees).toEqual([{ monitor: 0, workspace: 0, root: { win: 1 } }]);
    expect(after.trees).toEqual([{ monitor: 1, workspace: 0, root: { win: 1 } }]);
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

  it('parseLayoutTrees traduz transporte → internalId e o índice do core → chave por NOME (ADR 0056)', () => {
    const toStable = new Map<number, string>([[1, 'a']]);
    // O core devolve o índice numérico do monitor (0); `indexToName` o traduz para "DP-1".
    const indexToName = new Map<number, string>([[0, 'DP-1']]);
    const json = JSON.stringify({
      rects: [],
      trees: [{ monitor: 0, workspace: 0, root: { win: 1 } }],
    });
    const trees = parseLayoutTrees(json, toStable, indexToName);
    expect(trees.get(orderKey('DP-1', 0))).toEqual({ win: 'a' });
  });

  it('round-trip serialize→core→parse mantém a árvore presa ao NOME após reordenar (ADR 0056)', () => {
    // DP-1 começa no índice 0; a árvore é serializada, o "core" devolve o mesmo índice, e o parse a
    // reancora em "DP-1". Depois de um hotplug (DP-1 vira índice 1), o parse do retorno do core (índice
    // 1 → "DP-1") mantém a chave "DP-1:0" — a árvore nunca migra de tela.
    const transportOf = new Map<string, number>([['a', 1]]);
    const toStable = new Map<number, string>([[1, 'a']]);
    const treesByName = new Map<string, TreeNode | null>([[orderKey('DP-1', 0), { win: 'a' }]]);

    const sent0 = JSON.parse(
      serializeState(new Map(), new Set(), transportOf, treesByName, '', new Map([['DP-1', 0]])),
    );
    const back0 = parseLayoutTrees(
      JSON.stringify({ trees: sent0.trees }),
      toStable,
      new Map([[0, 'DP-1']]),
    );
    expect(back0.get(orderKey('DP-1', 0))).toEqual({ win: 'a' });

    const sent1 = JSON.parse(
      serializeState(
        new Map(),
        new Set(),
        transportOf,
        treesByName,
        '',
        new Map([
          ['HDMI-1', 0],
          ['DP-1', 1],
        ]),
      ),
    );
    const back1 = parseLayoutTrees(
      JSON.stringify({ trees: sent1.trees }),
      toStable,
      new Map([
        [0, 'HDMI-1'],
        [1, 'DP-1'],
      ]),
    );
    expect(back1.get(orderKey('DP-1', 0))).toEqual({ win: 'a' });
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

  it('resizeDeltaFrom arredonda deltas fracionários (escala HiDPI) para inteiros', () => {
    // Sob escala fracionária os diffs de frameGeometry seriam fracionários; deltaPx deve sair inteiro
    // (o daemon espera i32). E um diff que arredonda a 0 não gera aresta.
    const out = resizeDeltaFrom(
      { x: 0, y: 0, width: 100.0, height: 100.0 },
      { x: 0, y: 0, width: 140.4, height: 100.2 },
    );
    expect(out).toEqual([{ edge: 'right', deltaPx: 40 }]);
    for (const d of out) {
      expect(Number.isInteger(d.deltaPx)).toBe(true);
    }
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

  it('isStackMember detecta membro em qualquer grupo, sem mutar (ADR 0047)', () => {
    const stacks = new Map<string, Stack[]>([
      [orderKey(0, 0), [{ members: ['a', 'b'], active: 'b' }]],
      [orderKey(1, 0), [{ members: ['h', 'i'], active: 'h' }]], // outro monitor/workspace
    ]);
    expect(isStackMember(stacks, 'a')).toBe(true); // membro do 1º grupo
    expect(isStackMember(stacks, 'i')).toBe(true); // membro de OUTRO grupo
    expect(isStackMember(stacks, 'z')).toBe(false); // janela solta (não agrupada)
    // read-only: o Map não muda
    expect(stacks.get(orderKey(0, 0))).toEqual([{ members: ['a', 'b'], active: 'b' }]);
    expect(stacks.size).toBe(2);
  });

  it('isStackMember é false para Map vazio', () => {
    expect(isStackMember(new Map<string, Stack[]>(), 'a')).toBe(false);
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
      // ungroup_drag carrega coords globais de soltura (ADR 0042).
      { stack_id: 's', member_id: 'e', kind: 'ungroup_drag', x: 640, y: 360 },
      { stack_id: 's', member_id: 'd', kind: 'explode' }, // kind inválido → descartado
      { stack_id: 's', kind: 'close' }, // sem member_id → descartado
    ]);
    const actions = parseTabActions(json);
    expect(actions).toEqual([
      { stack_id: 's', member_id: 'a', kind: 'activate', x: 0, y: 0 },
      { stack_id: 's', member_id: 'b', kind: 'close', x: 0, y: 0 },
      { stack_id: 's', member_id: 'c', kind: 'ungroup', x: 0, y: 0 },
      { stack_id: 's', member_id: 'e', kind: 'ungroup_drag', x: 640, y: 360 },
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
