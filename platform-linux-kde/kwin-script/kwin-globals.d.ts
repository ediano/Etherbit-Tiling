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

/** Tamanho (QSizeF) — usado por `KWinWindow.minSize` (geometry hints). */
interface QSize {
  width: number;
  height: number;
}

/**
 * Saída/monitor. Repassado opaco a `clientArea`; expõe `name` (nome do conector, ex. "DP-1") — a
 * IDENTIDADE ESTÁVEL usada para chavear o estado persistente por monitor (ADR 0056), imune à
 * reordenação de índice no hotplug. API real do KWin (Plasma 6): `Output::name`. Defensivo: pode ser
 * ausente em versões antigas do script — o consumidor cai no índice posicional quando falta.
 */
interface KWinOutput {
  readonly name?: string;
}

/** Desktop virtual do KWin (Plasma 6). Tratado como opaco — só comparado por identidade/índice. */
type KWinVirtualDesktop = unknown;

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
  /** Tamanho mínimo (WM_NORMAL_HINTS / xdg set_min_size); 0×0 = sem restrição. */
  readonly minSize: QSize;
  /** Minimizada. É GRAVÁVEL: usamos para OCULTAR as abas inativas de um stack. */
  minimized: boolean;
  /** Sempre-acima. É GRAVÁVEL: usamos para ELEVAR janelas em auto-floating sobre o grid. */
  keepAbove: boolean;
  /** Desktops virtuais aos quais a janela pertence (vazio = em todos). */
  readonly desktops: KWinVirtualDesktop[];
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

  /**
   * Fecha a janela (pedido de fechamento ao app, como o "x" da decoração). Usado pelo "x" de cada
   * aba na barra clicável do KDE; dispara `windowRemoved`, que re-tila o quadrante. API real do
   * KWin (Plasma 6): `Window::closeWindow()`.
   */
  closeWindow(): void;

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
  /**
   * (Des)maximização da janela. OPCIONAL: nem toda versão do KWin script expõe este sinal — conecte
   * sempre com checagem (`if (win.maximizedChanged) …`). Usado pelo Unmaximize Recovery para re-tilar.
   */
  readonly maximizedChanged?: KWinSignal<[]>;
  /**
   * (Des)maximiza a janela nos eixos dados. OPCIONAL (defensivo, como `maximizedChanged`): chame
   * sempre via checagem (`win.setMaximize?.(false, false)`). Usado pelo spawn-unmaximize: com o Tiling
   * ativo, uma janela que nasce maximizada é desmaximizada para entrar na Distribuição Cíclica. API
   * real do KWin (Plasma 6): `Window::setMaximize(bool vertically, bool horizontally)`.
   */
  setMaximize?(vertically: boolean, horizontally: boolean): void;
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
  /**
   * Lista todas as janelas gerenciadas. É MÉTODO (não propriedade): a propriedade `windows` só existe
   * na API QML do KWin — em scripts JavaScript ela é `undefined` e iterá-la lança Type error; use
   * sempre `windowList()`.
   */
  windowList(): KWinWindow[];
  /**
   * Janela ativa (foco). É READ-WRITE na API de scripting do KWin: ATRIBUIR uma janela a ela a ATIVA
   * — traz ao topo da pilha e dá foco (usado ao clicar numa aba da barra). `null` = nenhuma ativa.
   */
  activeWindow: KWinWindow | null;
  readonly currentDesktop: KWinVirtualDesktop;
  /** Todos os desktops virtuais, na ordem; usado para indexar `win.desktops`. */
  readonly desktops: KWinVirtualDesktop[];

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

/**
 * Registra um atalho de teclado global no KWin. `keySequence` é a tecla padrão (ex.: "Meta+S"),
 * editável depois em Configurações do Sistema → Atalhos. Dispara `callback` ao pressionar.
 */
declare function registerShortcut(
  title: string,
  text: string,
  keySequence: string,
  callback: () => void,
): boolean;

/** Saída de depuração — visível em `journalctl -f QT_CATEGORY=kwin_scripting`. */
declare function print(...args: unknown[]): void;
