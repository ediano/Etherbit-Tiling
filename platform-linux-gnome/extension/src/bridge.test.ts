import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parseTabBars,
  shouldSuppressSpawnMaximize,
  clampGeometry,
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
  effectiveMinSize,
  learnObservedMin,
  mergeMin,
  geometryConverged,
  pickResident,
  shouldMergeOnSpawn,
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

describe('learnObservedMin', () => {
  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });
  const EPS = 2;

  it('sem baseline (committed undefined) → não aprende', () => {
    const cache = new Map<number, [number, number]>();
    expect(learnObservedMin(cache, 1, undefined, rect(0, 0, 300, 200), true, EPS)).toEqual([0, 0]);
    expect(cache.has(1)).toBe(false);
  });

  it('não-learnable (maximizada/resize/arraste) → preserva o cache sem aprender', () => {
    const cache = new Map<number, [number, number]>([[1, [400, 300]]]);
    // A geometria pediria RAISE, mas learnable=false ⇒ mantém o valor anterior intacto.
    expect(
      learnObservedMin(cache, 1, rect(0, 0, 100, 100), rect(0, 0, 900, 900), false, EPS),
    ).toEqual([400, 300]);
    expect(cache.get(1)).toEqual([400, 300]);
  });

  it('recusa a encolher (posição ancorada, maior) → eleva o piso ao settled', () => {
    const cache = new Map<number, [number, number]>();
    // Pedimos 200x150; assentou em 360x260 na MESMA posição ⇒ min efetivo ≥ 360x260.
    expect(
      learnObservedMin(cache, 7, rect(10, 20, 200, 150), rect(10, 20, 360, 260), true, EPS),
    ).toEqual([360, 260]);
    expect(cache.get(7)).toEqual([360, 260]);
  });

  it('monotonic-max: recusa menor que o piso já aprendido não abaixa', () => {
    const cache = new Map<number, [number, number]>([[7, [360, 260]]]);
    expect(
      learnObservedMin(cache, 7, rect(10, 20, 200, 150), rect(10, 20, 320, 240), true, EPS),
    ).toEqual([360, 260]);
  });

  it('posição NÃO ancorada (move descartado no boot frio) → não aprende', () => {
    const cache = new Map<number, [number, number]>();
    // Pedimos (10,20) mas a janela está em (500,400) "nascida flutuante": o move foi ignorado.
    expect(
      learnObservedMin(cache, 3, rect(10, 20, 200, 150), rect(500, 400, 960, 540), true, EPS),
    ).toEqual([0, 0]);
    expect(cache.has(3)).toBe(false);
  });

  it('eixos independentes: recusa só em X ancora só a largura', () => {
    const cache = new Map<number, [number, number]>();
    expect(
      learnObservedMin(cache, 9, rect(0, 0, 200, 300), rect(0, 0, 360, 300), true, EPS),
    ).toEqual([360, 0]);
  });

  it('down-correct: pedimos abaixo do piso e o cliente aceitou → baixa o piso', () => {
    const cache = new Map<number, [number, number]>([[5, [360, 260]]]);
    // Compensação OFF: pedimos o rect cru 220x180 (abaixo do piso) e o cliente OBEDECEU.
    expect(
      learnObservedMin(cache, 5, rect(0, 0, 220, 180), rect(0, 0, 221, 181), true, EPS),
    ).toEqual([221, 181]);
  });

  it('epsilon: diferença ≤ eps não conta como recusa', () => {
    const cache = new Map<number, [number, number]>();
    expect(
      learnObservedMin(cache, 2, rect(0, 0, 300, 200), rect(0, 0, 302, 202), true, EPS),
    ).toEqual([0, 0]);
    expect(cache.has(2)).toBe(false);
  });

  it('ponto-fixo: committed == piso (compensação ON estável) → sem mudança', () => {
    const cache = new Map<number, [number, number]>([[8, [360, 260]]]);
    expect(
      learnObservedMin(cache, 8, rect(0, 0, 360, 260), rect(0, 0, 360, 260), true, EPS),
    ).toEqual([360, 260]);
  });

  it('janela flexível (aceita o slot, sem prior) → não entra no cache', () => {
    const cache = new Map<number, [number, number]>();
    expect(
      learnObservedMin(cache, 6, rect(0, 0, 500, 400), rect(0, 0, 500, 400), true, EPS),
    ).toEqual([0, 0]);
    expect(cache.has(6)).toBe(false);
  });

  it('HAZARD pós-gesto: slot que CRESCEU no mesmo anchor infla o piso (por isso a ponte não aprende no relayout de settle — ADR 0051)', () => {
    // Uma flexível `A @ x=8 w=948` cujo usuário arrastou a borda direita +200 → o frame vira 1148 no
    // MESMO x. Comparado ao `committed` ANTIGO (948), `learnObservedMin` (função pura, correta) grava
    // 1148 como se fosse o mínimo — o size ESCOLHIDO pelo usuário, não uma recusa do cliente. Este é o
    // caminho de inflação: como o piso só baixa com a compensação OFF, ele persistiria e travaria o
    // resize. A correção NÃO altera esta função (o RAISE aqui é legítimo p/ uma recusa real); a ponte
    // é que exclui a janela recém-gesticulada do aprendizado por um relayout (`_lastGesturedId`).
    const cache = new Map<number, [number, number]>();
    expect(
      learnObservedMin(cache, 4, rect(8, 0, 948, 1040), rect(8, 0, 1148, 1040), true, EPS),
    ).toEqual([1148, 0]);
    expect(cache.get(4)).toEqual([1148, 0]);
  });
});

describe('mergeMin', () => {
  it('pega o maior por eixo (real ∪ observado)', () => {
    expect(mergeMin([300, 0], [0, 260])).toEqual([300, 260]);
    expect(mergeMin([0, 0], [360, 260])).toEqual([360, 260]);
    expect(mergeMin([400, 500], [360, 260])).toEqual([400, 500]);
  });
});

// ---- Spawn-Time Merge (ADR 0049, Regra II) ----

describe('pickResident', () => {
  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });

  it('escolhe o rect (pré-spawn) de maior interseção com a nova janela', () => {
    // Layout anterior: dois blocos lado a lado. A nova janela nasceu invadindo o bloco ESQUERDO (id 1).
    const prev = new Map<number, Rect>([
      [1, rect(0, 0, 500, 800)],
      [2, rect(500, 0, 500, 800)],
    ]);
    expect(pickResident(prev, 3, rect(0, 0, 250, 800))).toBe(1);
  });

  it('ignora a própria janela nova ao procurar o residente', () => {
    const prev = new Map<number, Rect>([
      [3, rect(0, 0, 500, 800)], // rect da própria nova janela (já committado num ciclo anterior)
      [1, rect(0, 0, 250, 800)],
    ]);
    expect(pickResident(prev, 3, rect(0, 0, 250, 800))).toBe(1);
  });

  it('sem sobreposição → null (primeira janela do grupo / gap vazio)', () => {
    const prev = new Map<number, Rect>([[1, rect(0, 0, 100, 100)]]);
    expect(pickResident(prev, 3, rect(500, 500, 100, 100))).toBeNull();
  });

  it('mapa vazio → null', () => {
    expect(pickResident(new Map(), 3, rect(0, 0, 100, 100))).toBeNull();
  });

  it('empate de área → menor id (determinístico)', () => {
    const prev = new Map<number, Rect>([
      [5, rect(0, 0, 100, 100)],
      [2, rect(0, 0, 100, 100)],
    ]);
    expect(pickResident(prev, 3, rect(0, 0, 100, 100))).toBe(2);
  });
});

describe('shouldMergeOnSpawn', () => {
  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });

  it('quadrante horizontal: usa o min de LARGURA; não cabem com o gap → agrupa', () => {
    // Quadrante 600×400 (largura ≥ altura → split no eixo X). 300+300+8 = 608 > 600 → agrupa.
    expect(
      shouldMergeOnSpawn({
        residentPrevRect: rect(0, 0, 600, 400),
        newMin: [300, 0],
        residentMin: [300, 0],
        gap: 8,
      }),
    ).toBe(true);
  });

  it('quadrante horizontal: cabem com o gap → NÃO agrupa (split normal)', () => {
    // 280+280+8 = 568 ≤ 600 → cabe.
    expect(
      shouldMergeOnSpawn({
        residentPrevRect: rect(0, 0, 600, 400),
        newMin: [280, 0],
        residentMin: [280, 0],
        gap: 8,
      }),
    ).toBe(false);
  });

  it('quadrante vertical: usa o min de ALTURA', () => {
    // Quadrante 400×600 (altura > largura → split no eixo Y). 300+300+8 = 608 > 600 → agrupa.
    expect(
      shouldMergeOnSpawn({
        residentPrevRect: rect(0, 0, 400, 600),
        newMin: [0, 300],
        residentMin: [0, 300],
        gap: 8,
      }),
    ).toBe(true);
  });

  it('ignora o min do eixo PERPENDICULAR (herdado inteiro pelo split)', () => {
    // Quadrante horizontal: só o min de largura conta. Um min de ALTURA enorme não força agrupamento.
    expect(
      shouldMergeOnSpawn({
        residentPrevRect: rect(0, 0, 600, 400),
        newMin: [100, 9999],
        residentMin: [100, 0],
        gap: 8,
      }),
    ).toBe(false);
  });

  it('o gap inviolável entra na conta: aumentar o gap pode virar a decisão', () => {
    const base = {
      residentPrevRect: rect(0, 0, 600, 400),
      newMin: [290, 0] as [number, number],
      residentMin: [290, 0] as [number, number],
    };
    expect(shouldMergeOnSpawn({ ...base, gap: 0 })).toBe(false); // 580 ≤ 600
    expect(shouldMergeOnSpawn({ ...base, gap: 40 })).toBe(true); // 620 > 600
  });

  it('residente também rígido e apertado → agrupa (critério simétrico)', () => {
    expect(
      shouldMergeOnSpawn({
        residentPrevRect: rect(0, 0, 1000, 400),
        newMin: [600, 0],
        residentMin: [450, 0],
        gap: 8,
      }),
    ).toBe(true); // 600+450+8 = 1058 > 1000
  });
});
