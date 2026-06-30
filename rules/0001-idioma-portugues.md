# 0001 — Comunicação e documentação em português

**Status:** ✅ Aceita
(emendada por [0032](0032-i18n-multilingue.md) — as **strings voltadas ao usuário** (UI e instalador)
passam a ser bilíngues, com inglês como default global; docs e comunicação seguem em pt-BR)

## Contexto
O time e o público inicial do projeto são lusófonos. A clareza na comunicação e na documentação é
prioridade nesta fase de fundação.

## Decisão
Toda a **comunicação do projeto e a documentação (`docs/`, `rules/`, README)** são escritas em
**português (PT-BR)**.

> **Emenda (0032):** as **strings voltadas ao usuário** (UI das extensões, site e instalador CLI)
> deixaram de seguir esta regra — passaram a ser **bilíngues** (inglês como default global, pt-BR por
> detecção de locale). Ver [0032](0032-i18n-multilingue.md).

Identificadores de código (nomes de crates, funções, variáveis), comandos e termos técnicos
consagrados permanecem em inglês, seguindo a convenção do ecossistema.

## Consequências
- Documentos e respostas em português por padrão.
- Código permanece em inglês para interoperabilidade com a comunidade.
