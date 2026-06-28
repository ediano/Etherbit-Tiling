import { describe, it, expect } from 'vitest';

import {
  serializeWindows,
  serializeMonitors,
  parseLayout,
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
