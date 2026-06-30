// main.js — interatividade mínima e local (sem dependências de runtime).
import './style.css';
import { initI18n, t } from './i18n.js';

// i18n primeiro: troca o conteúdo dos elementos anotados e (re)cria o <span id="year">
// dentro do rodapé traduzido. O preenchimento do ano abaixo roda DEPOIS, por isso.
initI18n();

// Ano dinâmico no rodapé.
const yearEl = document.getElementById('year');
if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

// Copiar comandos: cada bloco `.code[data-copy]` tem seu próprio <code> e botão.
// Funciona tanto na home (1 bloco) quanto na página de desinstalação (vários).
document.querySelectorAll('.code[data-copy]').forEach((box) => {
  const btn = box.querySelector('[data-copy-btn]');
  const cmdEl = box.querySelector('code');
  if (!btn || !cmdEl) return;

  // Blocos de comando único devem virar uma linha só ao copiar, mesmo que o
  // HTML quebre o comando em várias linhas por legibilidade. Já os blocos
  // `.code--block` (vários comandos) precisam preservar as quebras de linha.
  const isBlock = box.classList.contains('code--block');

  btn.addEventListener('click', async () => {
    const raw = cmdEl.textContent ?? '';
    const text = isBlock ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback para navegadores sem Clipboard API / contexto não seguro.
      const range = document.createRange();
      range.selectNodeContents(cmdEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand('copy');
      sel?.removeAllRanges();
    }

    const original = btn.textContent;
    btn.textContent = t('copy.done');
    btn.classList.add('is-copied');
    window.setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('is-copied');
    }, 1800);
  });
});
