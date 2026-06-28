// kwin-globals.d.ts — declarações ambientes do subconjunto da API de scripting do KWin
// que este script usa. Não é a API completa: cobre apenas o necessário para o tiling.
// Referência: https://develop.kde.org/docs/plasma/kwin/api/

/** Retângulo no formato usado pelo KWin (QRectF/QJSValue). */
interface QRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ponto (QPoint) — usado por `workspace.cursorPos`. */
interface QPoint {
  x: number;
  y: number;
}

/** Saída/monitor. Tratado como opaco — só repassado a `clientArea`. */
type KWinOutput = unknown;

/** Janela gerenciada pelo KWin (subconjunto relevante ao tiling). */
interface KWinWindow {
  /** Geometria do quadro da janela. É GRAVÁVEL: atribuir reposiciona/redimensiona. */
  frameGeometry: QRect;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;

  // Classificação / flags de filtragem (todos read-only).
  readonly normalWindow: boolean;
  readonly dialog: boolean;
  readonly splash: boolean;
  readonly utility: boolean;
  readonly dock: boolean;
  readonly desktopWindow: boolean;
  readonly resizeable: boolean;
  readonly moveable: boolean;
  readonly minimizable: boolean;
  readonly maximizable: boolean;
  readonly skipTaskbar: boolean;
  readonly skipPager: boolean;
  readonly transient: boolean;
  readonly modal: boolean;
  readonly fullScreen: boolean;
  readonly onAllDesktops: boolean;

  /** Classe do recurso (equivalente ao WM_CLASS / app-id). */
  readonly resourceClass: string;
  readonly resourceName: string;
  readonly caption: string;

  /** Monitor onde a janela está. */
  readonly output: KWinOutput;

  /** Id estável da janela na sessão (QUuid). Coagir com `String(...)` antes de usar como chave. */
  readonly internalId: unknown;

  /** `true` enquanto a janela está sendo MOVIDA pelo usuário (distingue de resize). */
  readonly move: boolean;
  /** `true` enquanto a janela está sendo REDIMENSIONADA pelo usuário. */
  readonly resize: boolean;

  /** Início de um move/resize interativo do usuário. */
  readonly interactiveMoveResizeStarted: KWinSignal<[]>;
  /** Um passo do move/resize interativo (dispara a cada movimento). */
  readonly interactiveMoveResizeStepped: KWinSignal<[QRect]>;
  /** Fim do move/resize interativo (soltar). */
  readonly interactiveMoveResizeFinished: KWinSignal<[]>;
}

/** Sinal Qt exposto ao script. */
interface KWinSignal<TArgs extends unknown[]> {
  connect(handler: (...args: TArgs) => void): void;
  disconnect(handler: (...args: TArgs) => void): void;
}

/** Opções de área de cliente (subconjunto). */
declare const enum ClientAreaOption {
  PlacementArea = 0,
  MovementArea = 1,
  MaximizeArea = 2,
  MaximizeFullArea = 3,
  FullScreenArea = 4,
  WorkArea = 5,
  FullArea = 6,
  ScreenArea = 7,
}

interface KWinWorkspace {
  readonly windows: KWinWindow[];
  readonly activeWindow: KWinWindow | null;
  readonly currentDesktop: unknown;

  /** Posição atual do cursor (QPoint), em coordenadas absolutas do stage. */
  readonly cursorPos: QPoint;

  readonly windowAdded: KWinSignal<[KWinWindow]>;
  readonly windowRemoved: KWinSignal<[KWinWindow]>;
  readonly windowActivated: KWinSignal<[KWinWindow]>;

  /** Espaço útil (descontando painéis) do monitor para a janela/área dada. */
  clientArea(option: ClientAreaOption, output: KWinOutput, desktop?: unknown): QRect;
  clientArea(option: ClientAreaOption, window: KWinWindow): QRect;

  /** Desenha o outline nativo do KWin no retângulo dado (o mesmo do quick-tile/snap). */
  showOutline(geometry: QRect): void;
  /** Esconde o outline nativo. */
  hideOutline(): void;
}

/** Singleton global do KWin. */
declare const workspace: KWinWorkspace;

/** Namespace com enums do KWin (ex.: KWin.PlacementArea). */
declare const KWin: {
  readonly PlacementArea: ClientAreaOption;
  readonly MaximizeArea: ClientAreaOption;
  readonly FullScreenArea: ClientAreaOption;
};

/**
 * Chama um método D-Bus de forma assíncrona. O último argumento opcional é o callback
 * que recebe as respostas. Não há caminho simples para ASSINAR sinais D-Bus aqui.
 */
declare function callDBus(
  service: string,
  path: string,
  iface: string,
  method: string,
  ...args: unknown[]
): void;

/** Lê um valor da config nativa do script (kwinrc), com fallback. */
declare function readConfig<T>(key: string, defaultValue: T): T;

/** Saída de depuração — visível em `journalctl -f QT_CATEGORY=kwin_scripting`. */
declare function print(...args: unknown[]): void;
