// i18n.js — internacionalização leve, sem dependências de runtime (ADR 0032).
//
// Inglês é o default global; pt-BR só quando o navegador indicar pt (1º acesso),
// ou quando o usuário escolher (persistido em localStorage). A URL nunca muda:
// a troca é puramente client-side, trocando o conteúdo dos elementos anotados.
//
// Como anotar o HTML (o conteúdo pt-BR atual fica como fallback inline):
//   <p data-i18n="hero.subtitle">…</p>            → troca innerHTML
//   <a data-i18n-aria-label="brand.aria">…</a>    → troca o atributo aria-label
//   <meta data-i18n-content="meta.description">    → troca o atributo content
// Qualquer atributo `data-i18n-<attr>="chave"` vira `setAttribute('<attr>', valor)`.
import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';

const DICTS = { en, 'pt-BR': ptBR };
const SUPPORTED = Object.keys(DICTS);
const STORAGE_KEY = 'etherbit-lang';
const DEFAULT_LANG = 'en';

/// Idioma efetivo: escolha salva > idioma do navegador > inglês (default global).
export function resolveLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
  } catch {
    // localStorage indisponível (modo privado/SSR) — segue para a detecção.
  }
  const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
  return nav.startsWith('pt') ? 'pt-BR' : DEFAULT_LANG;
}

/// Busca uma string traduzida, com fallback estrito ao inglês e depois à chave.
export function t(key, lang = currentLang) {
  const dict = DICTS[lang] || DICTS[DEFAULT_LANG];
  return dict[key] ?? DICTS[DEFAULT_LANG][key] ?? key;
}

let currentLang = DEFAULT_LANG;

/// Aplica o dicionário do idioma a todos os elementos anotados do documento.
export function applyTranslations(lang) {
  currentLang = SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
  document.documentElement.lang = currentLang;

  // Conteúdo: data-i18n="chave" → innerHTML (as strings são nossas, estáticas).
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.innerHTML = t(key);
  });

  // Atributos: qualquer data-i18n-<attr> → setAttribute(<attr>, valor).
  document.querySelectorAll('*').forEach((el) => {
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-i18n-')) {
        const target = attr.name.slice('data-i18n-'.length);
        el.setAttribute(target, t(attr.value));
      }
    }
  });

  updateToggle();
}

/// Persiste e aplica um novo idioma (chamado pelo botão de troca).
export function setLang(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Sem persistência possível — aplica só nesta sessão.
  }
  applyTranslations(lang);
}

/// Atualiza o rótulo/aria do botão de troca para refletir o ALVO da troca.
function updateToggle() {
  const btn = document.querySelector('[data-lang-toggle]');
  if (!btn) return;
  const target = currentLang === 'pt-BR' ? 'en' : 'pt-BR';
  btn.textContent = target === 'en' ? 'EN' : 'PT';
  btn.setAttribute('aria-label', t('lang.toggleAria'));
  btn.dataset.target = target;
}

/// Liga o botão de troca e aplica o idioma resolvido. Idempotente.
export function initI18n() {
  applyTranslations(resolveLang());
  const btn = document.querySelector('[data-lang-toggle]');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => setLang(btn.dataset.target || DEFAULT_LANG));
  }
}
