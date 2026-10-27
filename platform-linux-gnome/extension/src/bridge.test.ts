import { describe, it, expect } from 'vitest';

import {
  transientPlacement,
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parseTabBars,
  shouldSuppressSpawnMaximize,
  clampGeometry,
  clampToWorkArea,
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
  isStackMember,
  toggleStackGroup,
  addToStack,
  setActiveMember,
  toggleGroupDisabled,
  parseOrderKey,
  resolveHotZone,
  serializeScope,
  isResizable,
  isFixedSize,
  capMinSize,
  effectiveMinSize,
  recordAcceptedFrame,
  geometryConverged,
  neighborInDirection,
  directionZone,
  pushFocus,
  pickInsertAnchor,
  remapMonitors,
  isIdentityRemap,
  remapGroupMap,
  remapGroupSet,
  cycleStackActive,
  toggleFloating,
  swapInStacks,
  sizeRefused,
  containedIn,
  centerInSlot,
  refusalAction,
  type Stack,
  type TreeNode,
  type WindowSnapshot,
  type MonitorSnapshot,
  type Rect,
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
  min_width: 0,
  min_height: 0,
  maximized: false,
  title: 'kitty',
  transient: false,
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

describe('isResizable / isFixedSize (ADR 0037)', () => {
  it('resizeable=true do Mutter é confiável (caminho rápido), mesmo com min==max', () => {
    // Não derruba o caminho rápido: se o Mutter já diz "sim", tila — ainda que os hints pareçam fixos.
    expect(
      isResizable({
        rawResizeable: true,
        minWidth: 400,
        minHeight: 300,
        maxWidth: 400,
        maxHeight: 300,
      }),
    ).toBe(true);
  });

  it('resizeable=false + min==max>0 em ambos os eixos → não-redimensionável (diálogo fixo real)', () => {
    expect(
      isResizable({
        rawResizeable: false,
        minWidth: 400,
        minHeight: 300,
        maxWidth: 400,
        maxHeight: 300,
      }),
    ).toBe(false);
  });

  it('resizeable=false + min != max → redimensionável (estado-dependente: maximizada/fullscreen)', () => {
    expect(
      isResizable({
        rawResizeable: false,
        minWidth: 200,
        minHeight: 100,
        maxWidth: 1920,
        maxHeight: 1080,
      }),
    ).toBe(true);
  });

  it('resizeable=false + sem teto (max==0) → redimensionável (paridade Cosmic)', () => {
    // Caso típico da 1ª janela: nasce preenchendo a tela, get_max_size ausente/[0,0].
    expect(
      isResizable({ rawResizeable: false, minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0 }),
    ).toBe(true);
  });

  it('travar só um eixo (min==max num eixo, livre no outro) → redimensionável', () => {
    expect(
      isResizable({
        rawResizeable: false,
        minWidth: 400,
        minHeight: 100,
        maxWidth: 400,
        maxHeight: 800,
      }),
    ).toBe(true);
    expect(isFixedSize({ minWidth: 400, minHeight: 100, maxWidth: 400, maxHeight: 800 })).toBe(
      false,
    );
  });

  it('isFixedSize: ambos os eixos travados com max>0 → fixo; max==0 → não-fixo', () => {
    expect(isFixedSize({ minWidth: 500, minHeight: 400, maxWidth: 500, maxHeight: 400 })).toBe(
      true,
    );
    expect(isFixedSize({ minWidth: 500, minHeight: 400, maxWidth: 0, maxHeight: 0 })).toBe(false);
  });
});

describe('effectiveMinSize (memoização do min degradado por minimização)', () => {
  it('grava e devolve o min real quando a janela está visível e min>0', () => {
    const cache = new Map<number, [number, number]>();
    expect(effectiveMinSize(cache, 1, [700, 500], false)).toEqual([700, 500]);
    expect(cache.get(1)).toEqual([700, 500]);
  });

  it('devolve o memoizado quando minimizada (get_min_size degrada para 0,0)', () => {
    const cache = new Map<number, [number, number]>([[1, [700, 500]]]);
    expect(effectiveMinSize(cache, 1, [0, 0], true)).toEqual([700, 500]);
    // não sobrescreve o cache com o valor degradado.
    expect(cache.get(1)).toEqual([700, 500]);
  });

  it('fallback [0,0] quando minimizada e sem histórico', () => {
    const cache = new Map<number, [number, number]>();
    expect(effectiveMinSize(cache, 9, [0, 0], true)).toEqual([0, 0]);
    expect(cache.has(9)).toBe(false);
  });

  it('não grava min zerado de janela visível (não polui o cache)', () => {
    const cache = new Map<number, [number, number]>();
    expect(effectiveMinSize(cache, 2, [0, 0], false)).toEqual([0, 0]);
    expect(cache.has(2)).toBe(false);
  });

  it('atualiza o cache quando a janela volta a ficar visível com novo min', () => {
    const cache = new Map<number, [number, number]>([[1, [700, 500]]]);
    expect(effectiveMinSize(cache, 1, [640, 480], false)).toEqual([640, 480]);
    expect(cache.get(1)).toEqual([640, 480]);
  });
});

describe('recordAcceptedFrame / capMinSize (min limitado ao frame aceito)', () => {
  it('guarda o menor frame aceito por eixo', () => {
    const frames = new Map<number, [number, number]>();
    recordAcceptedFrame(frames, 1, [800, 300]);
    recordAcceptedFrame(frames, 1, [600, 500]);
    expect(frames.get(1)).toEqual([600, 300]);
  });

  it('ignora frame degenerado', () => {
    const frames = new Map<number, [number, number]>();
    recordAcceptedFrame(frames, 1, [0, 300]);
    expect(frames.has(1)).toBe(false);
  });

  it('limita o min reportado ao frame aceito', () => {
    expect(capMinSize([360, 410], [900, 200])).toEqual([360, 200]);
    expect(capMinSize([360, 410], undefined)).toEqual([360, 410]);
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

describe('shouldSuppressSpawnMaximize', () => {
  it('nunca suprime com o Tiling desligado', () => {
    expect(
      shouldSuppressSpawnMaximize({
        enabled: false,
        isMaximized: true,
        everTiled: false,
        withinSpawnGrace: true,
      }),
    ).toBe(false);
  });

  it('nunca suprime quando a janela não está maximizada', () => {
    expect(
      shouldSuppressSpawnMaximize({
        enabled: true,
        isMaximized: false,
        everTiled: false,
        withinSpawnGrace: true,
      }),
    ).toBe(false);
  });

  it('suprime a janela que nasceu maximizada e nunca foi tilada (fora da graça)', () => {
    expect(
      shouldSuppressSpawnMaximize({
        enabled: true,
        isMaximized: true,
        everTiled: false,
        withinSpawnGrace: false,
      }),
    ).toBe(true);
  });

  it('dentro da graça suprime MESMO já tilada (auto-maximização tardia de app de restore lento)', () => {
    expect(
      shouldSuppressSpawnMaximize({
        enabled: true,
        isMaximized: true,
        everTiled: true,
        withinSpawnGrace: true,
      }),
    ).toBe(true);
  });

  it('preserva a maximização MANUAL: já tilada e fora da graça → não suprime (congela o grid)', () => {
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
      tab_bars: [
        { ...bar, content: undefined },
        { ...bar, members: ['x'] },
      ],
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
    const stacks = new Map<string, Stack[]>([
      [orderKey(0, 0), [{ members: [1, 2, 5], active: 1 }]],
    ]);
    // arrasta 5 sobre 2... 5 sai do stack e volta (no-op de pertencimento), vira ativo
    expect(addToStack(stacks, orderKey(0, 0), 2, 5)).toBe(true);
    expect(stacks.get(orderKey(0, 0))).toEqual([{ members: [1, 2, 5], active: 5 }]);
  });

  it('setActiveMember muda a aba ativa do stack que contém o membro', () => {
    const stacks = new Map<string, Stack[]>([
      [orderKey(0, 0), [{ members: [1, 2, 3], active: 1 }]],
    ]);
    expect(setActiveMember(stacks, 3)).toBe(true);
    expect(stacks.get(orderKey(0, 0))?.[0]?.active).toBe(3);
    expect(setActiveMember(stacks, 3)).toBe(false); // já ativa
  });
});

describe('stacks: remoção, toggle de grupo e serialização', () => {
  it('removeIdFromStacks dissolve stack que fica com 1 membro', () => {
    const stacks = new Map<string, Stack[]>([[orderKey(0, 0), [{ members: [1, 2], active: 2 }]]]);
    expect(removeIdFromStacks(stacks, 2)).toBe(true);
    // sobrou 1 membro → stack dissolvido → grupo vazio removido
    expect(stacks.has(orderKey(0, 0))).toBe(false);
  });

  it('isStackMember detecta membro em qualquer grupo, sem mutar (ADR 0047)', () => {
    const stacks = new Map<string, Stack[]>([
      [orderKey(0, 0), [{ members: [1, 2], active: 2 }]],
      [orderKey(1, 0), [{ members: [8, 9], active: 8 }]], // outro monitor/workspace
    ]);
    expect(isStackMember(stacks, 1)).toBe(true); // membro do 1º grupo
    expect(isStackMember(stacks, 9)).toBe(true); // membro de OUTRO grupo
    expect(isStackMember(stacks, 5)).toBe(false); // janela solta (não agrupada)
    // read-only: o Map não muda
    expect(stacks.get(orderKey(0, 0))).toEqual([{ members: [1, 2], active: 2 }]);
    expect(stacks.size).toBe(2);
  });

  it('isStackMember é false para Map vazio', () => {
    expect(isStackMember(new Map<string, Stack[]>(), 1)).toBe(false);
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
      mins: [], // sem mins no caminho de sync (ADR 0064; só o resize popula)
      floating: [],
    });
  });

  it('serializeState anexa os mins quando fornecidos (caminho de resize, ADR 0064)', () => {
    const stacks = new Map<string, Stack[]>();
    const trees = new Map<string, TreeNode | null>();
    const mins = [
      { id: 1, min_width: 600, min_height: 0 },
      { id: 2, min_width: 0, min_height: 500 },
    ];
    const out = JSON.parse(serializeState(stacks, new Set(), trees, 0, mins));
    expect(out.mins).toEqual(mins);
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
    expect(
      resizeDeltaFrom(
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 0, y: 0, width: 160, height: 50 },
      ),
    ).toEqual([{ edge: 'right', deltaPx: 60 }]);
    // x 100→70, largura 100→130 → borda esquerda cresceu 30.
    expect(
      resizeDeltaFrom(
        { x: 100, y: 0, width: 100, height: 50 },
        { x: 70, y: 0, width: 130, height: 50 },
      ),
    ).toEqual([{ edge: 'left', deltaPx: 30 }]);
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
    expect(
      resizeDeltaFrom({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
    ).toEqual([]);
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

describe('clampGeometry', () => {
  it('eleva width/height ≤ 0 para 1px e preserva id/x/y', () => {
    expect(clampGeometry({ id: 7, x: 10, y: 20, width: 0, height: -5 })).toEqual({
      id: 7,
      x: 10,
      y: 20,
      width: 1,
      height: 1,
    });
  });

  it('não altera dimensões válidas', () => {
    const ok = { id: 1, x: -3, y: 4, width: 800, height: 600 };
    expect(clampGeometry(ok)).toEqual(ok);
  });
});

describe('clampToWorkArea', () => {
  // Monitor primário na origem e secundário deslocado à direita (arranjo assimétrico típico).
  const PRIMARY = { index: 0, x: 0, y: 0, width: 1000, height: 800 };
  const RIGHT = { index: 1, x: 1000, y: 0, width: 1920, height: 1080 };

  it('não altera rect já contido na work-area', () => {
    const ok = { id: 1, x: 12, y: 12, width: 400, height: 300 };
    expect(clampToWorkArea(ok, PRIMARY)).toEqual(ok);
  });

  it('encolhe (shrink-to-fit) quando estoura a borda direita — não empurra a origem', () => {
    // Transbordo impositivo (0040): x=420, w=808 → direita 1228 > 1000. Trava na borda, encolhendo.
    expect(clampToWorkArea({ id: 12, x: 420, y: 12, width: 808, height: 300 }, PRIMARY)).toEqual({
      id: 12,
      x: 420,
      y: 12,
      width: 580, // 1000 - 420
      height: 300,
    });
  });

  it('encolhe quando estoura a borda inferior', () => {
    expect(clampToWorkArea({ id: 3, x: 12, y: 600, width: 400, height: 500 }, PRIMARY)).toEqual({
      id: 3,
      x: 12,
      y: 600,
      width: 400,
      height: 200, // 800 - 600
    });
  });

  it('sobe a origem para a origem útil de um monitor deslocado (sem vazar para o vizinho)', () => {
    // Janela cuja origem caiu à esquerda da work-area do monitor secundário: contém dentro dele.
    expect(clampToWorkArea({ id: 5, x: 980, y: 10, width: 500, height: 400 }, RIGHT)).toEqual({
      id: 5,
      x: 1000,
      y: 10,
      width: 500,
      height: 400,
    });
  });

  it('garante piso ≥ 1px mesmo com rect degenerado fora da borda', () => {
    const g = clampToWorkArea({ id: 9, x: 2000, y: 2000, width: 100, height: 100 }, PRIMARY);
    expect(g.width).toBeGreaterThanOrEqual(1);
    expect(g.height).toBeGreaterThanOrEqual(1);
  });

  // ---- HUD de "eixos limpos" (resolveHotZone — ADR 0028: merge/split 50-50/maximizar) ----
  const MON = { x: 0, y: 0, width: 900, height: 900 };
  const FULL = { x: 0, y: 0, width: 900, height: 900 }; // janela cobrindo o monitor
  const NO_MIN = { width: 0, height: 0 }; // janela arrastada sem min-size → split 50/50 puro

  it('miolo central de uma janela → fusão em abas (center local, MANTÉM merge)', () => {
    const hz = resolveHotZone({ x: 450, y: 450 }, FULL, MON, NO_MIN);
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('center');
    expect(hz.outline).toEqual(FULL);
  });

  it('lado esquerdo de uma janela (fora do centro) → split 50/50 do corpo (local, left)', () => {
    const hz = resolveHotZone({ x: 100, y: 450 }, FULL, MON, NO_MIN);
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('left');
    expect(hz.cells).toHaveLength(1);
    expect(hz.hot).toEqual([0]);
    expect(hz.outline).toEqual({ x: 0, y: 0, width: 450, height: 900 });
  });

  it('lado direito de uma janela → split 50/50 do corpo (local, right)', () => {
    const hz = resolveHotZone({ x: 800, y: 450 }, FULL, MON, NO_MIN);
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('right');
    expect(hz.outline).toEqual({ x: 450, y: 0, width: 450, height: 900 });
  });

  it('topo de uma janela (fora do centro) → split 50/50 do corpo (local, top)', () => {
    const hz = resolveHotZone({ x: 450, y: 100 }, FULL, MON, NO_MIN);
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('top');
    expect(hz.outline).toEqual({ x: 0, y: 0, width: 900, height: 450 });
  });

  it('split local estica a metade pelo min-size da arrastada, com clamp a 95% do alvo', () => {
    // Min da arrastada 700px > metade (450) → metade esticada; clamp a 0.95*900 = 855.
    const hz = resolveHotZone({ x: 100, y: 450 }, FULL, MON, { width: 700, height: 0 });
    expect(hz.scope).toBe('local');
    expect(hz.dropZone).toBe('left');
    expect(hz.outline).toEqual({ x: 0, y: 0, width: 700, height: 900 });
    // Min absurdo (acima do alvo) é limitado a 95% do alvo no eixo.
    const clamped = resolveHotZone({ x: 100, y: 450 }, FULL, MON, { width: 2000, height: 0 });
    expect(clamped.outline.width).toBe(855);
  });

  it('borda da tela num gap vazio → escopo global 50% pela borda', () => {
    const hz = resolveHotZone({ x: 10, y: 450 }, null, MON, NO_MIN);
    expect(hz.scope).toBe('global');
    expect(hz.dropZone).toBe('left');
    expect(hz.outline).toEqual({ x: 0, y: 0, width: 450, height: 900 });
  });

  it('miolo central de um gap vazio → escopo global "center" (maximizar = monitor inteiro)', () => {
    const hz = resolveHotZone({ x: 450, y: 450 }, null, MON, NO_MIN);
    expect(hz.scope).toBe('global');
    expect(hz.dropZone).toBe('center');
    expect(hz.outline).toEqual(FULL);
  });

  it('serializeScope mapeia só local/global', () => {
    expect(serializeScope('global')).toBe('global');
    expect(serializeScope('local')).toBe('local');
  });
});

describe('geometryConverged', () => {
  const r = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });

  it('mapa vazio → convergiu (nada a verificar)', () => {
    expect(geometryConverged(new Map(), new Map([[1, r(0, 0, 100, 100)]]), 2)).toBe(true);
  });

  it('todos os rects batem dentro do epsilon → convergiu', () => {
    const last = new Map([
      [1, r(0, 0, 500, 1000)],
      [2, r(500, 0, 500, 1000)],
    ]);
    const current = new Map([
      [1, r(1, 0, 499, 1000)], // dentro de 2px
      [2, r(500, 2, 500, 998)],
    ]);
    expect(geometryConverged(last, current, 2)).toBe(true);
  });

  it('uma janela fora do epsilon (apply descartado no boot) → NÃO convergiu', () => {
    const last = new Map([[1, r(0, 0, 500, 1000)]]);
    const current = new Map([[1, r(0, 0, 960, 540)]]); // "nasceu flutuante" no meio da tela
    expect(geometryConverged(last, current, 2)).toBe(false);
  });

  it('id ausente em current (janela fechada/maximizada) é ignorado', () => {
    const last = new Map([
      [1, r(0, 0, 500, 1000)],
      [2, r(500, 0, 500, 1000)],
    ]);
    const current = new Map([[1, r(0, 0, 500, 1000)]]); // id 2 sumiu
    expect(geometryConverged(last, current, 2)).toBe(true);
  });

  it('desvio em qualquer eixo isolado quebra a convergência', () => {
    const last = new Map([[1, r(10, 20, 300, 400)]]);
    expect(geometryConverged(last, new Map([[1, r(13, 20, 300, 400)]]), 2)).toBe(false); // x
    expect(geometryConverged(last, new Map([[1, r(10, 20, 300, 405)]]), 2)).toBe(false); // height
    expect(geometryConverged(last, new Map([[1, r(11, 21, 301, 401)]]), 2)).toBe(true); // tudo ≤2px
  });
});

describe('recusa de tamanho (ADR 0068)', () => {
  const r = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });

  it('terminal menor (size increments) contido no slot e já sondado → convergiu', () => {
    const last = new Map([[1, r(0, 0, 805, 1000)]]);
    const current = new Map([[1, r(0, 0, 797, 990)]]);
    expect(geometryConverged(last, current, 2, new Map([[1, r(0, 0, 805, 1000)]]))).toBe(true);
  });

  it('menor mas FORA do slot (apply descartado) → não convergiu, mesmo sondado', () => {
    const last = new Map([[1, r(0, 0, 800, 1000)]]);
    const current = new Map([[1, r(900, 100, 400, 300)]]);
    expect(geometryConverged(last, current, 2)).toBe(false);
    expect(geometryConverged(last, current, 2, last)).toBe(false);
  });

  it('regressão ADR 0072: 1ª janela com apply descartado no boot NÃO convergiu sem sonda', () => {
    // Slot = área útil inteira; o Mutter pôs a janela no tamanho natural, centralizada → "menor e
    // contida". Antes da 0072 isso era lido como recusa e a janela nunca era redimensionada.
    const last = new Map([[1, r(8, 40, 1904, 1032)]]);
    const current = new Map([[1, r(560, 290, 800, 600)]]);
    expect(geometryConverged(last, current, 2)).toBe(false);
  });

  it('sonda de OUTRO slot não confirma a recusa do slot atual', () => {
    const last = new Map([[1, r(0, 0, 805, 1000)]]);
    const current = new Map([[1, r(0, 0, 797, 990)]]);
    expect(geometryConverged(last, current, 2, new Map([[1, r(0, 0, 400, 1000)]]))).toBe(false);
  });

  it('refusalAction: 1º pedido, slot novo ou cliente não menor → resize', () => {
    const slot = r(0, 0, 805, 1000);
    expect(refusalAction(slot, undefined, r(0, 0, 797, 990), undefined, 2)).toBe('resize');
    expect(refusalAction(slot, r(0, 0, 400, 1000), r(0, 0, 397, 990), undefined, 2)).toBe('resize');
    expect(refusalAction(slot, slot, r(0, 0, 805, 1000), slot, 2)).toBe('resize');
    expect(refusalAction(slot, slot, r(0, 0, 0, 0), undefined, 2)).toBe('resize');
  });

  it('refusalAction: mesmo slot com o cliente menor → sonda; já sondado → centraliza', () => {
    const slot = r(0, 0, 805, 1000);
    const cur = r(0, 0, 797, 990);
    expect(refusalAction(slot, slot, cur, undefined, 2)).toBe('probe');
    expect(refusalAction(slot, slot, cur, r(0, 0, 400, 1000), 2)).toBe('probe');
    expect(refusalAction(slot, slot, cur, slot, 2)).toBe('center');
  });

  it('sizeRefused: menor num eixo e não maior no outro', () => {
    expect(sizeRefused(r(0, 0, 800, 600), r(0, 0, 790, 600), 2)).toBe(true);
    expect(sizeRefused(r(0, 0, 800, 600), r(0, 0, 900, 500), 2)).toBe(false);
    expect(sizeRefused(r(0, 0, 800, 600), r(0, 0, 800, 600), 2)).toBe(false);
    expect(sizeRefused(r(0, 0, 800, 600), r(0, 0, 0, 0), 2)).toBe(false);
  });

  it('containedIn respeita o epsilon', () => {
    expect(containedIn(r(10, 10, 100, 100), r(9, 10, 100, 100), 2)).toBe(true);
    expect(containedIn(r(10, 10, 100, 100), r(20, 20, 100, 100), 2)).toBe(false);
  });

  it('centerInSlot divide a folga igualmente', () => {
    expect(centerInSlot(r(100, 50, 805, 1000), r(0, 0, 797, 990))).toEqual(r(104, 55, 797, 990));
    expect(centerInSlot(r(0, 0, 100, 100), r(0, 0, 120, 100))).toEqual(r(0, 0, 120, 100));
  });
});

describe('paridade COSMIC (ADR 0068)', () => {
  const r = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });
  // 1 | 2/3 (coluna esquerda inteira; direita dividida) + monitor 2 à direita com a janela 4.
  const rects = new Map<number, Rect>([
    [1, r(8, 8, 492, 784)],
    [2, r(508, 8, 484, 388)],
    [3, r(508, 404, 484, 388)],
    [4, r(1008, 8, 984, 784)],
  ]);

  it('neighborInDirection escolhe o vizinho de frente', () => {
    expect(neighborInDirection(rects, 1, 'right')).toBe(2);
    expect(neighborInDirection(rects, 3, 'left')).toBe(1);
    expect(neighborInDirection(rects, 2, 'down')).toBe(3);
    expect(neighborInDirection(rects, 3, 'up')).toBe(2);
    expect(neighborInDirection(rects, 1, 'left')).toBeNull();
    // Atravessa monitores.
    expect(neighborInDirection(rects, 2, 'right')).toBe(4);
    expect(neighborInDirection(rects, 99, 'right')).toBeNull();
  });

  it('directionZone mapeia setas para zonas do MoveWindow', () => {
    expect(directionZone('up')).toBe('top');
    expect(directionZone('down')).toBe('bottom');
    expect(directionZone('left')).toBe('left');
  });

  it('pushFocus mantém MRU sem duplicatas e com teto', () => {
    const mru: number[] = [];
    pushFocus(mru, 1);
    pushFocus(mru, 2);
    pushFocus(mru, 1);
    pushFocus(mru, 0);
    expect(mru).toEqual([1, 2]);
    for (let i = 10; i < 50; i += 1) {
      pushFocus(mru, i, 5);
    }
    expect(mru.length).toBe(5);
  });

  it('pickInsertAnchor pula a janela nova (ainda não tilada)', () => {
    const mru = [9, 2, 1];
    expect(pickInsertAnchor(mru, new Set([1, 2, 9]), new Set([1, 2]))).toBe(2);
    expect(pickInsertAnchor(mru, new Set([1, 9]), new Set([1, 2]))).toBe(1);
    expect(pickInsertAnchor(mru, new Set([9]), new Set([1, 2]))).toBe(0);
  });

  it('remapMonitors casa por geometria e cai no índice', () => {
    const a = r(0, 0, 1920, 1080);
    const b = r(1920, 0, 2560, 1440);
    // Reordenação: os índices trocam, as geometrias ficam.
    const swapped = remapMonitors([a, b], [b, a]);
    expect([...swapped]).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(isIdentityRemap(swapped)).toBe(false);
    // Desconectou o segundo.
    expect([...remapMonitors([a, b], [a])]).toEqual([
      [0, 0],
      [1, null],
    ]);
    // Troca de resolução no mesmo índice.
    expect(isIdentityRemap(remapMonitors([a], [r(0, 0, 1280, 720)]))).toBe(true);
  });

  it('remapGroupMap/Set reescrevem e descartam grupos', () => {
    const mapping = new Map<number, number | null>([
      [0, 1],
      [1, null],
    ]);
    const m = remapGroupMap(
      new Map([
        ['0:2', 'a'],
        ['1:0', 'b'],
        ['5:0', 'c'],
      ]),
      mapping,
    );
    expect([...m]).toEqual([
      ['1:2', 'a'],
      ['5:0', 'c'],
    ]);
    expect([...remapGroupSet(new Set(['0:0', '1:1']), mapping)]).toEqual(['1:0']);
  });

  it('cycleStackActive é circular', () => {
    const stacks = new Map([['0:0', [{ members: [1, 2, 3], active: 1 }]]]);
    expect(cycleStackActive(stacks, 1, 1)).toBe(2);
    expect(cycleStackActive(stacks, 1, -1)).toBe(3);
    expect(stacks.get('0:0')?.[0]?.active).toBe(3);
    expect(cycleStackActive(stacks, 9, 1)).toBeNull();
  });

  it('toggleFloating alterna', () => {
    const f = new Set<number>();
    expect(toggleFloating(f, 4)).toBe(true);
    expect(toggleFloating(f, 4)).toBe(false);
    expect(f.size).toBe(0);
  });

  it('swapInStacks troca membros e ativa', () => {
    const stacks = new Map([['0:0', [{ members: [1, 2], active: 2 }]]]);
    swapInStacks(stacks, 2, 7);
    expect(stacks.get('0:0')?.[0]).toEqual({ members: [1, 7], active: 7 });
  });
});

describe('transientPlacement (ADR 0073)', () => {
  const area = { x: 0, y: 0, width: 3440, height: 1400 };
  const parent = { x: 1720, y: 0, width: 1720, height: 1400 };

  it('seletor largo e baixo vira ~3:2 centrado sobre o pai', () => {
    const r = transientPlacement(
      { x: 1720, y: 350, width: 1720, height: 450 },
      parent,
      area,
      [0, 0],
      [0, 0],
      true,
    );
    expect(r.height).toBe(860);
    expect(r.width).toBe(1032);
    expect(r.x).toBe(1720 + (1720 - 1032) / 2);
    expect(r.y).toBe(270);
  });

  it('proporção boa só centraliza', () => {
    const r = transientPlacement(
      { x: 0, y: 0, width: 1200, height: 800 },
      parent,
      area,
      [0, 0],
      [0, 0],
      true,
    );
    expect(r).toEqual({ x: 1980, y: 300, width: 1200, height: 800 });
  });

  it('sem pai usa a área útil; respeita min/max', () => {
    const r = transientPlacement(
      { x: 0, y: 0, width: 300, height: 100 },
      null,
      area,
      [0, 0],
      [900, 600],
      true,
    );
    expect(r).toEqual({ x: 1270, y: 400, width: 900, height: 600 });
  });

  it('não redimensionável só move, com clamp na área útil', () => {
    const r = transientPlacement(
      { x: 0, y: 0, width: 400, height: 100 },
      { x: 3300, y: 0, width: 100, height: 100 },
      area,
      [0, 0],
      [0, 0],
      false,
    );
    expect(r).toEqual({ x: 3040, y: 0, width: 400, height: 100 });
  });
});
