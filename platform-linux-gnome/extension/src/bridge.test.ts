import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
  parsePreview,
  orderKey,
  appendToOrder,
  removeFromOrder,
  sortByOrder,
  reorderForDrop,
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

  it('reorderForDrop troca arrastado com alvo', () => {
    const order = new Map<string, number[]>([['0:0', [1, 2, 3]]]);
    expect(reorderForDrop(order, '0:0', 1, 3)).toBe(true);
    expect(order.get('0:0')).toEqual([3, 2, 1]);
  });

  it('reorderForDrop insere o arrastado vindo de outro grupo na posição do alvo', () => {
    const order = new Map<string, number[]>([['0:0', [1, 2]]]);
    expect(reorderForDrop(order, '0:0', 9, 2)).toBe(true);
    expect(order.get('0:0')).toEqual([1, 9, 2]);
  });

  it('reorderForDrop é no-op quando arrastado == alvo', () => {
    const order = new Map<string, number[]>([['0:0', [1, 2]]]);
    expect(reorderForDrop(order, '0:0', 1, 1)).toBe(false);
    expect(order.get('0:0')).toEqual([1, 2]);
  });
});
