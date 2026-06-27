# 0006 — `Cargo.lock` versionado

**Status:** ✅ Aceita

## Contexto
A convenção do Cargo: versionar `Cargo.lock` em projetos que produzem **binários**, e (historicamente)
ignorá-lo em bibliotecas. Com os workspaces isolados ([0003](0003-monorepo-poliglota.md)), há um
lockfile por workspace: o da raiz (`core`) e o de `platform-linux-gnome/` (`daemon`, binário).

## Decisão
**Versionar o `Cargo.lock` de cada workspace.** Como o conjunto produz um binário (`etherbit-tiling-daemon`),
os lockfiles são commitados para garantir **builds reproduzíveis**.

O `.gitignore` documenta explicitamente que o `Cargo.lock` **não** deve ser ignorado.

## Consequências
- Builds determinísticos entre máquinas e CI, por workspace.
- Atualizações de dependência ficam visíveis no diff de cada lockfile.
