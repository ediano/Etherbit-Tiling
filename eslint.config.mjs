// Flat config do ESLint para todo o monorepo (ver rules/0036).
// Estratégia: lint de correção (não de estilo) — o Prettier cuida da formatação e o
// eslint-config-prettier (último) desliga qualquer regra que conflite com ele. Não usamos
// type-checked linting: os 3 projetos JS/TS têm ambientes de globais distintos (GJS, KWin,
// navegador) e o `tsc --noEmit` de cada subprojeto já cobre os erros de tipo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    // Artefatos gerados e dependências — espelha o .prettierignore.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-release/**',
      '**/target/**',
      'platform-linux-kde/kwin-script/contents/code/*.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Em TS o compilador resolve variáveis/globais (inclusive os ambientes em *.d.ts do KWin/GJS);
    // `no-undef` no ESLint sem type info daria falso-positivo. Recomendação oficial do typescript-eslint.
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
      // `catch (e) {}` que descarta o erro de propósito é comum aqui — e no KWin o target es2017
      // nem suporta optional catch binding (`catch {`), então o binding precisa existir. Ignora
      // caught errors e qualquer identificador prefixado com `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },

  {
    // Web: JavaScript puro rodando no navegador.
    files: ['web/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Desliga regras de estilo que conflitam com o Prettier — deve ser o ÚLTIMO.
  prettier,
);
