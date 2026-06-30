# 0007 — `.vscode/` versionado parcialmente

**Status:** ✅ Aceita

## Contexto

A pasta `.vscode/` mistura **config compartilhável** (que ajuda todo o time) com **estado local/volátil**
(específico de cada máquina).

## Decisão

Versionar `.vscode/` **parcialmente** via `.gitignore`: ignorar tudo por padrão e liberar apenas os
arquivos de configuração compartilhada.

```gitignore
.vscode/*
!.vscode/settings.json
!.vscode/extensions.json
!.vscode/launch.json
!.vscode/tasks.json
```

## Consequências

- Config do Dev Container e do editor é compartilhada de forma consistente.
- Arquivos locais/voláteis não poluem o repositório.
