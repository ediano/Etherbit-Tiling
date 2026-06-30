// extension.ts — ponte GNOME Shell ↔ daemon (GNOME 45+ ESM, Wayland).
//
// PONTE BURRA (ver ADR rules/0016): a extensão NÃO desenha nada e NÃO decide layout. Ela apenas
//  - cria/destrói o indicador da barra (controle leve de gaps/autostart) e fala config via D-Bus;
//  - escuta eventos nativos do Mutter (janela criada/fechada, foco, monitores, workspace);
//  - coleta os metadados brutos das janelas + áreas úteis, envia ao daemon (`SyncWindows`) e
//    APLICA os retângulos-alvo devolvidos via `move_resize_frame` (geométrico e instantâneo).
// Toda a matemática (Ether Flow) e a resiliência gráfica vivem no Rust (core/daemon).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
  createTilingProxy,
  parseConfig,
  BUS_NAME,
  DEFAULT_CONFIG,
  type TilingConfig,
  type TilingProxy,
} from './dbus.js';
import {
  serializeWindows,
  serializeMonitors,
  serializeState,
  parseLayout,
  parseTabBars,
  parseFloating,
  parseDropped,
  clampGeometry,
  parseLayoutTrees,
  resolveHotZone,
  serializeScope,
  resizeDeltaFrom,
  orderKey,
  appendToOrder,
  removeFromOrder,
  removeIdFromStacks,
  sortByOrder,
  toggleStackGroup,
  toggleGroupDisabled,
  addToStack,
  mergeFallback,
  setActiveMember,
  type Stack,
  type TabBar,
  type TreeNode,
  type HotZone,
  type Rect,
  type WindowSnapshot,
  type MonitorSnapshot,
} from './bridge.js';
import { EtherbitIndicator } from './indicator.js';
import { applyRoundedCorners, clearRoundedCorners } from './effects.js';
import { initI18n } from './i18n.js';

/// Nomes das chaves de atalho no gschema (schemas/org.gnome.shell.extensions.etherbit-tiling.gschema.xml).
const KEY_TOGGLE_TILING = 'toggle-tiling';
const KEY_TOGGLE_TABBING = 'toggle-tabbing';

/// Período do loop que amostra o cursor durante o arrasto (~60 FPS).
const DRAG_TICK_MS = 16;

/// Micro-atrasos (ms) de estabilização do spawn no Wayland: o Mutter popula actor/maximização/min-size
/// DEPOIS do `window-created` (ao contrário do KWin, síncrono). Escalonado para cobrir a variância de
/// hardware sem fixar um valor frágil — a 1ª passada pega geometria/maximização, a última o min-size
/// negociado tardiamente (apps de min grande, ex.: Ubuntu Store). Ver ADR 0034.
const SPAWN_SETTLE_MS = [50, 150, 400];

/// Janela rastreada: guardamos o id do handler `unmanaged` para desconectar no fechamento.
interface Tracked {
  window: Meta.Window;
  unmanagedId: number;
  /// Sinais `notify::maximized-*` da janela — reagem ao (des)maximizar disparando relayout.
  notifyIds: number[];
  /// Ator e id do sinal `first-frame` (gating de encaixe no spawn). `firstFrameId === 0` quando o
  /// sinal já disparou (one-shot) ou não pôde ser conectado (ator ainda inexistente em `window-created`).
  actor: Meta.WindowActor | null;
  firstFrameId: number;
  /// Timers de estabilização do spawn (`GLib.timeout_add`). Auto-removidos ao disparar; cancelados no
  /// `unmanaged`/`disable`. Multi-disparo (ver `SPAWN_SETTLE_MS`): a rede para o caso "ator ainda
  /// inexistente em `window-created`" (Wayland), em que o `first-frame` nunca arma.
  spawnSettleIds: number[];
}

export default class EtherbitTilingExtension extends Extension {
  private _indicator: EtherbitIndicator | null = null;
  private _proxy: TilingProxy | null = null;
  private _config: TilingConfig = { ...DEFAULT_CONFIG };
  private _configChangedId = 0;
  // Watch do nome do daemon no barramento: dispara re-sync ao (re)aparecer, drop ao sumir.
  private _nameWatchId = 0;

  // Sinais do compositor que disparam um novo cálculo de layout.
  private _displayIds: number[] = [];
  private _workspaceId = 0;
  private _monitorsId = 0;

  // Janelas rastreadas (para reagir ao fechamento) e debounce do relayout.
  private _tracked = new Map<number, Tracked>();
  private _relayoutSource = 0;
  // Supressão de reentrância do relayout. Cobre TODA a janela em que NÓS mexemos no foco/stack — a
  // aplicação síncrona de geometria E os restacks adiados (minimize/make_above/raise) que rodam
  // depois (BEFORE_REDRAW), mais um settle curto. Sem isso, esses restacks mudam o foco, o
  // `notify::focus-window` re-dispara o relayout com outro `focused_id`, o auto-float escolhe outra
  // vítima e o layout entra em flapping bistável. Liberada por `_releaseSuppression`.
  private _suppressRelayout = false;
  // Trigger legítimo (window-created/focus real) que chegou DURANTE a supressão: coalescido num
  // único relayout disparado ao liberar (trailing-edge), para não perder o relayout necessário.
  private _relayoutPending = false;
  // Timeout do settle pós-aplicação (libera a supressão). 0 = inativo.
  private _settleSource = 0;
  // Assinatura do último layout APLICADO (dedup): se o novo é idêntico, pula reaplicação + log.
  private _lastLayoutSig = '';

  // Operações de restack (make_above/raise/unmake_above/minimize) ADIADAS para um "later" do Mutter
  // (BEFORE_REDRAW): rodam quando o stack das janelas já está consistente, evitando o assertion
  // `meta_window_set_stack_position_no_sync: window->stack_position >= 0` numa janela ainda não
  // empilhada (recém-criada ou em unmanage). O `try/catch` NÃO captura — é g_warning em C, só some
  // evitando a chamada no momento errado.
  private _restackLaterId = 0;
  private _restackQueue: Array<() => void> = [];

  // Ordem estável das janelas por `(monitor, workspace)` — determina a ordem de inserção de janelas
  // NOVAS na árvore (e o bootstrap balanceado). A topologia/proporções persistem em `_trees`.
  private _order = new Map<string, number[]>();

  // Árvores BSP persistentes por `(monitor, workspace)` — estado da ponte; o daemon segue sem estado.
  // Atualizadas a cada SyncWindows/MoveWindow (o core reconcilia e devolve a versão nova).
  private _trees = new Map<string, TreeNode | null>();

  // Estado leve novo (também vive na ponte; o daemon segue sem estado):
  //  - `_stacks`: janelas empilhadas em abas, por `(monitor, workspace)`;
  //  - `_disabledGroups`: grupos com tiling desligado (Super+Y);
  //  - `_groupTiled`: ids tiláveis por grupo no último layout (base do Super+S);
  //  - `_stackHidden`: ids que NÓS minimizamos (abas inativas), para restaurar depois.
  //  - `_floatingAbove`: ids que NÓS elevamos (auto-floating), para baixar ao voltarem ao grid.
  private _stacks = new Map<string, Stack[]>();
  private _disabledGroups = new Set<string>();
  private _groupTiled = new Map<string, number[]>();
  private _stackHidden = new Set<number>();
  private _floatingAbove = new Set<number>();
  // Merge Fallback (ADR 0030): ids já agrupados em aba por colapso de min-size. Evita o loop
  // sync↔merge — se a janela AINDA floata após o merge (tela minúscula), deixa de tentar e cai no
  // floating legado como rede de segurança. Limpo quando o id deixa de floatar.
  private _mergeAttempted = new Set<number>();
  // Spawn-unmaximize (ciclo de vida de maximização): ids que o core JÁ tilou ao menos uma vez. Uma
  // janela que é maximizada e NUNCA foi tilada "nasceu maximizada" → forçamos `unmaximize` para ela
  // entrar na Distribuição Cíclica. Já uma janela tilada que o usuário maximiza manualmente é
  // PRESERVADA (seu slot volta ao desmaximizar — Unmaximize Recovery). Limpo no `unmanaged`.
  private _everTiled = new Set<number>();
  // Barras de abas desenhadas (recriadas a cada relayout). Settings do gschema (atalhos).
  private _tabBars: St.Widget[] = [];
  private _settings: Gio.Settings | null = null;
  // Menu de contexto da aba (clique direito → "Desagrupar Janela"). O manager faz o grab (fecha ao
  // clicar fora) a partir de um anchor ESTÁVEL — as barras de abas são efêmeras (recriadas no relayout).
  private _tabMenuManager: PopupMenu.PopupMenuManager | null = null;
  private _tabMenu: PopupMenu.PopupMenu | null = null;
  private _tabMenuAnchor: St.Widget | null = null;

  // Estado do arrasto + HUD de "eixos limpos" (1–2 células: split, bloco ou merge).
  private _dragSource = 0;
  private _draggedId = 0;
  // Células St.Widget do HUD (1–2 por tick) reusadas e criadas sob demanda em uiGroup.
  private _hudCells: St.Widget[] = [];
  private _lastPointer: [number, number] | null = null;
  // Zona quente resolvida no último tick do arrasto (define o drop: stack/split + escopo).
  private _lastHot: HotZone | null = null;
  // Em voo: evita reentrância no tick.
  private _resolving = false;
  // Resize manual em curso: id + frame inicial (para derivar borda/delta ao soltar).
  private _resizeStart: {
    id: number;
    rect: { x: number; y: number; width: number; height: number };
  } | null = null;

  /// Garante um proxy vivo: cria (se ausente) e inscreve `ConfigChanged`. Devolve o proxy ou null.
  /// A criação é barata e dispara a ATIVAÇÃO D-Bus do daemon na primeira chamada (ver ADR 0020).
  private _ensureProxy(): TilingProxy | null {
    if (this._proxy) {
      return this._proxy;
    }
    try {
      const proxy = createTilingProxy();
      this._configChangedId = proxy.connectSignal('ConfigChanged', (_p, _s, [json]) => {
        this._config = parseConfig(json);
        this._indicator?.sync(this._config);
        // Gaps/ignore_list/cantos podem ter mudado → recalcula o layout.
        this._scheduleRelayout();
      });
      this._proxy = proxy;
      return proxy;
    } catch (error) {
      console.error(`Etherbit Tiling: falha ao conectar no daemon: ${error}`);
      this._proxy = null;
      return null;
    }
  }

  /// Descarta o proxy atual (canal morto): desconecta o sinal e zera, para `_ensureProxy` recriar.
  private _dropProxy(): void {
    if (this._proxy && this._configChangedId) {
      try {
        this._proxy.disconnectSignal(this._configChangedId);
      } catch {
        // proxy já morto — nada a desconectar.
      }
    }
    this._configChangedId = 0;
    this._proxy = null;
  }

  /// Executa uma chamada D-Bus com resiliência: garante o proxy e, em falha, recria + tenta UMA vez
  /// (a recriação aciona a ativação D-Bus). Devolve o resultado ou null. Centraliza a captura de
  /// desconexão exigida após ociosidade/suspensão.
  private _call<T>(fn: (proxy: TilingProxy) => T): T | null {
    let proxy = this._ensureProxy();
    if (!proxy) {
      return null;
    }
    try {
      return fn(proxy);
    } catch (error) {
      console.error(`Etherbit Tiling: chamada D-Bus falhou, reconectando: ${error}`);
      this._dropProxy();
      proxy = this._ensureProxy();
      if (!proxy) {
        return null;
      }
      try {
        return fn(proxy);
      } catch (retryError) {
        console.error(`Etherbit Tiling: reconexão falhou: ${retryError}`);
        this._dropProxy();
        return null;
      }
    }
  }

  /// Relê a config do daemon e reflete no indicador (no boot e a cada (re)aparecimento do daemon).
  private _refreshConfig(): void {
    const res = this._call((p) => p.GetConfigSync());
    if (res) {
      this._config = parseConfig(res[0]);
      this._indicator?.sync(this._config);
    }
  }

  /// O daemon (re)apareceu no barramento (boot, reativação ou wake): handshake + re-sincroniza.
  private _onDaemonAppeared(): void {
    this._call((p) => p.PingSync());
    this._refreshConfig();
    this._scheduleRelayout();
  }

  override enable(): void {
    // 1) Proxy D-Bus (lazy + resiliente). Sem daemon no bus, opera em modo degradado até ele
    //    (re)aparecer; toda chamada passa por `_call`, que reconecta sob demanda.
    this._ensureProxy();

    // 2) i18n: detecta o idioma do sistema ANTES de construir a UI (os rótulos do indicador são
    //    resolvidos no construtor). Inglês default global; pt-BR só sob locale pt (ADR 0032).
    initI18n(GLib.get_language_names());

    // 3) Indicador na barra. Cada ação roteia por `_call` (resiliente a queda do canal).
    this._indicator = new EtherbitIndicator({
      // Chave geral: persiste no daemon e propaga via ConfigChanged → o `_relayout` lê `enabled` e
      // pausa/retoma o laço.
      onEnabled: (enabled) => this._call((p) => p.SetEnabledSync(enabled)),
      onGap: (gap) => this._call((p) => p.SetGapSync(gap)),
      // O raio é a única fonte de verdade do arredondamento: `> 0` liga, `0` desliga. Derivamos o
      // `rounded_corners` do contrato a partir disso (não há mais toggle separado).
      onCornerRadius: (radius) => this._call((p) => p.SetRoundedCornersSync(radius > 0, radius)),
    });
    Main.panel.addToStatusArea(this.uuid, this._indicator);

    // 4) Config inicial.
    this._refreshConfig();

    // 4b) Watch do nome do daemon: ao (re)aparecer (pós-wake/reativação), refaz o handshake e
    //     re-sincroniza config + layout; ao sumir, descarta o proxy morto. Recuperação automática.
    this._nameWatchId = Gio.bus_watch_name(
      Gio.BusType.SESSION,
      BUS_NAME,
      Gio.BusNameWatcherFlags.NONE,
      () => this._onDaemonAppeared(),
      () => this._dropProxy(),
    );

    // 5) Eventos nativos do Mutter que motivam um novo layout.
    this._displayIds.push(
      global.display.connect('window-created', (_display, window) => this._onWindowCreated(window)),
    );
    this._displayIds.push(
      global.display.connect('notify::focus-window', () => this._scheduleRelayout()),
    );
    // Início do arrasto de uma janela: começa a rastrear o cursor e desenhar a drop zone.
    this._displayIds.push(
      global.display.connect('grab-op-begin', (_display, window, op) =>
        this._onGrabBegin(window, op),
      ),
    );
    // Fim de um arrasto/redimensionamento manual: consolida o drop e reorganiza ao soltar.
    this._displayIds.push(
      global.display.connect('grab-op-end', (_display, window) => {
        this._onGrabEnd(window);
        this._scheduleRelayout();
      }),
    );

    this._workspaceId = global.workspace_manager.connect('active-workspace-changed', () =>
      this._scheduleRelayout(),
    );
    this._monitorsId = Main.layoutManager.connect('monitors-changed', () =>
      this._scheduleRelayout(),
    );

    // 6) Atalhos globais (Super+Y = tiling por workspace; Super+S = agrupar em abas). As teclas
    // vivem no gschema; aqui só ligamos o disparo aos handlers que mutam o estado e re-tilam.
    try {
      this._settings = this.getSettings();
      Main.wm.addKeybinding(
        KEY_TOGGLE_TILING,
        this._settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        () => this._toggleTilingShortcut(),
      );
      Main.wm.addKeybinding(
        KEY_TOGGLE_TABBING,
        this._settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        () => this._toggleTabbingShortcut(),
      );
    } catch (error) {
      console.error(`Etherbit Tiling: falha ao registrar atalhos: ${error}`);
    }

    // 7) Layout inicial para as janelas já abertas.
    this._scheduleRelayout();
  }

  override disable(): void {
    if (this._relayoutSource) {
      GLib.source_remove(this._relayoutSource);
      this._relayoutSource = 0;
    }

    // Cancela operações de restack adiadas (make_above/raise/unmake_above/minimize) ainda pendentes,
    // para não rodarem sobre janelas que serão restauradas/destruídas no teardown abaixo.
    if (this._restackLaterId) {
      this._laterRemove(this._restackLaterId);
      this._restackLaterId = 0;
    }
    this._restackQueue = [];

    // Zera a supressão/settle do relayout (evita um timeout sobrevivente após o teardown).
    if (this._settleSource) {
      GLib.source_remove(this._settleSource);
      this._settleSource = 0;
    }
    this._suppressRelayout = false;
    this._relayoutPending = false;
    this._lastLayoutSig = '';

    // Remove os atalhos globais.
    if (this._settings) {
      Main.wm.removeKeybinding(KEY_TOGGLE_TILING);
      Main.wm.removeKeybinding(KEY_TOGGLE_TABBING);
      this._settings = null;
    }

    // Restaura janelas que minimizamos como abas inativas e descarta as barras de abas e o menu.
    this._restoreHiddenWindows();
    this._destroyTabBars();
    this._destroyTabMenu();
    this._tabMenuManager = null;
    this._tabMenuAnchor?.destroy();
    this._tabMenuAnchor = null;

    // Encerra um arrasto em andamento (ex.: troca de extensão durante o drag) sem deixar lixo.
    this._stopDrag();
    this._order.clear();
    this._stacks.clear();
    this._disabledGroups.clear();
    this._groupTiled.clear();

    for (const id of this._displayIds) {
      global.display.disconnect(id);
    }
    this._displayIds = [];

    if (this._workspaceId) {
      global.workspace_manager.disconnect(this._workspaceId);
      this._workspaceId = 0;
    }
    if (this._monitorsId) {
      Main.layoutManager.disconnect(this._monitorsId);
      this._monitorsId = 0;
    }

    for (const tracked of this._tracked.values()) {
      const { window, unmanagedId, notifyIds } = tracked;
      window.disconnect(unmanagedId);
      for (const sigId of notifyIds) {
        window.disconnect(sigId);
      }
      // Desconecta o gating de `first-frame` ainda pendente (janela rastreada que nunca renderizou).
      if (tracked.firstFrameId && tracked.actor) {
        try {
          tracked.actor.disconnect(tracked.firstFrameId);
        } catch {
          // ator já destruído — ignora.
        }
      }
      // Cancela timers de estabilização do spawn ainda pendentes (evita timeout vivo após o teardown).
      for (const sid of tracked.spawnSettleIds) {
        GLib.source_remove(sid);
      }
      // Remove o efeito de cantos arredondados para deixar as janelas no estado original.
      const actor = window.get_compositor_private() as Clutter.Actor | null;
      if (actor) {
        clearRoundedCorners(actor);
      }
    }
    this._tracked.clear();

    if (this._nameWatchId) {
      Gio.bus_unwatch_name(this._nameWatchId);
      this._nameWatchId = 0;
    }
    this._dropProxy();

    this._indicator?.destroy();
    this._indicator = null;

    this._config = { ...DEFAULT_CONFIG };
  }

  /// Rastreia a janela para reagir ao seu fechamento e agenda um relayout.
  private _onWindowCreated(window: Meta.Window): void {
    const id = window.get_stable_sequence();
    if (!this._tracked.has(id)) {
      const unmanagedId = window.connect('unmanaged', () => {
        const tracked = this._tracked.get(id);
        if (tracked) {
          tracked.window.disconnect(tracked.unmanagedId);
          for (const sigId of tracked.notifyIds) {
            tracked.window.disconnect(sigId);
          }
          // Gating de `first-frame` ainda pendente (janela fechada antes de renderizar): desconecta.
          if (tracked.firstFrameId && tracked.actor) {
            try {
              tracked.actor.disconnect(tracked.firstFrameId);
            } catch {
              // ator já destruído — ignora.
            }
          }
          // Timers de estabilização do spawn ainda pendentes (janela fechada em <400ms): cancela.
          for (const sid of tracked.spawnSettleIds) {
            GLib.source_remove(sid);
          }
          this._tracked.delete(id);
        }
        removeFromOrder(this._order, id);
        removeIdFromStacks(this._stacks, id);
        this._stackHidden.delete(id);
        this._everTiled.delete(id);
        this._scheduleRelayout();
      });
      // (Des)maximizar muda quais janelas entram no grid (Unmaximize Recovery): re-tila. O sinal só
      // dispara na transição de estado (não em todo resize), então não há loop com a aplicação.
      // Spawn-unmaximize: se a janela é maximizada e NUNCA foi tilada, ela "nasceu maximizada" (app
      // pediu tela cheia ao nascer) — com o Tiling ativo, forçamos `unmaximize` para ela entrar na
      // Distribuição Cíclica. Uma janela JÁ tilada que o usuário maximiza é preservada (só re-tila).
      const onMaxChange = (): void => {
        this._spawnUnmaximizeIfBorn(window, id);
        this._scheduleRelayout();
      };
      const notifyIds = [
        window.connect('notify::maximized-horizontally', onMaxChange),
        window.connect('notify::maximized-vertically', onMaxChange),
      ];
      // Re-tila quando a janela "assenta" (o `window-created` chega antes de
      // `resizable`/`maximizable`/tipo estarem prontos; o snapshot precoce a classifica como
      // não-tileável). O one-shot `settled` só trava quando a janela JÁ é tileável E o min-size já
      // negociou (ver abaixo) — um `size-changed` que chega antes disso (apps que assentam o TAMANHO
      // antes do tipo/flags, ex.: a Loja) re-tila mas NÃO queima o gatilho. Sem isso, com apps MISTOS
      // (Nautilus + Loja) a 1ª/2ª janela podia perder o único disparo e nunca entrar no grid. Limpo em
      // massa no `unmanaged` via `notifyIds`.
      let settled = false;
      notifyIds.push(
        window.connect('size-changed', () => {
          if (settled) {
            return;
          }
          // Só "assenta" o gatilho quando a janela é tileável E o min-size XDG já negociou. No Wayland
          // a janela pode virar tileável (tipo/flags) ANTES de o min-size popular; travar com min [0,0]
          // queima o disparo antes de o overflow ser detectável — a janela de min grande só encaixaria
          // via 3ª janela (ADR 0033/0034). Min [0,0] = ainda não negociado → mantém o gatilho armado.
          if (this._isTileable(window)) {
            const [minWidth, minHeight] = this._minSize(window);
            if (minWidth > 0 || minHeight > 0) {
              settled = true;
            }
          }
          this._scheduleRelayout();
        }),
      );
      // Encaixe determinístico no spawn (conceito pop-shell): o `window-created` chega ANTES de o ator
      // estar mapeado — aplicar geometria agora faz o Mutter REJEITAR o encaixe (a 1ª janela "nasce
      // flutuante" no meio da tela; a 2ª "funciona" só porque dispara um relayout posterior). O sinal
      // `first-frame` do `Meta.WindowActor` dispara no 1º quadro renderizado — janela já mapeada e com
      // tamanho real no Wayland. Esse é o gatilho PRIMÁRIO do encaixe: desmaximiza atômico (se nasceu
      // maximizada) ANTES do 1º `move_resize_frame` e relayouta. One-shot (desconecta ao disparar); o
      // `size-changed` acima fica como rede. Se o ator ainda não existe aqui, `firstFrameId` fica 0.
      let firstFrameId = 0;
      const actor = window.get_compositor_private() as Meta.WindowActor | null;
      if (actor) {
        firstFrameId = actor.connect('first-frame', () => {
          const tracked = this._tracked.get(id);
          if (tracked) {
            tracked.firstFrameId = 0;
          }
          try {
            actor.disconnect(firstFrameId);
          } catch {
            // ator já destruído — ignora.
          }
          this._spawnUnmaximizeIfBorn(window, id);
          this._scheduleRelayout();
        });
      }
      this._tracked.set(id, {
        window,
        unmanagedId,
        notifyIds,
        actor,
        firstFrameId,
        spawnSettleIds: [],
      });
      // Estabilização do spawn (Wayland): arma SEMPRE, inclusive quando `firstFrameId === 0` (ator
      // ainda inexistente no `window-created`). Re-lê maximização/min-size já populados e re-tila — a
      // rede determinística que o `first-frame` (gatilho primário, quando o ator existe) não cobre. É
      // o que dá paridade com o KWin (síncrono) sem o síncrono que o Mutter não permite. Ver ADR 0034.
      this._scheduleSpawnSettle(window, id);
    }
    // Nascimento: com o Tiling ativo, nenhuma janela inicia maximizada (mesmo que o app peça).
    this._spawnUnmaximizeIfBorn(window, id);
    this._scheduleRelayout();
  }

  /// Coalesce rajadas de eventos (ex.: vários `window-created` no login) num único relayout.
  private _scheduleRelayout(): void {
    // Durante a supressão (aplicação + restacks adiados + settle), NÃO relayoutar — mas registrar
    // que houve um trigger, para disparar UM relayout coalescido ao liberar (não perde mudanças reais).
    if (this._suppressRelayout) {
      this._relayoutPending = true;
      return;
    }
    if (this._relayoutSource) {
      return;
    }
    this._relayoutSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
      this._relayoutSource = 0;
      this._relayout();
      return GLib.SOURCE_REMOVE;
    });
  }

  /// Libera a supressão após um settle curto, deixando o Mutter assentar o foco/stack que NÓS
  /// mexemos antes de reabrir o relayout. Idempotente: agenda no máximo um settle por vez. Se um
  /// trigger legítimo chegou durante a supressão (`_relayoutPending`), dispara um relayout ao final.
  private _releaseSuppression(): void {
    if (this._settleSource) {
      return;
    }
    this._settleSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
      this._settleSource = 0;
      this._suppressRelayout = false;
      if (this._relayoutPending) {
        this._relayoutPending = false;
        this._scheduleRelayout();
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  /// Estabilização do spawn no Wayland: agenda micro-relayouts escalonados (`SPAWN_SETTLE_MS`) para
  /// quando o Mutter já populou actor/maximização/min-size — que NÃO estão prontos no `window-created`
  /// (diferente do KWin, síncrono). Cada disparo revalida a janela, reaplica o spawn-unmaximize (lendo
  /// o estado agora confirmado) e re-tila: o re-snapshot lê o `min_size` já negociado, então o core
  /// sinaliza overflow e o Merge Fallback encaixa a janela como aba JÁ no nascimento (sem depender de
  /// uma 3ª janela). Idempotente: usa `_scheduleRelayout` (respeita debounce/supressão) e o dedup por
  /// `_lastLayoutSig` torna no-op os disparos após a convergência — sem loop. Ver ADR 0034.
  private _scheduleSpawnSettle(window: Meta.Window, id: number): void {
    const tracked = this._tracked.get(id);
    if (!tracked) {
      return;
    }
    for (const delay of SPAWN_SETTLE_MS) {
      let source = 0;
      source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
        // Auto-limpeza: remove o próprio id da lista (o callback é one-shot — `SOURCE_REMOVE`).
        const current = this._tracked.get(id);
        if (current) {
          const idx = current.spawnSettleIds.indexOf(source);
          if (idx !== -1) {
            current.spawnSettleIds.splice(idx, 1);
          }
        }
        // Janela fechada/destruída no intervalo: não toca em referência morta (espelha `_relayout`).
        if (!current || !this._isWindowLive(window)) {
          return GLib.SOURCE_REMOVE;
        }
        // Estado já populado: desmaximiza se "nasceu maximizada" e re-tila com o min-size negociado.
        this._spawnUnmaximizeIfBorn(window, id);
        this._scheduleRelayout();
        return GLib.SOURCE_REMOVE;
      });
      tracked.spawnSettleIds.push(source);
    }
  }

  /// Coleta janelas+monitores, pede o layout ao daemon e aplica os retângulos.
  private _relayout(): void {
    // Garante o canal (reconecta/ativa sob demanda); sem daemon alcançável, opera em modo degradado.
    if (!this._ensureProxy()) {
      return;
    }

    // Chave geral DESLIGADA: pausa o laço (não envia `SyncWindows`) e LIBERA as janelas para o
    // comportamento flutuante do sistema — desfaz só o que NÓS impusemos (minimizadas como aba,
    // elevadas por auto-floating, cantos arredondados, barras de aba). O daemon segue vivo. O estado
    // leve (ordem/stacks/árvores) é PRESERVADO, então religar (`enabled = true`) reorganiza tudo de
    // volta no grid. Idempotente: chamadas repetidas com tudo já liberado são no-op.
    if (!this._config.enabled) {
      this._releaseToFloating();
      return;
    }

    const workspace = global.workspace_manager.get_active_workspace();
    const windows = workspace ? workspace.list_windows() : [];

    const byId = new Map<number, Meta.Window>();
    // Agrupa por `(monitor, workspace)` e registra a ordem estável de cada grupo.
    const groups = new Map<string, WindowSnapshot[]>();
    for (const window of windows) {
      const snapshot = this._snapshot(window);
      byId.set(snapshot.id, window);
      const key = orderKey(snapshot.monitor, snapshot.workspace);
      appendToOrder(this._order, key, snapshot.id);
      const arr = groups.get(key);
      if (arr) {
        arr.push(snapshot);
      } else {
        groups.set(key, [snapshot]);
      }
    }

    // Reordena cada grupo pela ordem estável; o BSP do core é função dessa ordem.
    const snapshots: WindowSnapshot[] = [];
    for (const [key, arr] of groups) {
      const sortedIds = sortByOrder(
        this._order,
        key,
        arr.map((s) => s.id),
      );
      const inGroup = new Map(arr.map((s) => [s.id, s]));
      for (const sid of sortedIds) {
        const snap = inGroup.get(sid);
        if (snap) {
          snapshots.push(snap);
        }
      }
    }

    const focus = global.display.focus_window;
    const focusedId = focus ? focus.get_stable_sequence() : 0;

    const res = this._call((p) =>
      p.SyncWindowsSync(
        serializeWindows(snapshots),
        serializeMonitors(this._collectMonitors()),
        serializeState(this._stacks, this._disabledGroups, this._trees, focusedId),
      ),
    );
    if (!res) {
      return;
    }
    const layoutJson = res[0];

    // Persiste as árvores reconciliadas pelo core para reenviar no próximo sync (estabilidade).
    this._trees = parseLayoutTrees(layoutJson);

    const commands = parseLayout(layoutJson);
    const tabBars = parseTabBars(layoutJson);
    // Diagnóstico (ADR): janelas recebidas que o daemon NÃO tilou, com o motivo. Faz o log refletir
    // a tela — `total > aplicadas` deixa de parecer bug quando é só uma janela não-tileável (ex.:
    // desktop/DING) ou uma "nascida maximizada" ainda fora do grid (`excluded_maximized`).
    const dropped = parseDropped(layoutJson);
    // Sinal de OVERFLOW (ADR 0033): janelas cujo slot ficou < o mínimo mesmo após a cascata. Alimenta
    // o Merge Fallback abaixo (colapsar em abas, onde cada aba recebe o slot inteiro) — o caminho que
    // resolve apps de min grande no Wayland (ex.: Ubuntu Store). O float-and-elevate legado (mais
    // abaixo) fica como REDE: só age se um id ainda estourar após o merge (tela minúscula).
    const floating = parseFloating(layoutJson);
    const floatingIds = new Set<number>(floating.map((c) => c.id));

    // Merge Fallback (ADR 0030, GNOME-only): janela que floataria por colapso de min-size é agrupada
    // como ABA no quadrante focado, em vez de flutuar. Limpa o guard dos ids que já não floatam (para
    // re-merge num colapso futuro); se um id AINDA floata após o merge (tela minúscula), o guard o
    // mantém e ele cai no floating legado abaixo. Um merge dispara novo relayout: o slot deixa de
    // estourar o mínimo (o min do stack é o `max` dos membros) e `floating` esvazia.
    for (const id of [...this._mergeAttempted]) {
      if (!floatingIds.has(id)) {
        this._mergeAttempted.delete(id);
      }
    }
    if (floating.length > 0) {
      const merged = mergeFallback(
        this._stacks,
        floating.map((c) => c.id),
        this._mergeAttempted,
        snapshots,
        commands,
        focusedId,
      );
      if (merged.length > 0) {
        for (const id of merged) {
          this._mergeAttempted.add(id);
        }
        this._scheduleRelayout();
        return;
      }
    }

    // Abas inativas a ocultar (minimizar): todo membro de stack que não é o ativo.
    const shouldHide = new Set<number>();
    for (const bar of tabBars) {
      for (const member of bar.members) {
        if (member !== bar.active) {
          shouldHide.add(member);
        }
      }
    }

    // Dedup: se o layout calculado é idêntico ao último APLICADO, não reaplica nem loga — mata a
    // inundação do journal e reescritas redundantes de geometria/efeito, e (com a supressão) faz o
    // laço convergir num passo. `corner_radius` entra porque muda o efeito mesmo com a mesma
    // geometria. Resetada em `_releaseToFloating` p/ a chave geral religar mesmo com layout igual.
    const layoutSig = JSON.stringify([
      commands,
      floating,
      tabBars,
      [...shouldHide].sort((a, b) => a - b),
      this._config.corner_radius,
    ]);
    if (layoutSig === this._lastLayoutSig) {
      return;
    }
    this._lastLayoutSig = layoutSig;

    // Observabilidade FIEL À TELA (regressão do tiling): mostra o round-trip ponte→daemon→ponte no
    // journal do gnome-shell. `total` = janelas recebidas; `aplicadas` = quantas ganharam slot;
    // `descartadas` lista id:motivo (por que `total` > `aplicadas`, sem parecer off-by-one). A linha
    // `grid:` traz a geometria final de cada janela aplicada (x,y wxh) — casa com o que está na tela.
    const droppedDesc =
      dropped.length > 0
        ? ` descartadas=[${dropped.map((d) => `${d.id}:${d.reason}`).join(', ')}]`
        : '';
    console.log(
      `[etherbit] relayout: total=${snapshots.length} aplicadas=${commands.length} flutuantes=${floating.length}${droppedDesc}`,
    );
    if (commands.length > 0) {
      console.log(
        `[etherbit] grid: ${commands.map((c) => `${c.id}@${c.x},${c.y} ${c.width}x${c.height}`).join(' | ')}`,
      );
    }

    this._suppressRelayout = true;
    try {
      // Restaura quem deixou de estar oculto (ex.: virou a aba ativa, ou o stack foi desfeito).
      for (const id of this._stackHidden) {
        if (!shouldHide.has(id)) {
          byId.get(id)?.unminimize();
        }
      }
      // Aplica a geometria das janelas visíveis (singles + aba ativa de cada stack).
      for (const command of commands) {
        const window = byId.get(command.id);
        if (!window) {
          continue;
        }
        // O core deu um slot a esta janela → ela já foi tilada. A partir daqui, maximizá-la é ação
        // MANUAL do usuário (preservada); só "nasceu maximizada" quem nunca apareceu aqui (spawn).
        this._everTiled.add(command.id);
        // Não sobrescrever a geometria de uma janela MAXIMIZADA — isso a desmaximizaria. O compositor
        // a mantém maximizada por cima do seu slot reservado; ao desmaximizar, o evento dispara um
        // novo relayout que aplica a geometria do slot (Unmaximize Recovery).
        if (this._isMaximized(window)) {
          continue;
        }
        // Isolado POR JANELA: um erro de runtime numa janela (ex.: API do Shell que mudou) não pode
        // abortar o relayout inteiro e paralisar o grid — loga e segue para as demais.
        try {
          // user_op=false: reposicionamento programático, instantâneo e puramente geométrico.
          // Clamp ≥ 1px: rect inválido (width/height ≤ 0) quebraria o framebuffer do Cogl.
          const g = clampGeometry(command);
          window.move_resize_frame(false, g.x, g.y, g.width, g.height);
          // Cantos arredondados (efeito no ator): o RAIO é a única fonte de verdade — `> 0` aplica o
          // efeito; `0` o remove (não há mais toggle separado). Best-effort, nunca quebra.
          const actor = window.get_compositor_private() as Clutter.Actor | null;
          if (actor) {
            if (this._config.corner_radius > 0) {
              applyRoundedCorners(actor, this._config.corner_radius);
            } else {
              clearRoundedCorners(actor);
            }
          }
        } catch (error) {
          console.error(
            `Etherbit Tiling: falha ao aplicar geometria na janela ${command.id}: ${error}`,
          );
        }
      }
      // Oculta as abas inativas recém-empilhadas. `minimize()` mexe no stack do Mutter: numa janela
      // recém-criada/em unmanage (`stack_position == -1`) dispara o assertion. ADIA para o
      // BEFORE_REDRAW (stack já consistente) e revalida o ator no momento da execução.
      for (const id of shouldHide) {
        if (!this._stackHidden.has(id)) {
          const w = byId.get(id);
          if (w) {
            this._enqueueRestack(() => {
              if (this._isWindowLive(w)) {
                w.minimize();
              }
            });
          }
        }
      }
      // Baixa quem deixou de flutuar (voltou ao grid): remove o "always-on-top" que nós pusemos.
      // `unmake_above()` também mexe no stack → mesmo adiamento.
      for (const id of this._floatingAbove) {
        if (!floatingIds.has(id)) {
          const w = byId.get(id);
          if (w) {
            this._enqueueRestack(() => {
              if (this._isWindowLive(w)) {
                w.unmake_above();
              }
            });
          }
        }
      }
      // Aplica a geometria das flutuantes (centralizadas pelo core) e as eleva acima das tiladas.
      // A geometria (`move_resize_frame`) não toca no stack, então é aplicada já; só o
      // `make_above()`/`raise()` é ADIADO para o BEFORE_REDRAW (evita `stack_position >= 0`).
      for (const command of floating) {
        const window = byId.get(command.id);
        if (!window) {
          continue;
        }
        if (!this._isWindowLive(window)) {
          continue;
        }
        try {
          // Clamp ≥ 1px: rect inválido quebraria o framebuffer do Cogl (ver janelas tiladas acima).
          const g = clampGeometry(command);
          window.move_resize_frame(false, g.x, g.y, g.width, g.height);
        } catch (error) {
          console.error(`Etherbit Tiling: falha ao posicionar a flutuante ${command.id}: ${error}`);
        }
        this._enqueueRestack(() => {
          if (!this._isWindowLive(window)) {
            return;
          }
          window.make_above();
          window.raise();
        });
      }
    } finally {
      // Se restacks foram ADIADOS (mexem foco/stack), a supressão segue até o drain deles
      // (`_enqueueRestack`); só liberamos aqui quando NENHUM foi enfileirado neste ciclo.
      if (!this._restackLaterId) {
        this._releaseSuppression();
      }
    }
    this._stackHidden = shouldHide;
    this._floatingAbove = floatingIds;

    // Ids tiláveis por grupo (singles + membros de stacks) — base do toggle de abas (Super+S).
    this._groupTiled = this._collectGroupTiled(commands, tabBars, byId);

    // Desenha as barras de abas a partir da geometria devolvida pelo core.
    this._rebuildTabBars(tabBars, byId);
  }

  /// Mapeia, por grupo `(monitor, workspace)`, os ids tiláveis no último layout (singles + membros
  /// de stacks), na ordem estável. É a base do `toggleStackGroup` no atalho Super+S.
  private _collectGroupTiled(
    commands: ReturnType<typeof parseLayout>,
    tabBars: TabBar[],
    byId: Map<number, Meta.Window>,
  ): Map<string, number[]> {
    const ids = new Set<number>();
    for (const c of commands) {
      ids.add(c.id);
    }
    for (const bar of tabBars) {
      for (const m of bar.members) {
        ids.add(m);
      }
    }
    const groups = new Map<string, number[]>();
    for (const id of ids) {
      const window = byId.get(id);
      if (!window) {
        continue;
      }
      const workspace = window.get_workspace();
      const key = orderKey(window.get_monitor(), workspace ? workspace.index() : 0);
      const arr = groups.get(key);
      if (arr) {
        arr.push(id);
      } else {
        groups.set(key, [id]);
      }
    }
    for (const [key, arr] of groups) {
      groups.set(key, sortByOrder(this._order, key, arr));
    }
    return groups;
  }

  // ---- Arrasto + overlay de preview da drop zone ----

  /// Início de um grab: MOVIMENTO → amostra o cursor (~60 FPS) e desenha a drop zone; RESIZE →
  /// captura o frame inicial para derivar borda/delta ao soltar. Sem daemon: degradação suave.
  private _onGrabBegin(window: Meta.Window | null, op: Meta.GrabOp): void {
    if (!window || !this._ensureProxy()) {
      return;
    }
    if (op === Meta.GrabOp.MOVING) {
      this._stopDrag(); // encerra qualquer arrasto pendente antes de iniciar outro
      this._resizeStart = null;
      this._draggedId = window.get_stable_sequence();
      this._lastPointer = null;
      this._resolving = false;
      // [DIAG drag-to-group] Confirma que o grab de MOVIMENTO disparou. Se NÃO aparecer ao arrastar,
      // os sinais `grab-op-*` mudaram no Mutter — o agrupamento por abas nunca começa. Temporário.
      console.log(`[etherbit][drag] início: arrastando ${this._draggedId}`);
      this._dragSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_TICK_MS, () => {
        this._onDragTick();
        return GLib.SOURCE_CONTINUE;
      });
      return;
    }
    // Qualquer outro grab numa janela = resize manual: guarda a geometria inicial.
    const r = window.get_frame_rect();
    this._resizeStart = {
      id: window.get_stable_sequence(),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  }

  /// Um tick do arrasto: lê o cursor, resolve a zona no daemon e atualiza o overlay. Faz throttle
  /// por posição (pula se o cursor não moveu) e por chamada em voo (não empilha D-Bus síncrono).
  private _onDragTick(): void {
    if (this._resolving) {
      return;
    }
    const [x, y] = global.get_pointer();
    if (this._lastPointer && this._lastPointer[0] === x && this._lastPointer[1] === y) {
      return;
    }
    this._lastPointer = [x, y];
    this._resolving = true;
    try {
      // Cálculo 100% LOCAL (ADR 0028): sem D-Bus por tick. Lê a janela sob o cursor e o monitor e
      // resolve o destino (merge no centro, split 50/50 no eixo, ou borda/maximizar no gap). O min-size
      // da janela ARRASTADA estica a metade do preview se preciso. O core só é acionado no DROP.
      const target = this._windowUnderPointObj(x, y, this._draggedId);
      const targetRect = target ? this._frameRectOf(target) : null;
      const monitor = this._monitorRectUnder(x, y);
      const draggedMin = this._draggedMinSize();
      const hot = resolveHotZone({ x, y }, targetRect, monitor, draggedMin);
      if (hot.dropZone !== (this._lastHot?.dropZone ?? '')) {
        console.log(
          `[etherbit][drag] zona ${this._lastHot?.dropZone ?? 'none'} → ${hot.dropZone}` +
            ` (escopo ${hot.scope}, alvo ${target ? target.get_stable_sequence() : 'nenhum'})`,
        );
      }
      this._lastHot = hot;
      this._updateHud(hot);
    } catch (error) {
      console.error(`Etherbit Tiling: HUD falhou: ${error}`);
    } finally {
      this._resolving = false;
    }
  }

  /// Área útil do monitor que contém `(x, y)` (fallback: o primeiro monitor, ou um retângulo zerado).
  private _monitorRectUnder(x: number, y: number): Rect {
    const monitors = this._collectMonitors();
    const hit = monitors.find(
      (m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height,
    );
    const m = hit ?? monitors[0];
    return m
      ? { x: m.x, y: m.y, width: m.width, height: m.height }
      : { x: 0, y: 0, width: 0, height: 0 };
  }

  /// Retângulo de frame de uma janela no formato do contrato (`{x,y,width,height}`).
  private _frameRectOf(window: Meta.Window): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const r = window.get_frame_rect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  /// Tamanho mínimo (px) da janela em ARRASTO, para esticar a metade do preview do split local (ADR
  /// 0028). Busca a janela por `_draggedId` na lista do workspace; `(0,0)` se não houver arrasto ou o
  /// min for indisponível (split 50/50 puro).
  private _draggedMinSize(): { width: number; height: number } {
    if (!this._draggedId) {
      return { width: 0, height: 0 };
    }
    const workspace = global.workspace_manager.get_active_workspace();
    const windows = workspace ? workspace.list_windows() : [];
    for (const window of windows) {
      if (window.get_stable_sequence() === this._draggedId) {
        const [w, h] = this._minSize(window);
        return { width: w, height: h };
      }
    }
    return { width: 0, height: 0 };
  }

  /// Desenha o HUD de "eixos limpos" (ADR 0028): posiciona/estiliza as células da zona quente e acende
  /// as ativas. O novo modelo produz 1–2 células — split local (2 metades), bloco global/maximizar (1)
  /// ou realce de merge (1). `null` ou vazio → esconde tudo. Centro/merge em VERDE; split/global em AZUL
  /// Nord; células não-acesas, um leve contorno. ESTÁTICO, sem animação (reafirma ADR 0016).
  private _updateHud(hot: HotZone | null): void {
    // Garante só o número de células presentes neste tick (1–2) e esconde o excedente do tick anterior.
    const need = hot ? hot.cells.length : 0;
    const cells = this._ensureHud(need);
    if (!hot || hot.cells.length === 0 || hot.dropZone === 'none') {
      for (const cell of cells) {
        cell.hide();
      }
      return;
    }
    // Verde (merge) só na fusão em abas (centro de uma janela, escopo local). O centro GLOBAL (gap
    // vazio = maximizar) é um destino de tiling normal → azul.
    const merge = hot.dropZone === 'center' && hot.scope === 'local';
    const HOT_MERGE =
      'background-color: rgba(163, 190, 140, 0.34);' +
      'border: 2px solid rgba(163, 190, 140, 0.95); border-radius: 10px;';
    const HOT_SPLIT =
      'background-color: rgba(94, 129, 172, 0.34);' +
      'border: 2px solid rgba(94, 129, 172, 0.95); border-radius: 10px;';
    const COLD =
      'background-color: rgba(94, 129, 172, 0.08);' +
      'border: 1px solid rgba(94, 129, 172, 0.35); border-radius: 8px;';
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (!cell) {
        continue;
      }
      const rect = hot.cells[i];
      if (!rect) {
        cell.hide();
        continue;
      }
      cell.set_style(hot.hot.includes(i) ? (merge ? HOT_MERGE : HOT_SPLIT) : COLD);
      cell.set_position(Math.round(rect.x), Math.round(rect.y));
      cell.set_size(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
      cell.show();
    }
  }

  /// Garante PELO MENOS `count` células do HUD (criando sob demanda), devolvendo todas as existentes.
  /// As células são ESTÁTICAS, semi-transparentes e não reativas (não roubam o ponteiro durante o grab),
  /// em `uiGroup` (coords absolutas de stage, que casam com `global.get_pointer()`). Reusadas entre
  /// ticks; o `_updateHud` esconde as não-usadas. Sem animação (ver ADR 0016): custo desprezível.
  private _ensureHud(count: number): St.Widget[] {
    while (this._hudCells.length < count) {
      const cell = new St.Widget({
        style_class: 'etherbit-drop-preview',
        reactive: false,
        can_focus: false,
        track_hover: false,
      });
      cell.hide();
      Main.layoutManager.uiGroup.add_child(cell);
      this._hudCells.push(cell);
    }
    return this._hudCells;
  }

  private _destroyHud(): void {
    for (const cell of this._hudCells) {
      cell.destroy();
    }
    this._hudCells = [];
  }

  /// Fim do arrasto: consolida o drop (ADR 0028). Centro local → empilha em abas (merge); eixo local →
  /// MoveWindow escopo `local` (split 50/50 do slot do alvo, resolvido pelo core); escopo global →
  /// MoveWindow `global` (bloco de 50% / maximizar no centro). O `_scheduleRelayout()` re-tila das árvores.
  private _onGrabEnd(window: Meta.Window | null): void {
    if (this._draggedId && window) {
      const [x, y] = global.get_pointer();
      const target = this._windowUnderPointObj(x, y, this._draggedId);
      const hot = this._lastHot;
      const targetId = target ? target.get_stable_sequence() : 0;
      const workspace = window.get_workspace();
      const key = orderKey(window.get_monitor(), workspace ? workspace.index() : 0);
      console.log(
        `[etherbit][drag] soltar: zona=${hot?.dropZone ?? 'none'} escopo=${hot?.scope ?? '-'}` +
          ` arrastada=${this._draggedId} alvo=${target ? targetId : 'nenhum'}`,
      );
      const moveWindow = (zoneStr: string, scope: 'local' | 'global'): void => {
        const res = this._call((p) =>
          p.MoveWindowSync(
            serializeState(this._stacks, this._disabledGroups, this._trees, this._draggedId),
            String(this._draggedId),
            String(targetId),
            zoneStr,
            serializeScope(scope),
          ),
        );
        if (res) {
          this._trees = parseLayoutTrees(res[0]);
        }
      };
      if (hot && hot.scope === 'local' && target && hot.dropZone === 'center') {
        // Centro de uma janela-alvo → empilha em abas (merge): estado de stacks local, o GNOME conserva
        // abas e NÃO manda `center` como MoveWindow. O core não muta a árvore neste caso.
        addToStack(this._stacks, key, targetId, this._draggedId);
      } else if (hot && hot.scope === 'global' && hot.dropZone !== 'none') {
        // Gap vazio: 50% pela borda (ou maximizar no centro) como nó principal — não exige janela-alvo.
        moveWindow(hot.dropZone, 'global');
      } else if (hot && hot.scope === 'local' && hot.dropZone !== 'none') {
        // Eixo de uma janela-alvo (fora do centro) → split 50/50 do slot do alvo (o core resolve).
        moveWindow(hot.dropZone, 'local');
      }
    } else if (
      this._resizeStart &&
      window &&
      window.get_stable_sequence() === this._resizeStart.id
    ) {
      this._applyResize(window);
    }
    this._resizeStart = null;
    this._stopDrag();
  }

  /// Fim de um resize manual: deriva a(s) borda(s) e o delta do frame inicial→final e aplica o resize
  /// elástico na árvore via `ResizeWindow` (uma chamada por eixo). O `_scheduleRelayout()` re-tila.
  private _applyResize(window: Meta.Window): void {
    const start = this._resizeStart;
    if (!start) {
      return;
    }
    const r = window.get_frame_rect();
    const deltas = resizeDeltaFrom(start.rect, {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    });
    const focus = global.display.focus_window;
    const focusedId = focus ? focus.get_stable_sequence() : 0;
    const monitorsJson = serializeMonitors(this._collectMonitors());
    for (const d of deltas) {
      const res = this._call((p) =>
        p.ResizeWindowSync(
          monitorsJson,
          serializeState(this._stacks, this._disabledGroups, this._trees, focusedId),
          String(start.id),
          d.edge,
          d.deltaPx,
        ),
      );
      if (res) {
        this._trees = parseLayoutTrees(res[0]);
      }
    }
  }

  /// Janela NORMAL cujo frame contém `(x, y)`, excluindo `excludeId` (a própria arrastada).
  private _windowUnderPointObj(x: number, y: number, excludeId: number): Meta.Window | null {
    const workspace = global.workspace_manager.get_active_workspace();
    const windows = workspace ? workspace.list_windows() : [];
    for (const window of windows) {
      const id = window.get_stable_sequence();
      if (id === excludeId || window.get_window_type() !== Meta.WindowType.NORMAL) {
        continue;
      }
      const r = window.get_frame_rect();
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
        return window;
      }
    }
    return null;
  }

  /// Para o loop de amostragem, destrói o overlay e zera o estado de arrasto.
  private _stopDrag(): void {
    if (this._dragSource) {
      GLib.source_remove(this._dragSource);
      this._dragSource = 0;
    }
    this._destroyHud();
    this._draggedId = 0;
    this._lastPointer = null;
    this._lastHot = null;
    this._resolving = false;
  }

  // ---- Atalhos globais (Super+Y / Super+S) ----

  /// Chave `(monitor, workspace)` do grupo "ativo": monitor da janela focada (ou 0) + workspace atual.
  private _activeGroupKey(): string {
    const workspace = global.workspace_manager.get_active_workspace();
    const wsIndex = workspace ? workspace.index() : 0;
    const focus = global.display.focus_window;
    const monitor = focus ? focus.get_monitor() : 0;
    return orderKey(monitor, wsIndex);
  }

  /// Super+Y: liga/desliga o tiling APENAS no grupo ativo. Os demais seguem intocados (isolados por
  /// grupo no core). Ao desligar, as janelas voltam a flutuar (o core pula o grupo).
  private _toggleTilingShortcut(): void {
    toggleGroupDisabled(this._disabledGroups, this._activeGroupKey());
    this._scheduleRelayout();
  }

  /// Super+S: empilha as janelas do grupo ativo em abas; se já houver stack, desfaz (ungroup).
  private _toggleTabbingShortcut(): void {
    const key = this._activeGroupKey();
    const ids = this._groupTiled.get(key) ?? [];
    const focus = global.display.focus_window;
    const activeId = focus ? focus.get_stable_sequence() : (ids[0] ?? 0);
    toggleStackGroup(this._stacks, key, ids, activeId);
    this._scheduleRelayout();
  }

  // ---- Barra de abas (desenhada pela ponte; geometria vem do core) ----

  /// Recria as barras de abas a partir das `TabBar` devolvidas pelo core. Recriar a cada relayout é
  /// simples e barato (só existem quando há stacks). Cada aba mostra ícone + título nativos.
  private _rebuildTabBars(tabBars: TabBar[], byId: Map<number, Meta.Window>): void {
    this._destroyTabBars();
    for (const bar of tabBars) {
      const box = new St.BoxLayout({
        style_class: 'etherbit-tab-bar',
        reactive: true,
        can_focus: false,
      });
      box.set_style(
        'background-color: rgba(46, 52, 64, 0.92);' +
          'border-radius: 8px; padding: 2px; spacing: 2px;',
      );
      for (const memberId of bar.members) {
        box.add_child(this._makeTabButton(byId.get(memberId), memberId, memberId === bar.active));
      }
      box.set_position(bar.x, bar.y);
      // Clamp ≥ 1px: uma barra degenerada (0×0) vinda do core alimentaria o framebuffer do Cogl com
      // `set_size` e dispararia `cogl_framebuffer_set_viewport: assertion 'width > 0 && height > 0'`.
      box.set_size(Math.max(1, bar.width), Math.max(1, bar.height));
      Main.layoutManager.uiGroup.add_child(box);
      this._tabBars.push(box);
    }
  }

  /// Uma guia (aba): container reativo com [conteúdo clicável → ativa a aba] + [ícone "x" → fecha o
  /// app]. Clique com o botão DIREITO em qualquer ponto da guia abre o menu de contexto "Desagrupar".
  private _makeTabButton(
    window: Meta.Window | undefined,
    memberId: number,
    isActive: boolean,
  ): St.Widget {
    const tab = new St.BoxLayout({
      style_class: isActive ? 'etherbit-tab etherbit-tab-active' : 'etherbit-tab',
      reactive: true,
      x_expand: true,
    });
    tab.set_style(
      isActive
        ? 'background-color: rgba(94, 129, 172, 0.95); border-radius: 6px; color: #eceff4;'
        : 'background-color: transparent; border-radius: 6px; color: #d8dee9;',
    );

    // Conteúdo: ícone (via Shell.WindowTracker) + título. Clique esquerdo → ativa a aba.
    const content = new St.BoxLayout({ style_class: 'etherbit-tab-content' });
    content.set_style('spacing: 6px; padding: 0 8px;');
    const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
    if (app) {
      content.add_child(app.create_icon_texture(16));
    }
    content.add_child(
      new St.Label({ text: window?.get_title() ?? '', y_align: Clutter.ActorAlign.CENTER }),
    );
    const activateBtn = new St.Button({ x_expand: true, child: content });
    activateBtn.set_style('background-color: transparent; border-radius: 6px;');
    activateBtn.connect('clicked', () => {
      if (setActiveMember(this._stacks, memberId)) {
        this._scheduleRelayout();
      }
    });
    tab.add_child(activateBtn);

    // Ícone de fechar "x": clique esquerdo encerra o app daquela janela (o sinal `unmanaged` limpa
    // ordem/stacks e re-tila). Mínimo e à direita do título, como pede o ADR.
    const closeBtn = new St.Button({
      style_class: 'etherbit-tab-close',
      child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }),
      y_align: Clutter.ActorAlign.CENTER,
    });
    closeBtn.set_style('padding: 0 4px;');
    closeBtn.connect('clicked', () => {
      window?.delete(global.get_current_time());
    });
    tab.add_child(closeBtn);

    // Clique com o botão DIREITO em qualquer ponto da guia → menu de contexto.
    tab.connect('button-press-event', (_actor: Clutter.Actor, event: Clutter.Event) => {
      if (event.get_button() === Clutter.BUTTON_SECONDARY) {
        this._openTabContextMenu(tab, memberId);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    return tab;
  }

  /// Abre o menu de contexto da aba: um único item "Desagrupar Janela", que tira a janela do stack e a
  /// devolve ao grid como nó independente. `removeIdFromStacks` muta o estado leve; o `reconcile`
  /// reexpande a folha no próximo relayout.
  private _openTabContextMenu(source: St.Widget, memberId: number): void {
    this._destroyTabMenu();
    if (!this._tabMenuAnchor) {
      // Anchor estável para o grab do manager (as guias são efêmeras — recriadas no relayout).
      this._tabMenuAnchor = new St.Widget({ reactive: false });
      Main.layoutManager.uiGroup.add_child(this._tabMenuAnchor);
    }
    if (!this._tabMenuManager) {
      this._tabMenuManager = new PopupMenu.PopupMenuManager(this._tabMenuAnchor);
    }
    const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
    menu.addAction('Desagrupar Janela', () => {
      if (removeIdFromStacks(this._stacks, memberId)) {
        this._scheduleRelayout();
      }
    });
    Main.layoutManager.uiGroup.add_child(menu.actor);
    menu.actor.hide();
    this._tabMenuManager.addMenu(menu);
    menu.connect('open-state-changed', (_m, isOpen: boolean) => {
      if (!isOpen) {
        this._destroyTabMenu();
      }
      return false;
    });
    this._tabMenu = menu;
    menu.open();
  }

  /// Fecha e descarta o menu de contexto atual (se houver). Idempotente.
  private _destroyTabMenu(): void {
    const menu = this._tabMenu;
    if (!menu) {
      return;
    }
    this._tabMenu = null;
    this._tabMenuManager?.removeMenu(menu);
    menu.destroy();
  }

  private _destroyTabBars(): void {
    // Fecha o menu ANTES de destruir as guias (o menu é ancorado numa guia).
    this._destroyTabMenu();
    for (const box of this._tabBars) {
      box.destroy();
    }
    this._tabBars = [];
  }

  /// Libera as janelas do grid para o comportamento flutuante do sistema (chave geral desligada):
  /// desminimiza abas, baixa as elevadas, descarta as barras de aba e remove o efeito de cantos. NÃO
  /// limpa o estado leve (ordem/stacks/árvores) — assim religar o tiling reorganiza tudo de volta.
  private _releaseToFloating(): void {
    // Chave geral DESLIGADA libera as janelas: invalida a assinatura para que RELIGAR sempre reaplique
    // o grid, mesmo que o layout calculado coincida com o último de antes do desligamento.
    this._lastLayoutSig = '';
    this._restoreHiddenWindows();
    this._destroyTabBars();
    for (const { window } of this._tracked.values()) {
      const actor = window.get_compositor_private() as Clutter.Actor | null;
      if (actor) {
        clearRoundedCorners(actor);
      }
    }
  }

  /// Restaura o estado que NÓS impusemos: desminimiza abas inativas e baixa (remove always-on-top)
  /// as janelas que elevamos por auto-floating. Chamado no disable/cleanup.
  private _restoreHiddenWindows(): void {
    if (this._stackHidden.size === 0 && this._floatingAbove.size === 0) {
      return;
    }
    const byId = new Map<number, Meta.Window>();
    for (const actor of global.get_window_actors()) {
      const w = actor.get_meta_window();
      if (w) {
        byId.set(w.get_stable_sequence(), w);
      }
    }
    for (const id of this._stackHidden) {
      byId.get(id)?.unminimize();
    }
    for (const id of this._floatingAbove) {
      byId.get(id)?.unmake_above();
    }
    this._stackHidden.clear();
    this._floatingAbove.clear();
    this._mergeAttempted.clear();
  }

  /// Metadados brutos de uma janela (espelham o WindowDto do daemon). A filtragem é do core.
  private _snapshot(window: Meta.Window): WindowSnapshot {
    const frame = window.get_frame_rect();
    const wmClass = window.get_wm_class() ?? window.get_wm_class_instance() ?? '';
    const workspace = window.get_workspace();
    const normal = window.get_window_type() === Meta.WindowType.NORMAL;
    const resizable = window.resizeable;
    const maximizable = window.can_maximize();
    // Min-size REAL (ADR 0033, inverte o "força frame, ignora hints" do 0021/0028): no Wayland o
    // cliente RECUSA encolher abaixo do seu `xdg min_size` — zerar o hint não fixa o app no slot,
    // só o faz transbordar/ser ejetado para flutuante. Enviamos o mínimo real e deixamos o core
    // sinalizar "não cabe" (overflow → `floating`) quando o quadrante for menor que o app; a ponte
    // resolve via Merge Fallback (abas), onde cada aba recebe o slot inteiro.
    const [minWidth, minHeight] = this._minSize(window);
    return {
      id: window.get_stable_sequence(),
      app_id: wmClass,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      normal,
      resizable,
      maximizable,
      // `get_monitor()` devolve -1 para janela sem monitor; clampa a 0 para o JSON nunca carregar um
      // índice negativo (que invalidaria a desserialização no daemon → SyncWindows falho).
      monitor: Math.max(0, window.get_monitor()),
      workspace: Math.max(0, workspace ? workspace.index() : 0),
      min_width: minWidth,
      min_height: minHeight,
      maximized: this._isMaximized(window),
    };
  }

  /// `true` se a janela ainda é manipulável: tem ator no compositor e ele não foi destruído. O GJS
  /// NÃO expõe `stack_position` no `Meta.Window`; usamos a presença/validade do ator
  /// (`get_compositor_private()` + `WindowActor.is_destroyed()`) — que casa com o estado que zera o
  /// stack do Mutter (`stack_position == -1`) e faria `make_above()`/`raise()` dispararem
  /// `meta_window_set_stack_position_no_sync: assertion 'window->stack_position >= 0' failed`.
  private _isWindowLive(window: Meta.Window): boolean {
    try {
      const actor = window.get_compositor_private() as Meta.WindowActor | null;
      return actor !== null && !actor.is_destroyed();
    } catch {
      return false;
    }
  }

  /// Agenda um callback para o próximo BEFORE_REDRAW do Mutter. A API mudou entre versões (45→50):
  /// GNOME 46+ usa `global.compositor.get_laters().add()`; versões antigas, `Meta.later_add()`
  /// (feature detection, ver ADR 0023). Sem nenhuma das duas, executa já (modo degradado).
  private _laterAdd(callback: () => boolean): number {
    const laters = (
      global.compositor as unknown as {
        get_laters?: () => { add: (when: number, cb: () => boolean) => number };
      }
    )?.get_laters?.();
    if (laters) {
      return laters.add(Meta.LaterType.BEFORE_REDRAW, callback);
    }
    const fn = (Meta as unknown as { later_add?: (when: number, cb: () => boolean) => number })
      .later_add;
    if (typeof fn === 'function') {
      return fn(Meta.LaterType.BEFORE_REDRAW, callback);
    }
    callback();
    return 0;
  }

  /// Cancela um "later" agendado por `_laterAdd` (mesma feature detection).
  private _laterRemove(id: number): void {
    if (!id) {
      return;
    }
    const laters = (
      global.compositor as unknown as { get_laters?: () => { remove: (id: number) => void } }
    )?.get_laters?.();
    if (laters) {
      laters.remove(id);
      return;
    }
    const fn = (Meta as unknown as { later_remove?: (id: number) => void }).later_remove;
    if (typeof fn === 'function') {
      fn(id);
    }
  }

  /// Enfileira uma operação de restack para rodar no próximo BEFORE_REDRAW, quando o Mutter já
  /// atribuiu `stack_position` válido. Lote único por ciclo: várias operações de um relayout
  /// compartilham o mesmo "later". Cada ação é isolada em try/catch.
  private _enqueueRestack(action: () => void): void {
    this._restackQueue.push(action);
    if (this._restackLaterId) {
      return;
    }
    this._restackLaterId = this._laterAdd(() => {
      const queue = this._restackQueue;
      this._restackQueue = [];
      this._restackLaterId = 0;
      for (const run of queue) {
        try {
          run();
        } catch (error) {
          console.error(`Etherbit Tiling: restack adiado falhou: ${error}`);
        }
      }
      // Restacks aplicados: o foco/stack que NÓS mexemos assentou. Libera a supressão (com settle),
      // disparando o relayout pendente se um trigger legítimo chegou no intervalo.
      this._releaseSuppression();
      return GLib.SOURCE_REMOVE;
    });
  }

  /// `true` se a janela está maximizada em AMBOS os eixos (estado, não a capacidade `can_maximize`).
  /// Base do Unmaximize Recovery: o core mantém janelas maximizadas fora do grid (ou preserva o slot).
  ///
  /// A API do Mutter para ler o estado de maximização mudou entre versões do GNOME Shell
  /// (45→50). Em alvos onde `get_maximized()` não existe o Shell lança em loop
  /// `TypeError: window.get_maximized is not a function`, paralisando o relayout. Por isso
  /// detectamos o método disponível em runtime — mesmo padrão defensivo de `_minSize` —, sempre
  /// exigindo AMBOS os eixos (o contrato da função; um `!== 0` cru marcaria como maximizada uma
  /// janela maximizada só na horizontal/vertical e a tiraria do grid indevidamente).
  private _isMaximized(window: Meta.Window): boolean {
    const w = window as unknown as {
      get_maximized_state?: () => number;
      get_maximized?: () => number;
      maximized_horizontally?: boolean;
      maximized_vertically?: boolean;
    };
    try {
      const both = Meta.MaximizeFlags.BOTH;
      if (typeof w.get_maximized_state === 'function') {
        return w.get_maximized_state() === both;
      }
      if (typeof w.get_maximized === 'function') {
        return w.get_maximized() === both;
      }
      // Fallback universal: propriedades booleanas estáveis em toda a linha do Meta.Window.
      return w.maximized_horizontally === true && w.maximized_vertically === true;
    } catch {
      return false;
    }
  }

  /// `true` se a janela é tileável (espelha o filtro `is_tileable` do core: tipo NORMAL + redimensionável
  /// + maximizável). Usado SÓ para travar o one-shot de `size-changed`: não trava enquanto a janela não
  /// for tileável, evitando que um `size-changed` precoce (antes do tipo/flags assentarem) queime o
  /// gatilho e deixe a janela fora do grid (bug de init com apps mistos). Defensivo: nunca lança.
  private _isTileable(window: Meta.Window): boolean {
    try {
      return (
        window.get_window_type() === Meta.WindowType.NORMAL &&
        window.resizeable === true &&
        window.can_maximize()
      );
    } catch {
      return false;
    }
  }

  /// Spawn-unmaximize: com o Tiling ATIVO, uma janela que está maximizada e que o core ainda NÃO tilou
  /// "nasceu maximizada" (o app pediu tela cheia ao nascer) — desmaximiza para ela entrar na
  /// Distribuição Cíclica. Uma janela já tilada (em `_everTiled`) que o usuário maximiza é PRESERVADA
  /// (slot mantido, volta ao desmaximizar — Unmaximize Recovery), então NÃO é tocada aqui. Defensivo.
  private _spawnUnmaximizeIfBorn(window: Meta.Window, id: number): void {
    if (!this._config.enabled || this._everTiled.has(id) || !this._isMaximized(window)) {
      return;
    }
    try {
      // Mutter >= 46 (GNOME 46+/Mutter 50) mudou a assinatura de `Meta.Window.unmaximize()` para ZERO
      // argumentos — sempre desmaximiza em ambos os eixos. Passar `MaximizeFlags.BOTH` dispara
      // `JS WARNING: Too many arguments to method Meta.Window.unmaximize: expected 0, got 1` e a
      // desmaximização NÃO acontece: a janela "nascida maximizada" fica presa em `maximized`, o core a
      // exclui do grid (retain_tileable_when_maximized) e ela flutua em tela cheia (regressão do spawn).
      // Os tipos @girs ainda declaram 1 arg (GNOME 45); cast cirúrgico + fallback à assinatura legada
      // mantêm a compat 45→50 (ADR 0023): tenta 0-arg (Mutter >= 46) e cai p/ 1-arg só se lançar.
      const unmaximize = window.unmaximize as unknown as (flags?: Meta.MaximizeFlags) => void;
      try {
        unmaximize.call(window);
      } catch {
        unmaximize.call(window, Meta.MaximizeFlags.BOTH);
      }
    } catch (error) {
      console.error(`Etherbit Tiling: spawn-unmaximize falhou na janela ${id}: ${error}`);
    }
  }

  /// Tamanho mínimo (px de frame) imposto pelo app via `Meta.Window.get_min_size()` — funciona em
  /// X11 (WM_NORMAL_HINTS) e Wayland (xdg_toplevel.set_min_size). Degrada para `[0, 0]` (sem
  /// restrição) se o método não existir ou lançar — nunca derruba o snapshot.
  private _minSize(window: Meta.Window): [number, number] {
    try {
      const fn = (window as unknown as { get_min_size?: () => [number, number] }).get_min_size;
      if (typeof fn !== 'function') {
        return [0, 0];
      }
      const [w, h] = fn.call(window);
      return [Number.isFinite(w) ? Math.max(0, w) : 0, Number.isFinite(h) ? Math.max(0, h) : 0];
    } catch {
      return [0, 0];
    }
  }

  /// Áreas úteis de cada monitor (já descontadas barras/docks do Shell).
  private _collectMonitors(): MonitorSnapshot[] {
    const monitors: MonitorSnapshot[] = [];
    const count = global.display.get_n_monitors();
    for (let index = 0; index < count; index += 1) {
      const area = Main.layoutManager.getWorkAreaForMonitor(index);
      monitors.push({ index, x: area.x, y: area.y, width: area.width, height: area.height });
    }
    return monitors;
  }
}
