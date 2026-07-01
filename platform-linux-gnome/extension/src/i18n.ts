// i18n.ts — internacionalização da extensão GNOME via dicionário literal (ADR 0032).
//
// A extensão é bundlada por Vite num único `extension.js`; em vez de gettext + catálogos
// `.mo` (que o instalador teria de instalar), usamos um mapeamento literal en/pt-BR. Inglês
// é o default global; pt-BR só quando o locale do sistema indicar `pt` (fallback estrito).
//
// Este módulo é PURO (sem `gi://…`) para ser testável em Node (vitest). A detecção do locale
// fica no extension.ts, que já importa GLib e chama `initI18n(GLib.get_language_names())`.

export type Lang = 'en' | 'pt-BR';

/// Chaves de UI → texto por idioma. Inglês é a fonte (default); pt-BR é a tradução.
const MESSAGES: Record<Lang, Record<string, string>> = {
  en: {
    'toggle.enable': 'Enable tiling',
    'gap.label': 'Spacing (px)',
    'radius.label': 'Corner radius (px)',
    'rigid.label': 'Fit rigid windows',
    'spawnMerge.label': 'Group on tight spawn',
  },
  'pt-BR': {
    'toggle.enable': 'Ativar tiling',
    'gap.label': 'Espaçamento (px)',
    'radius.label': 'Raio dos cantos (px)',
    'rigid.label': 'Ajustar janelas rígidas',
    'spawnMerge.label': 'Agrupar em spawn apertado',
  },
};

const DEFAULT_LANG: Lang = 'en';
let currentLang: Lang = DEFAULT_LANG;

/// Escolhe o idioma a partir de uma lista de locales (ex.: `GLib.get_language_names()`):
/// pt-BR se algum começar com `pt`; inglês caso contrário. Pura e testável.
export function pickLang(locales: readonly string[] | undefined): Lang {
  for (const loc of locales ?? []) {
    if (loc && loc.toLowerCase().startsWith('pt')) return 'pt-BR';
  }
  return DEFAULT_LANG;
}

/// Define o idioma corrente a partir dos locales detectados. Chamado uma vez no enable().
export function initI18n(locales: readonly string[] | undefined): void {
  currentLang = pickLang(locales);
}

/// Idioma corrente (para testes/diagnóstico).
export function getLang(): Lang {
  return currentLang;
}

/// Traduz uma chave para o idioma corrente, com fallback estrito ao inglês e depois à chave.
export function _(key: string, lang: Lang = currentLang): string {
  return MESSAGES[lang]?.[key] ?? MESSAGES[DEFAULT_LANG][key] ?? key;
}
