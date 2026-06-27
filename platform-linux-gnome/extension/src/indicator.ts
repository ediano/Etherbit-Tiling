// indicator.ts — indicador do Etherbit na barra superior do GNOME Shell.
//
// Segue a regra do macOS: o indicador só existe enquanto o motor está ativo. No Linux o motor
// liga/desliga junto com a extensão (ver ADR de nomenclatura/decisões), então o indicador é
// criado em enable() e destruído em disable(). Dá acesso rápido a gaps, borda ativa e autostart.

import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import type { TilingConfig } from './dbus.js';

/// Gap máximo (px) representável pelos sliders (0..1 → 0..MAX_GAP).
const MAX_GAP = 50;

/// Callbacks disparados pelas interações do usuário no menu.
export interface IndicatorHandlers {
  onGaps: (inner: number, outer: number) => void;
  onActiveBorder: (enabled: boolean) => void;
  onAutostart: (enabled: boolean) => void;
}

class EtherbitIndicatorImpl extends PanelMenu.Button {
  private _handlers: IndicatorHandlers;
  private _innerSlider!: Slider;
  private _outerSlider!: Slider;
  private _borderSwitch!: PopupMenu.PopupSwitchMenuItem;
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

    this._innerSlider = this._addSliderRow('Gap interno', () => this._emitGaps());
    this._outerSlider = this._addSliderRow('Gap externo', () => this._emitGaps());

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._borderSwitch = new PopupMenu.PopupSwitchMenuItem('Borda ativa', false);
    this._borderSwitch.connect('toggled', (_item, state) => {
      if (!this._syncing) this._handlers.onActiveBorder(state);
    });
    this._menu.addMenuItem(this._borderSwitch);

    this._autostartSwitch = new PopupMenu.PopupSwitchMenuItem('Iniciar com o sistema', false);
    this._autostartSwitch.connect('toggled', (_item, state) => {
      if (!this._syncing) this._handlers.onAutostart(state);
    });
    this._menu.addMenuItem(this._autostartSwitch);
  }

  /// Reflete a configuração vinda do daemon nos controles, sem disparar handlers.
  sync(config: TilingConfig): void {
    this._syncing = true;
    this._innerSlider.value = Math.min(config.inner_gap / MAX_GAP, 1);
    this._outerSlider.value = Math.min(config.outer_gap / MAX_GAP, 1);
    this._borderSwitch.setToggleState(config.active_border);
    this._autostartSwitch.setToggleState(config.autostart);
    this._syncing = false;
  }

  private _addSliderRow(label: string, onChange: () => void): Slider {
    const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
    item.add_child(new St.Label({ text: label }));

    const slider = new Slider(0);
    slider.x_expand = true;
    slider.connect('notify::value', () => {
      if (!this._syncing) onChange();
    });
    item.add_child(slider);

    this._menu.addMenuItem(item);
    return slider;
  }

  private _emitGaps(): void {
    const inner = Math.round(this._innerSlider.value * MAX_GAP);
    const outer = Math.round(this._outerSlider.value * MAX_GAP);
    this._handlers.onGaps(inner, outer);
  }
}

// registerClass não preserva a assinatura do construtor customizado; reexpomos com o tipo correto.
export type EtherbitIndicator = EtherbitIndicatorImpl;
export const EtherbitIndicator = GObject.registerClass(
  EtherbitIndicatorImpl,
) as unknown as new (handlers: IndicatorHandlers) => EtherbitIndicatorImpl;
