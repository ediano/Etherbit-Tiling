// indicator.ts — indicador do Etherbit na barra superior do GNOME Shell.
//
// Segue a regra do macOS: o indicador só existe enquanto o motor está ativo. No Linux o motor
// liga/desliga junto com a extensão (ver ADR de nomenclatura/decisões), então o indicador é
// criado em enable() e destruído em disable(). Dá acesso rápido à chave geral (ativar/desativar o
// tiling), ao gap e ao raio dos cantos.
//
// Controles: uma CHAVE GERAL (switch "Ativar tiling") no topo e dois INPUTS NUMÉRICOS inteiros
// (spinbox: digitar + botões − / +), com travas rígidas (ver ADR rules/0019): Gap 0..100 px, raio
// dos cantos 0..50 px (raio `0` = sem arredondamento; `> 0` = arredondado — não há toggle separado).
// A UI completa migrará para a janela própria do daemon (wgpu) no futuro (ver ADR rules/0016). Abaixo
// dos inputs, três chaves de comportamento COSMIC (ADR 0068): borda da janela ativa (desenhada pela
// extensão, que roda DENTRO do compositor), smart gaps e inserção ao lado da janela focada. Não há
// controle de autostart (o daemon já sobe via serviço/ativação D-Bus — ADR rules/0024).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type { TilingConfig } from './dbus.js';
import { _ } from './i18n.js';

/// Travas rígidas (px) dos inputs — espelham os limites do daemon e dos ADRs.
const GAP_MIN = 0;
const GAP_MAX = 100;
const RADIUS_MIN = 0;
const RADIUS_MAX = 50;

/// Handle de um spinbox: permite refletir a config sem disparar o handler.
interface SpinRow {
  setValue: (value: number) => void;
}

/// Callbacks disparados pelas interações do usuário no menu.
export interface IndicatorHandlers {
  onEnabled: (enabled: boolean) => void;
  onGap: (gap: number) => void;
  onCornerRadius: (radius: number) => void;
  onActiveBorder: (enabled: boolean) => void;
  onSmartGaps: (enabled: boolean) => void;
  onFocusInsert: (enabled: boolean) => void;
}

class EtherbitIndicatorImpl extends PanelMenu.Button {
  private _handlers: IndicatorHandlers;
  private _enabledSwitch!: PopupMenu.PopupSwitchMenuItem;
  private _gapSpin!: SpinRow;
  private _radiusSpin!: SpinRow;
  private _borderSwitch!: PopupMenu.PopupSwitchMenuItem;
  private _smartGapsSwitch!: PopupMenu.PopupSwitchMenuItem;
  private _focusInsertSwitch!: PopupMenu.PopupSwitchMenuItem;
  // Evita reentrância: ao refletir a config do daemon não queremos re-disparar handlers.
  private _syncing = false;

  // PanelMenu.Button sempre cria um PopupMenu real quando não passamos dontCreateMenu.
  private get _menu(): PopupMenu.PopupMenu {
    return this.menu as PopupMenu.PopupMenu;
  }

  constructor(handlers: IndicatorHandlers) {
    super(0.0, 'Etherbit Tiling');
    this._handlers = handlers;

    this.add_child(
      new St.Icon({
        icon_name: 'view-grid-symbolic',
        style_class: 'system-status-icon',
      }),
    );

    // Chave geral: liga/desliga o tiling em tempo real. Desligado, a ponte libera as janelas para
    // flutuar (o daemon segue vivo); ligado, reorganiza as janelas no grid. Fica no TOPO do menu.
    this._enabledSwitch = new PopupMenu.PopupSwitchMenuItem(_('toggle.enable'), true);
    this._keepOpenOnToggle(this._enabledSwitch);
    this._enabledSwitch.connect('toggled', (_item, state) => {
      if (!this._syncing) this._handlers.onEnabled(state);
    });
    this._menu.addMenuItem(this._enabledSwitch);

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._gapSpin = this._addSpinRow(_('gap.label'), GAP_MIN, GAP_MAX, (v) =>
      this._handlers.onGap(v),
    );
    // Raio dos cantos: `0` desativa o arredondamento; qualquer valor `> 0` o ativa (não há mais um
    // toggle separado — o valor é a única fonte de verdade do comportamento).
    this._radiusSpin = this._addSpinRow(_('radius.label'), RADIUS_MIN, RADIUS_MAX, (v) =>
      this._handlers.onCornerRadius(v),
    );

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    this._borderSwitch = this._addSwitch(_('toggle.border'), (v) =>
      this._handlers.onActiveBorder(v),
    );
    this._smartGapsSwitch = this._addSwitch(_('toggle.smartGaps'), (v) =>
      this._handlers.onSmartGaps(v),
    );
    this._focusInsertSwitch = this._addSwitch(_('toggle.focusInsert'), (v) =>
      this._handlers.onFocusInsert(v),
    );
  }

  /// Chave de comportamento que não fecha o menu ao alternar.
  private _addSwitch(label: string, onChange: (v: boolean) => void): PopupMenu.PopupSwitchMenuItem {
    const item = new PopupMenu.PopupSwitchMenuItem(label, false);
    this._keepOpenOnToggle(item);
    item.connect('toggled', (_item, state) => {
      if (!this._syncing) onChange(state);
    });
    this._menu.addMenuItem(item);
    return item;
  }

  /// Faz um switch ALTERNAR sem fechar o painel. O `activate` padrão de um item de menu emite o sinal
  /// 'activate', que o PopupMenu trata FECHANDO o menu — por isso o painel sumia a cada toggle. Aqui
  /// trocamos o `activate` por um toggle puro: o 'toggled' segue disparando o handler, mas nada fecha
  /// o menu. O fechamento legítimo (clicar fora / clicar de novo no ícone) continua via o grab modal
  /// do PanelMenu.Button.
  private _keepOpenOnToggle(item: PopupMenu.PopupSwitchMenuItem): void {
    (item as unknown as { activate: () => void }).activate = (): void => {
      item.toggle();
    };
  }

  /// Reflete a configuração vinda do daemon nos controles, sem disparar handlers.
  sync(config: TilingConfig): void {
    this._syncing = true;
    this._enabledSwitch.setToggleState(config.enabled);
    this._gapSpin.setValue(config.gap);
    this._radiusSpin.setValue(config.corner_radius);
    this._borderSwitch.setToggleState(config.active_border);
    this._smartGapsSwitch.setToggleState(config.smart_gaps);
    this._focusInsertSwitch.setToggleState(config.insert_mode !== 'cyclic');
    this._syncing = false;
  }

  /// Cria uma linha de AJUSTE NUMÉRICO inteiro: rótulo + [−] [valor] [+]. O valor é um DISPLAY (label
  /// desativada, centralizada — `Npx`), não um campo editável: a interação é ESTRITAMENTE pelos botões
  /// `−`/`+` (sempre inteiro, travado em `[min, max]`). O hover acontece SÓ nos botões — a linha é
  /// não-reativa, então o contêiner pai não acende. `onChange` recebe o valor já validado.
  private _addSpinRow(
    label: string,
    min: number,
    max: number,
    onChange: (value: number) => void,
  ): SpinRow {
    // Linha NÃO-REATIVA: sem hover/realce do item inteiro (o efeito de foco fica isolado nos botões).
    // `can_focus: false` casa com o display ser só leitura; os botões filhos seguem reativos por conta
    // própria (a reatividade é por-ator, um pai não-reativo não bloqueia filhos reativos).
    const item = new PopupMenu.PopupBaseMenuItem({
      activate: false,
      reactive: false,
      can_focus: false,
    });
    item.add_child(
      new St.Label({ text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER }),
    );

    let value = min;
    const clamp = (v: number): number => Math.max(min, Math.min(max, Math.round(v)));

    // DISPLAY numérico: label CENTRALIZADA e desativada (não editável) — `Npx`. Centraliza de forma
    // confiável (`text-align: center` + `x_align: CENTER`) sem depender do toolkit alinhar um St.Entry,
    // e elimina por construção o ruído "St.Entry ... already disposed" (não há mais `clutter_text` nem
    // handlers de foco). Largura fixa acomoda até "100px" sem deslocar os botões.
    const valueLabel = new St.Label({
      style_class: 'etherbit-spin-value',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    valueLabel.set_style('min-width: 48px; text-align: center; font-feature-settings: "tnum";');

    // Botões −/+ ROBUSTOS e simétricos, conversando com o toggle mestre (mesma altura visual). Quadrado
    // 26×26 com glifo CENTRALIZADO, padding equilibrado e `border-radius` TRAVADO em 8px (≤ 8px = trava
    // rígida do ADR 0027; mantém canto suave sem virar pílula). Sem `style_class: 'button'` (que traria
    // borda/padding pesados do tema). O hover é PRÓPRIO (notify::hover) — feedback estritamente no botão.
    const BTN_BASE =
      'min-width: 26px; width: 26px; height: 26px; padding: 0; margin: 0 4px; border: none; ' +
      'border-radius: 8px; font-weight: bold; font-size: 15px; text-align: center; ';
    const BTN_BG = 'background-color: rgba(255, 255, 255, 0.10);';
    const BTN_BG_HOVER = 'background-color: rgba(255, 255, 255, 0.20);';
    // NÃO passamos x_align/y_align aqui: St.Button herda de St.Bin, cujo `x-align`/`y-align` é o enum
    // St.Align (MIDDLE = 1) e colidiria com Clutter.ActorAlign.CENTER (= 2 = St.Align.END), DESALINHANDO
    // o glifo. O St.Bin já centraliza o filho por padrão; `text-align: center` reforça o eixo horizontal.
    const minus = new St.Button({ label: '−', style_class: 'etherbit-spin-btn', can_focus: true });
    const plus = new St.Button({ label: '+', style_class: 'etherbit-spin-btn', can_focus: true });
    // Hover ISOLADO: cada botão pinta o próprio realce em `notify::hover`; nada acende a linha inteira.
    const paint = (btn: St.Button): void => {
      btn.set_style(BTN_BASE + (btn.hover ? BTN_BG_HOVER : BTN_BG));
    };
    minus.connect('notify::hover', () => paint(minus));
    plus.connect('notify::hover', () => paint(plus));
    paint(minus);
    paint(plus);

    const render = (): void => {
      // A label pode já ter sido descartada (disable durante um ConfigChanged em voo): não lança.
      try {
        valueLabel.set_text(`${value}px`);
      } catch (error) {
        // St.Label descartada — ignora
      }
    };
    // Aplica um valor do USUÁRIO: trava, atualiza o display e dispara o handler.
    const apply = (v: number): void => {
      value = clamp(v);
      render();
      if (!this._syncing) {
        onChange(value);
      }
    };

    minus.connect('clicked', () => apply(value - 1));
    plus.connect('clicked', () => apply(value + 1));

    item.add_child(minus);
    item.add_child(valueLabel);
    item.add_child(plus);
    this._menu.addMenuItem(item);

    return {
      // Sincroniza a partir da config (sem disparar `onChange`).
      setValue: (v: number): void => {
        value = clamp(v);
        render();
      },
    };
  }
}

// registerClass não preserva a assinatura do construtor customizado; reexpomos com o tipo correto.
export type EtherbitIndicator = EtherbitIndicatorImpl;
// GTypeName único por carga do módulo: o loader reimporta versões novas no mesmo processo do Shell
// (ADR 0071), e registrar de novo o mesmo nome de GType derrubaria o enable.
export const EtherbitIndicator = GObject.registerClass(
  { GTypeName: `EtherbitIndicator_${GLib.uuid_string_random().replace(/-/g, '')}` },
  EtherbitIndicatorImpl,
) as unknown as new (handlers: IndicatorHandlers) => EtherbitIndicatorImpl;
