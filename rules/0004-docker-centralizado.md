# 0004 — Docker centralizado em `docker/Dockerfile.core`

**Status:** ✅ Aceita

## Contexto

O ambiente de desenvolvimento usa VS Code Dev Containers. Havia duas opções: um `.devcontainer/Dockerfile`
autocontido (literal da spec inicial) ou centralizar a configuração Docker em uma pasta `docker/`.

## Decisão

Centralizar **toda a configuração de imagem em `docker/Dockerfile.core`**. O
[`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json) referencia esse arquivo:

```jsonc
"build": {
  "dockerfile": "../docker/Dockerfile.core",
  "context": ".."
}
```

- Imagem base: `mcr.microsoft.com/devcontainers/rust:1`.
- Dependências via apt: `build-essential`, `libdbus-1-dev`, `pkg-config` (comunicação D-Bus do daemon).
- **Não** existe `.devcontainer/Dockerfile`.

## Consequências

- Toda config Docker fica num só lugar (`docker/`), reaproveitável fora do Dev Container.
- O `context` é a raiz do repo, dando acesso a todo o monorepo no build.
