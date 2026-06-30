# 0015 — Notas de release sem URLs (download manual de assets versionados)

**Status:** ✅ Aceita

## Contexto

As notas de cada release (corpo publicado por `release.yml` no repo público de releases) citavam
comandos de instalação com URLs do tipo `releases/latest/download/install-gnome.sh`. O problema:
`latest` **sempre aponta para a versão mais nova**. Assim, ao abrir as notas de uma release
**antiga** (ex.: v1.1.1) e seguir o comando, o usuário instalaria a versão mais recente, não a
v1.1.1 — quebrando a reprodutibilidade e a coerência daquela release.

A primeira ideia foi fixar a versão exata na URL (`releases/download/v1.1.1/...`). Mas há um caminho
mais simples e robusto: os artefatos já ficam **anexados àquela release específica** (Assets), logo
são, por natureza, da versão exata. Não é preciso citar URL alguma.

## Decisão

- **As notas de release não citam nenhuma URL de download.** Elas instruem o **download manual** dos
  assets anexados àquela release e a execução local do instalador (baixar o tarball → extrair →
  rodar `./install-*.sh`). Como o instalador roda a partir do tarball extraído, o payload está
  presente e ele instala **exatamente** a versão daquele tarball — sem rede, sem `latest`.
- **Pontos de entrada _evergreen_ continuam em `latest`, de propósito:** a landing `web/`
  (ver [0011](0011-web-landing-vite-css-puro.md)) e o bootstrap `curl | bash` dos instaladores que
  ela alimenta apontam para `releases/latest/download/...`. Ali `latest` é o comportamento desejado
  ("sempre a versão mais nova"), e esse caminho **não** é citado nas notas de release.
- Os `install-*.sh`/`uninstall-*.sh` permanecem como assets da release (a `web/` os referencia via
  `latest`); os instaladores **não** mudam.

## Consequências

- Notas de releases antigas permanecem coerentes para sempre: apontam para os próprios assets, nunca
  para "o mais novo".
- Sem maquinaria de injeção de versão em URL ou nos scripts — menos pontos de falha.
- Distinção clara de responsabilidades: **notas de release = versão fixa** (download manual);
  **landing/bootstrap = evergreen** (`latest`).
