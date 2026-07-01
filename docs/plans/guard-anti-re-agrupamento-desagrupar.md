# Plano — Guard anti-re-agrupamento: desagrupar manual "fica desagrupado" (GNOME + KDE)

**Status:** ✅ Implementado (GNOME 89 vitest + typecheck; KDE 56 vitest + typecheck) — ⏳ pendente de verificação em sessão real GNOME/Wayland e KDE/KWin. Registrado no ADR [0044](../../rules/0044-guard-anti-reagrupamento-desagrupar-manual.md).

## Context (por que)

**Sintoma confirmado (na `main` atualizada):** ao arrastar uma aba para fora do grupo — ou desagrupar
pelo menu — numa **célula apertada**, a janela **sai** do grupo mas é **imediatamente "sugada de
volta"** às abas.

**Correção factual:** o PR #51 (min-size) **não** tocou o drag. O PR #52 (já na `main`) já corrigiu o
**gesto** (a janela agora **sai** — `_suppressRelayout` no GNOME e `apply_bars` guard no KDE). O que
**resta** é a **Hipótese B**: o auto-agrupamento por colisão (ADR 0041) **re-agrupa** a janela no
próximo sync. O guard de idempotência existente (`_mergedCollisions`) é anti-**oscilação por conjunto**
— não captura a **intenção** do usuário. O ADR 0042 deixou esse guard **explicitamente fora de escopo**.
Este trabalho o implementa, simétrico ao ADR 0041 → **"uma vez desagrupado pelo usuário, fica
desagrupado até o usuário reagrupar ou a janela fechar"**.

A lógica de colisão é consumida **em cada ponte**, então o guard é **estado de ponte** (ADR 0002/0016)
— core e daemon **não mudam**.

## O que foi feito

### Helper puro genérico (espelhado nos dois `bridge.ts` — arquivos isolados, ADR 0012)

```ts
export function filterRegroupable<T>(members: T[], userUngrouped: Set<T>): T[] {
  const kept = members.filter((m) => !userUngrouped.has(m));
  return kept.length >= 2 ? kept : [];
}
```

Remove os membros desagrupados; devolve o restante só se ≥ 2 (senão `[]`), preservando a ordem
(âncora = 1º). GNOME usa `number`; KDE usa `string`.

### GNOME — `platform-linux-gnome/extension/src/extension.ts`

- Campo `_userUngrouped = new Set<number>()` (junto de `_mergedCollisions`).
- **Popular:** menu "Desagrupar" e drag-eject (`_ejectTabAt`), após `removeIdFromStacks`.
- **Usar:** no laço de colisões, `filterRegroupable(collision.members, this._userUngrouped)` antes de
  escolher alvo; a chave de `_mergedCollisions` fica no conjunto **original**.
- **Limpar:** `unmanaged` (fechar), re-agrupar manual (drag central), `disable()`.

### KDE — `platform-linux-kde/kwin-script/contents/code/main.ts`

- `userUngrouped = new Set<string>()` (junto de `mergedCollisions`).
- **Popular:** `applyTabActions` ramos `ungroup_drag` e `ungroup` (menu).
- **Usar:** no laço de colisões, `filterRegroupable(group, userUngrouped)` na escolha de alvo (chave no
  conjunto original).
- **Limpar:** `windowRemoved` (fechar), re-agrupar manual (`onMoveFinish` center).

### ADR 0044 + índice

`rules/0044-guard-anti-reagrupamento-desagrupar-manual.md` (Aceita, emenda 0041/0042) + linhas
atualizadas no `rules/README.md`.

## Consequência-chave

O critério de aceite muda de "zero sobreposição sempre" para **"zero sobreposição, salvo desagrupamento
explícito do usuário"**: uma janela desagrupada numa célula apertada que permanece ali **transborda**
(esmagamento ADR 0040, estável/sem oscilação) em vez de voltar às abas. O drop "cai onde foi solta"
(0042) normalmente a leva para fora da célula apertada.

## Verificação

- **Vitest:** GNOME 89 (6 novos `filterRegroupable`), KDE 56 (6 novos). Typecheck limpo nas duas pontes.
- **Core/daemon:** `cargo test`/`build` de sanidade (não mudam).
- **Sessão real (pendente):** desagrupar (menu **e** arraste) numa célula apertada → a janela
  **permanece** fora das abas; re-agrupar manual (drag central) volta a funcionar; abrir/fechar não
  deixa o guard preso. GNOME/Wayland **e** KDE/KWin.
