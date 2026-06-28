// tiling.ts — lógica PURA de filtragem e geometria. Sem globais do KWin → testável em Node.
//
// `shouldTile` é a porta direta do filtro `_shouldIgnore` da extensão GNOME, traduzido para as
// flags do objeto `Window` do KWin. `tileColumns` é um layout PLACEHOLDER (colunas verticais com
// gaps) até o core (Ether Flow) decidir o layout — ver TODO em main.ts.

/** Retângulo (mesma forma do QRect do KWin). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Subconjunto do `Window` do KWin necessário para a decisão de filtragem. */
export interface WindowLike {
  resourceClass: string;
  resourceName: string;
  normalWindow: boolean;
  resizeable: boolean;
  maximizable: boolean;
}

/**
 * Decide se a janela participa do tiling. Espelha o filtro cirúrgico do GNOME:
 *  1) não está na ignore_list (por resourceClass/resourceName, case-insensitive);
 *  2) é redimensionável e maximizável (descarta diálogos rígidos);
 *  3) é uma janela normal (descarta dock/utility/splash/dialog — `normalWindow`).
 */
export function shouldTile(win: WindowLike, ignoreList: string[]): boolean {
  const id = (win.resourceClass || win.resourceName || '').toLowerCase();
  if (id && ignoreList.some((entry) => entry.toLowerCase() === id)) {
    return false;
  }
  if (!win.resizeable || !win.maximizable) {
    return false;
  }
  if (!win.normalWindow) {
    return false;
  }
  return true;
}

/**
 * Layout placeholder: distribui `count` janelas em colunas verticais dentro de `area`,
 * aplicando `outerGap` ao redor da área e `innerGap` entre colunas. Retorna retângulos
 * inteiros, prontos para atribuir a `window.frameGeometry`.
 */
export function tileColumns(area: Rect, count: number, innerGap: number, outerGap: number): Rect[] {
  if (count <= 0) {
    return [];
  }

  const innerX = area.x + outerGap;
  const innerY = area.y + outerGap;
  const innerW = area.width - 2 * outerGap;
  const innerH = area.height - 2 * outerGap;

  const totalGaps = (count - 1) * innerGap;
  const colWidth = (innerW - totalGaps) / count;

  const rects: Rect[] = [];
  for (let i = 0; i < count; i += 1) {
    rects.push({
      x: Math.round(innerX + i * (colWidth + innerGap)),
      y: Math.round(innerY),
      width: Math.round(colWidth),
      height: Math.round(innerH),
    });
  }
  return rects;
}
