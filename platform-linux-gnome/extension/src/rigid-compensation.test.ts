import { describe, it, expect } from 'vitest';

import {
  compensateRigidWindows,
  type CompRect,
  type CompensationInput,
  type RigidMin,
  type CompWorkArea,
} from './rigid-compensation.js';

// ---- Helpers de teste ----

function cmd(id: number, x: number, y: number, width: number, height: number): CompRect {
  return { id, x, y, width, height };
}

/// Monta a entrada localizando todos os `commands` num único monitor (0) numa work area 1000×800,
/// salvo `workAreas`/`monitorOf` explícitos.
function input(opts: {
  commands: CompRect[];
  mins?: Array<[number, number, number]>; // [id, minW, minH]
  workAreas?: Array<[number, CompWorkArea]>; // [monitorIndex, area]
  monitorOf?: Array<[number, number]>; // [id, monitorIndex]
  gap?: number;
}): CompensationInput {
  const mins = new Map<number, RigidMin>();
  for (const [id, minWidth, minHeight] of opts.mins ?? []) {
    mins.set(id, { minWidth, minHeight });
  }
  const workAreas = new Map<number, CompWorkArea>(
    opts.workAreas ?? [[0, { x: 0, y: 0, width: 1000, height: 800 }]],
  );
  const monitorOf = new Map<number, number>(opts.monitorOf ?? opts.commands.map((c) => [c.id, 0]));
  return { commands: opts.commands, mins, workAreas, monitorOf, gap: opts.gap ?? 0 };
}

// As asserções comparam a LISTA INTEIRA de saída (o algoritmo é determinístico, então a geometria é
// exata) — evita acesso indexado sob `noUncheckedIndexedAccess` e prova de uma vez tamanho, posição,
// ausência de sobreposição e contenção na work area.

describe('compensateRigidWindows', () => {
  it('1) sem janela rígida → no-op (devolve a mesma lista)', () => {
    const commands = [cmd(1, 0, 0, 500, 800), cmd(2, 500, 0, 500, 800)];
    const result = compensateRigidWindows(input({ commands }));
    expect(result).toBe(commands); // caminho rápido: mesma referência
    expect(result).toEqual(commands);
  });

  it('2) rígida cresce até o mínimo SEM comer o gap: o vizinho cede para preservá-lo', () => {
    // Layout com outer_gap=8 e inner_gap=8 (como o core entrega): slot 8|488 · gap 8 · 504|488, borda
    // final em 992 (outer_gap 8 à direita). A rígida esquerda tem min 500 → cresce 488→500 (borda final
    // 508). ADR 0049: o gap é INVIOLÁVEL — em vez de a rígida comer o gap, o vizinho flexível recua para
    // restaurar os 8px (nova borda inicial 508+8=516), preservando o espaçamento simétrico.
    const commands = [cmd(1, 8, 0, 488, 800), cmd(2, 504, 0, 488, 800)];
    const result = compensateRigidWindows(input({ commands, mins: [[1, 500, 0]], gap: 8 }));
    expect(result).toEqual([cmd(1, 8, 0, 500, 800), cmd(2, 516, 0, 476, 800)]);
  });

  it('3) rígida não cabe no slot → encolhe o vizinho flexível, sem sobrepor', () => {
    const commands = [cmd(1, 0, 0, 400, 800), cmd(2, 400, 0, 600, 800)];
    const result = compensateRigidWindows(input({ commands, mins: [[1, 500, 0]] }));
    // rígida travada em 500; vizinho recuou a borda inicial p/ 500, preservando a final (1000).
    expect(result).toEqual([cmd(1, 0, 0, 500, 800), cmd(2, 500, 0, 500, 800)]);
  });

  it('4) duas rígidas colidindo → a primeira intacta, a segunda truncada na borda', () => {
    const wa: CompWorkArea = { x: 0, y: 0, width: 500, height: 800 };
    // Esmagamento impositivo do core: ambas com min 300 numa tela de 500 → sobrepõem 100px.
    const commands = [cmd(1, 0, 0, 300, 800), cmd(2, 200, 0, 300, 800)];
    const result = compensateRigidWindows(
      input({
        commands,
        mins: [
          [1, 300, 0],
          [2, 300, 0],
        ],
        workAreas: [[0, wa]],
      }),
    );
    // 1ª rígida NUNCA truncada; 2ª truncada abaixo do próprio mínimo (overflow de hardware), sem overlap.
    expect(result).toEqual([cmd(1, 0, 0, 300, 800), cmd(2, 300, 0, 200, 800)]);
  });

  it('5) nada fora da work area: desloca a rígida para dentro nos dois eixos', () => {
    // Encostada na quina inferior-direita e crescendo além dela nos dois eixos.
    const commands = [cmd(1, 700, 600, 250, 150)];
    const result = compensateRigidWindows(input({ commands, mins: [[1, 400, 300]] }));
    // 600+400=1000, 500+300=800 → dentro da work area 1000×800.
    expect(result).toEqual([cmd(1, 600, 500, 400, 300)]);
  });

  it('6) eixos X e Y independentes: min nos dois é aplicado simultaneamente', () => {
    const commands = [cmd(1, 0, 0, 100, 100)];
    const result = compensateRigidWindows(input({ commands, mins: [[1, 300, 200]] }));
    expect(result).toEqual([cmd(1, 0, 0, 300, 200)]);
  });

  it('7) determinístico e idempotente (dedup da ponte não oscila)', () => {
    const build = (): CompensationInput =>
      input({ commands: [cmd(1, 0, 0, 400, 800), cmd(2, 400, 0, 600, 800)], mins: [[1, 500, 0]] });
    const first = compensateRigidWindows(build());
    const second = compensateRigidWindows(build());
    expect(second).toEqual(first); // mesma entrada → mesma saída
    // Alimentar a própria saída de volta não muda nada (estável).
    const again = compensateRigidWindows(input({ commands: first, mins: [[1, 500, 0]] }));
    expect(again).toEqual(first);
  });

  it('8) multi-monitor isolado: compensar um monitor não afeta o outro', () => {
    const commands = [cmd(1, 0, 0, 400, 600), cmd(2, 1000, 0, 500, 600)];
    const result = compensateRigidWindows(
      input({
        commands,
        mins: [[1, 500, 0]],
        workAreas: [
          [0, { x: 0, y: 0, width: 1000, height: 800 }],
          [1, { x: 1000, y: 0, width: 1000, height: 800 }],
        ],
        monitorOf: [
          [1, 0],
          [2, 1],
        ],
      }),
    );
    // rígida do monitor 0 cresceu p/ 500; vizinho do monitor 1 intacto.
    expect(result).toEqual([cmd(1, 0, 0, 500, 600), cmd(2, 1000, 0, 500, 600)]);
  });

  it('9) min maior que a work area → clampa ao monitor (limitação de hardware)', () => {
    const commands = [cmd(1, 0, 0, 300, 600)];
    const result = compensateRigidWindows(input({ commands, mins: [[1, 2000, 0]] }));
    expect(result).toEqual([cmd(1, 0, 0, 1000, 600)]); // clampado à largura do monitor
  });

  it('10) Fase I preserva o gap EXTERNO ao reancorar uma rígida que transborda (ADR 0049)', () => {
    // Rígida encostando na direita e crescendo além dela: min 400 numa work area de 1000, gap 8. A borda
    // final deve parar em `hi - gap` = 992 (não rente a 1000) → x = 992 - 400 = 592, mantendo os 8px.
    const commands = [cmd(1, 700, 0, 250, 800)];
    const result = compensateRigidWindows(input({ commands, mins: [[1, 400, 0]], gap: 8 }));
    expect(result).toEqual([cmd(1, 592, 0, 400, 800)]);
  });

  it('11) gatilho por PROXIMIDADE < gap: vizinho sem overlap, mas colado, é empurrado ao gap cheio', () => {
    // Rígida (8|500, borda 508) e vizinho (512|480). Não há sobreposição, mas a folga é só 4px (< gap 8):
    // isso já viola o espaçamento → o vizinho recua para 508+8=516, restaurando os 8px inteiros.
    const commands = [cmd(1, 8, 0, 500, 800), cmd(2, 512, 0, 480, 800)];
    const result = compensateRigidWindows(input({ commands, mins: [[1, 500, 0]], gap: 8 }));
    expect(result).toEqual([cmd(1, 8, 0, 500, 800), cmd(2, 516, 0, 476, 800)]);
  });

  it('12) overflow de hardware com gap: vencedora intacta e com gap; perdedora truncada', () => {
    const wa: CompWorkArea = { x: 0, y: 0, width: 500, height: 800 };
    // Duas rígidas de min 300 numa tela de 500 (impossível caber ambas). Vencedora (id 1) mantém 300 e o
    // gap de 8px; perdedora (id 2) trunca abaixo do próprio mínimo para não invadir o gap (borda final em
    // 492 = outer_gap 8; borda inicial em 316 = 308 + gap; largura 176). O gap só cederia em último caso.
    const commands = [cmd(1, 0, 0, 300, 800), cmd(2, 200, 0, 300, 800)];
    const result = compensateRigidWindows(
      input({
        commands,
        mins: [
          [1, 300, 0],
          [2, 300, 0],
        ],
        workAreas: [[0, wa]],
        gap: 8,
      }),
    );
    expect(result).toEqual([cmd(1, 8, 0, 300, 800), cmd(2, 316, 0, 176, 800)]);
  });

  it('13) determinístico e idempotente COM gap (o dedup da ponte não oscila)', () => {
    const build = (): CompensationInput =>
      input({
        commands: [cmd(1, 8, 0, 500, 800), cmd(2, 512, 0, 480, 800)],
        mins: [[1, 500, 0]],
        gap: 8,
      });
    const first = compensateRigidWindows(build());
    const second = compensateRigidWindows(build());
    expect(second).toEqual(first);
    // Alimentar a própria saída de volta é ponto-fixo (gap já preservado → nada muda).
    const again = compensateRigidWindows(input({ commands: first, mins: [[1, 500, 0]], gap: 8 }));
    expect(again).toEqual(first);
  });
});
