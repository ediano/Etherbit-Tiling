import { describe, it, expect } from 'vitest';
import { pickLang, initI18n, getLang, _ } from './i18n.js';

describe('pickLang', () => {
  it('escolhe pt-BR quando algum locale começa com pt', () => {
    expect(pickLang(['pt_BR.UTF-8', 'pt_BR', 'en'])).toBe('pt-BR');
    expect(pickLang(['pt'])).toBe('pt-BR');
    expect(pickLang(['PT_br'])).toBe('pt-BR');
  });

  it('cai no inglês (default global) para qualquer outro locale', () => {
    expect(pickLang(['en_US.UTF-8', 'en'])).toBe('en');
    expect(pickLang(['es_ES', 'fr_FR'])).toBe('en');
    expect(pickLang([])).toBe('en');
    expect(pickLang(undefined)).toBe('en');
  });
});

describe('initI18n + _', () => {
  it('traduz para pt-BR quando inicializado com locale pt', () => {
    initI18n(['pt_BR.UTF-8']);
    expect(getLang()).toBe('pt-BR');
    expect(_('toggle.enable')).toBe('Ativar tiling');
    expect(_('gap.label')).toBe('Espaçamento (px)');
    expect(_('radius.label')).toBe('Raio dos cantos (px)');
  });

  it('traduz para inglês quando inicializado com outro locale', () => {
    initI18n(['de_DE.UTF-8']);
    expect(getLang()).toBe('en');
    expect(_('toggle.enable')).toBe('Enable tiling');
    expect(_('gap.label')).toBe('Spacing (px)');
  });

  it('faz fallback à chave quando ela não existe', () => {
    expect(_('inexistente.chave')).toBe('inexistente.chave');
  });
});
