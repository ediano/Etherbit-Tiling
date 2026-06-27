// main.js — interatividade mínima e local (sem dependências de runtime).
import './style.css';

// Ano dinâmico no rodapé.
const yearEl = document.getElementById('year');
if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

// Copiar o comando de instalação do Linux.
const copyBtn = document.querySelector('[data-copy-btn]');
const cmdEl = document.getElementById('install-cmd');

if (copyBtn && cmdEl) {
  copyBtn.addEventListener('click', async () => {
    const text = cmdEl.textContent?.trim() ?? '';
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

    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copiado!';
    copyBtn.classList.add('is-copied');
    window.setTimeout(() => {
      copyBtn.textContent = original;
      copyBtn.classList.remove('is-copied');
    }, 1800);
  });
}
