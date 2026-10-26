# 0069 — Repositório único e público (descontinua o `etherbit-tiling-releases`)

**Status:** ✅ Aceita
(substitui a arquitetura de dois repositórios descrita no `release.yml`, que tinha um repo privado de
código e um repo público só de releases, `ediano/etherbit-tiling-releases`. Mantém a
[0015](0015-notas-release-sem-url.md): as notas de release continuam sem URL, e a landing e os
instaladores continuam em `latest`.)

## Contexto

O código vivia num repositório privado (`ediano/Etherbit-Tiling`). As Releases e os assets eram
publicados num segundo repositório público (`ediano/etherbit-tiling-releases`), por meio de um PAT
(`RELEASE_REPO_TOKEN`, no Environment `github-token`). Com o projeto passando a ser **código aberto**, o
repositório de releases deixa de ter razão de existir. Ele também duplicava as issues e os pontos de
entrada da landing.

## Decisão

- **`ediano/Etherbit-Tiling` passa a ser o único repositório, e público.** Código, issues e Releases
  ficam juntos.
- **`release.yml`:** o semantic-release segue criando a tag. A Release é publicada **no próprio
  repositório** com o `GITHUB_TOKEN`. Saem o PAT `RELEASE_REPO_TOKEN`, o Environment `github-token` e o
  parâmetro `repository`.
- **Pontos de entrada passam a apontar para `ediano/Etherbit-Tiling`:**
  - landing `web/` (downloads, `curl | bash`, desinstalação, "Reportar Bug", links de GitHub e
    Repositório);
  - default de `ETHERBIT_RELEASE_REPO` nos `install-*.sh`;
  - `metadata.json` da extensão GNOME, do KWin Script e do plasmoid;
  - README do KDE.
- O `etherbit-tiling-releases` é **descontinuado**. Recomendação: arquivá-lo (read-only) com um aviso
  apontando para cá, em vez de apagá-lo, para não quebrar links antigos de versões já instaladas.

## Consequências

- As URLs `releases/latest/download/...` deste repositório só resolvem **depois da primeira Release
  publicada aqui**. Até lá, a landing aponta para 404. É preciso disparar o `release` (via
  `workflow_dispatch`) logo após tornar o repo público e mesclar esta mudança.
- O secret `RELEASE_REPO_TOKEN` e o Environment `github-token` podem ser removidos das configurações
  do GitHub.
- Instalações antigas que tenham o repo de releases salvo em `ETHERBIT_RELEASE_REPO` continuam
  funcionando enquanto ele existir arquivado.
