// indicator.ts — indicador do Etherbit na barra superior do GNOME Shell.
//
// Segue a regra do macOS: o indicador só existe enquanto o motor está ativo. No Linux o motor
// liga/desliga junto com a extensão (ver ADR de nomenclatura/decisões), então o indicador é
// criado em enable() e destruído em disable(). Dá acesso rápido a gaps e autostart.
//
// Controle leve por ora; a UI de configurações migrará para a janela própria do daemon (wgpu)
// no futuro (ver ADR rules/0016). NÃO há controle de "borda ativa" — recurso removido (a borda
// não é desenhável por um cliente Wayland; só pelo compositor).

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
  onGap: (gap: number) => void;
  onAutostart: (enabled: boolean) => void;
  onRoundedCorners: (enabled: boolean) => void;
}

class EtherbitIndicatorImpl extends PanelMenu.Button {
  private _handlers: IndicatorHandlers;
  private _gapSlider!: Slider;
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

    this._gapSlider = this._addSliderRow('Gap', () => this._emitGap());

    this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this._roundedSwitch = new PopupMenu.PopupSwitchMenuItem('Cantos arredondados', true);
    this._roundedSwitch.connect('toggled', (_item, state) => {
      if (!this._syncing) this._handlers.onRoundedCorners(state);
    });
    this._menu.addMenuItem(this._roundedSwitch);

    this._autostartSwitch = new PopupMenu.PopupSwitchMenuItem('Iniciar com o sistema', false);
    this._autostartSwitch.connect('toggled', (_item, state) => {
      if (!this._syncing) this._handlers.onAutostart(state);
    });
    this._menu.addMenuItem(this._autostartSwitch);
  }

  /// Reflete a configuração vinda do daemon nos controles, sem disparar handlers.
  sync(config: TilingConfig): void {
    this._syncing = true;
    this._gapSlider.value = Math.min(config.gap / MAX_GAP, 1);
    this._roundedSwitch.setToggleState(config.rounded_corners);
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

  private _emitGap(): void {
    const gap = Math.round(this._gapSlider.value * MAX_GAP);
    this._handlers.onGap(gap);
  }
}

// registerClass não preserva a assinatura do construtor customizado; reexpomos com o tipo correto.
export type EtherbitIndicator = EtherbitIndicatorImpl;
export const EtherbitIndicator = GObject.registerClass(
  EtherbitIndicatorImpl,
) as unknown as new (handlers: IndicatorHandlers) => EtherbitIndicatorImpl;
