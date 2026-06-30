# 0032 — Internacionalização (i18n) multilíngue de UI e instalador (en default, pt-BR por locale)

**Status:** ✅ Aceita
(emenda [0001](0001-idioma-portugues.md) — restringe o pt-BR obrigatório a **docs/comunicação**;
strings voltadas ao usuário passam a ser **bilíngues**)

## Contexto

O [0001](0001-idioma-portugues.md) fixou pt-BR para toda comunicação, documentação **e mensagens ao
usuário**, adequado à fase de fundação lusófona. Com a abertura do projeto a um público global, as
strings de **interface e do instalador** precisam ser bilíngues. Até aqui, todo texto voltado ao
usuário estava hardcoded em pt-BR, sem nenhuma infraestrutura de i18n em nenhuma frente (instalador
CLI, site, extensão GNOME, KWin Script KDE).

## Decisão

Suporte nativo a **dois idiomas**: **Inglês (`en`) como _default global_** e **Português do Brasil
(`pt-BR`)**. Regra transversal de **fallback estrito**: o idioma só é `pt-BR` quando o locale do
sistema / navegador indicar `pt_BR`/`pt`; **qualquer outro valor → inglês**.

As **strings-fonte** (msgid, defaults dos dicionários) passam a ser escritas em **inglês**; o pt-BR
vira a tradução. Cada frente usa o mecanismo nativo do seu runtime, com dicionários organizados de
forma consistente:

- **Instalador CLI (bash):** detecção de `LC_ALL`/`LC_MESSAGES`/`LANG` **inline** em cada script
  (são distribuídos isolados via `curl … | bash`, não podem `source` arquivos vizinhos). Catálogo de
  referência humano em `packaging/i18n-reference.sh`.
- **Web (Vite vanilla):** dicionário próprio **zero-dependência** — `web/src/locales/{en,pt-BR}.json`
  + runtime `web/src/i18n.js` com atributos `data-i18n` no HTML, detecção por `navigator.language` e
  persistência em `localStorage`. **A URL não muda** (sem rotas por idioma).
- **GNOME (extensão TS → GJS):** objeto literal `en`/`pt-BR` em `src/i18n.ts`, detecção via
  `GLib.get_language_names()` (a extensão é bundlada num único `extension.js`; gettext/`.mo` seria
  desproporcional).
- **KDE (KWin Script):** strings-fonte em **inglês** no XML (`config.ui`, `main.xml`) + catálogo
  **gettext** `contents/po/pt_BR.po` compilado para
  `contents/locale/pt_BR/LC_MESSAGES/etherbit-tiling.mo`, empacotado e instalado com o script. A UI
  de config é renderizada por um KCM do próprio KDE — só traduzível por esse mecanismo.

A **comunicação do projeto e a documentação** (`docs/`, `rules/`, README, respostas de agentes)
**continuam em pt-BR** por [0001](0001-idioma-portugues.md); este ADR só altera as **strings voltadas
ao usuário** (UI e instalador).

## Consequências

- Strings de UI/instalador deixam de ser hardcoded em pt-BR; o default exibido a um usuário fora de
  `pt_BR` passa a ser inglês.
- Novas strings de UI nascem em inglês (fonte) com a tradução pt-BR ao lado.
- **Limitações conhecidas (fora do escopo desta primeira entrega):**
  - Mensagens internas do **daemon/core em Rust** (logs/erros via D-Bus/journal) permanecem em
    pt-BR — não têm UI.
  - Os `summary`/`description` dos **atalhos no `gschema.xml`** do GNOME permanecem em pt-BR
    (exigiriam catálogo `.mo` como no KDE).
  - Metadados de extensão (`metadata.json`) ficam em inglês, sem variação por locale.
