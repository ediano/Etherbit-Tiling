// indicator.ts — indicador do Etherbit na barra superior do GNOME Shell.
//
// Segue a regra do macOS: o indicador só existe enquanto o motor está ativo. No Linux o motor
// liga/desliga junto com a extensão (ver ADR de nomenclatura/decisões), então o indicador é
// criado em enable() e destruído em disable(). Dá acesso rápido a gap, raio dos cantos e autostart.
//
// Controles via INPUT NUMÉRICO inteiro (spinbox: digitar + botões − / +), com travas rígidas (ver
// ADR rules/0019): Gap 0..100 px, raio dos cantos 0..50 px. A UI completa migrará para a janela
// própria do daemon (wgpu) no futuro (ver ADR rules/0016). NÃO há controle de "borda ativa" (a borda
// não é desenhável por um cliente Wayland; só pelo compositor).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type { TilingConfig } from './dbus.js';

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
  onGap: (gap: number) => void;
  onCornerRadius: (radius: number) => void;
  onRoundedCorners: (enabled: boolean) => void;
  onAutostart: (enabled: boolean) => void;
}

class EtherbitIndicatorImpl extends PanelMenu.Button {
  private _handlers: IndicatorHandlers;
  private _gapSpin!: SpinRow;
  private _radiusSpin!: SpinRow;
  private _roundedSwitch!: PopupMenu.PopupSwitchMenuItem;
  private _autostartSwitch!: PopupMenu.PopupSwitchMenuItem;
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

    this._gapSpin = this._addSpinRow('Espaçamento (px)', GAP_MIN, GAP_MAX, (v) =>
      this._handlers.onGap(v),
    );
    this._radiusSpin = this._addSpinRow('Raio dos cantos (px)', RADIUS_MIN, RADIUS_MAX, (v) =>
      this._handlers.onCornerRadius(v),
    );

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._roundedSwitch = new PopupMenu.PopupSwitchMenuItem('Cantos arredondados', true);
    this._keepOpenOnToggle(this._roundedSwitch);
    this._roundedSwitch.connect('toggled', (_item, state) => {
      if (!this._syncing) this._handlers.onRoundedCorners(state);
    });
    this._menu.addMenuItem(this._roundedSwitch);

    this._autostartSwitch = new PopupMenu.PopupSwitchMenuItem('Iniciar com o sistema', false);
    this._keepOpenOnToggle(this._autostartSwitch);
    this._autostartSwitch.connect('toggled', (_item, state) => {
      if (!this._syncing) this._handlers.onAutostart(state);
    });
    this._menu.addMenuItem(this._autostartSwitch);
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
    this._gapSpin.setValue(config.gap);
    this._radiusSpin.setValue(config.corner_radius);
    this._roundedSwitch.setToggleState(config.rounded_corners);
    this._autostartSwitch.setToggleState(config.autostart);
    this._syncing = false;
  }

  /// Cria uma linha de INPUT NUMÉRICO inteiro: rótulo + [−] [campo] [+]. Digitar ou clicar ajusta o
  /// valor, SEMPRE inteiro e travado em `[min, max]`. `onChange` recebe o valor já validado.
  private _addSpinRow(
    label: string,
    min: number,
    max: number,
    onChange: (value: number) => void,
  ): SpinRow {
    const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
    // Mantém o painel ABERTO ao mexer no input: anula o `activate` (que o PopupMenu trataria FECHANDO
    // o menu). O `activate: false` já evita o realce de seleção; isto blinda contra o fechamento em
    // qualquer versão do Shell. Fechar segue por ação explícita (clicar fora / clicar no ícone).
    (item as unknown as { activate: () => void }).activate = (): void => {};
    item.add_child(
      new St.Label({ text: label, x_expand: true, y_align: Clutter.ActorAlign.CENTER }),
    );

    let value = min;
    const clamp = (v: number): number => Math.max(min, Math.min(max, Math.round(v)));

    // Campo COMPACTO: ~metade da largura anterior (56→32 px), só o bastante para 3 dígitos inteiros
    // (o máximo é 100). Padding mínimo para não inflar a altura da linha.
    const entry = new St.Entry({
      style_class: 'etherbit-spin-entry',
      can_focus: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    entry.set_style('width: 32px; padding: 1px 4px; text-align: center;');

    // Botões −/+ MINIMALISTAS: sem o `style_class: 'button'` (que traz borda/padding pesados do tema),
    // pequenos e discretos ao redor do campo; fundo translúcido leve só para sinalizar que são clicáveis.
    const SPIN_BTN_STYLE =
      'min-width: 18px; width: 18px; height: 18px; padding: 0; margin: 0 3px; ' +
      'border: none; border-radius: 4px; background-color: rgba(255, 255, 255, 0.08); font-weight: bold;';
    const minus = new St.Button({ label: '−', style_class: 'etherbit-spin-btn', can_focus: true });
    const plus = new St.Button({ label: '+', style_class: 'etherbit-spin-btn', can_focus: true });
    minus.set_style(SPIN_BTN_STYLE);
    plus.set_style(SPIN_BTN_STYLE);

    const render = (): void => {
      // A entry pode já ter sido descartada (disable durante um ConfigChanged em voo): não lança.
      try {
        entry.set_text(String(value));
      } catch (error) {
        // St.Entry descartada — ignora
      }
    };
    // Aplica um valor do USUÁRIO: trava, atualiza o campo e dispara o handler.
    const apply = (v: number): void => {
      value = clamp(v);
      render();
      if (!this._syncing) {
        onChange(value);
      }
    };

    minus.connect('clicked', () => apply(value - 1));
    plus.connect('clicked', () => apply(value + 1));
    // Digitação: ao confirmar (Enter) ou sair do campo, parseia inteiro e trava (valor inválido →
    // restaura o atual).
    const commit = (): void => {
      // `key-focus-out` pode disparar durante o teardown, com a entry já descartada: lê em try/catch.
      let text: string;
      try {
        text = entry.get_text();
      } catch (error) {
        return; // St.Entry descartada — nada a confirmar
      }
      const parsed = Number.parseInt(text, 10);
      apply(Number.isFinite(parsed) ? parsed : value);
    };
    // Captura o `clutter_text` UMA vez e solta os handlers no `destroy` da PRÓPRIA entry. O Clutter
    // emite 'destroy' no início da destruição, com o `clutter_text` ainda vivo — então a desconexão
    // é segura e impede o `commit()` de disparar sobre uma entry já descartada. O código anterior
    // soltava no destroy do INDICADOR, mas o PopupMenu (dono das entries) é destruído por outro
    // caminho no shutdown do Shell, deixando o `clutter_text` morto e poluindo o journal com
    // "Object St.Entry ... has been already disposed".
    const clutterText = entry.clutter_text;
    const activateId = clutterText.connect('activate', () => commit());
    const focusOutId = clutterText.connect('key-focus-out', () => commit());
    entry.connect('destroy', () => {
      clutterText.disconnect(activateId);
      clutterText.disconnect(focusOutId);
    });

    item.add_child(minus);
    item.add_child(entry);
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
export const EtherbitIndicator = GObject.registerClass(
  EtherbitIndicatorImpl,
) as unknown as new (handlers: IndicatorHandlers) => EtherbitIndicatorImpl;
