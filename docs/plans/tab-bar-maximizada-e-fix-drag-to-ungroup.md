# Plano — Correção de dois bugs de UI: drag-to-ungroup travado (GNOME/KDE) e barra de abas sobre janela maximizada

**Status:** ✅ Implementado (daemon 48+14 testes, extension typecheck/build limpos) — ⏳ pendente de verificação em sessão real GNOME/Wayland e KDE/KWin.

## Context (por que)

Diretiva do usuário aponta dois defeitos:

- **Bug A — drag-to-ungroup travado:** arrastar uma aba para fora do grupo (devolver a janela ao grid) trava o ponteiro / ignora o drop, no **GNOME e no KDE**.
- **Bug B — barra de abas por cima de janela maximizada:** ao maximizar qualquer janela, a barra de tags continua renderizada por cima (Z-index alto), sobrepondo a aplicação.

**Decisão de engenharia registrada (fix, não revert):** o `git blame` mostra que os handlers de
drag-to-ungroup são **inteiramente do ADR 0042 (`7b5f828`) e não foram alterados por nenhum commit
posterior** — não é regressão de um commit recente, e sim fragilidade de design do próprio gesto. O
commit `7b5f828` **empacota também** o fix de resize no GNOME (`_suppressRelayout`, P0 crítico) e
`detach_window`/`child_below_min` no core (P1 crítico), ambos **independentes e sãos**. Logo um
`git revert 7b5f828` está **descartado** (destruiria P0/P1). O gesto **não desestabilizou o motor de
tiling de forma generalizada** — a fragilidade está confinada a ele. Escolha do usuário: **fix
cirúrgico do gesto**, mantendo o desagrupar por menu como caminho estável já existente.

---

## Bug B — Suprimir `tab_bars` quando há janela maximizada (fix agnóstico, corrige GNOME + KDE)

**Causa-raiz:** uma janela **já tilada** que o usuário maximiza é preservada na árvore por
`retain_tileable_when_maximized`; o stack continua existindo e `compute_constrained` emite o
`TabBarRect`. A ponte não aplica a geometria da janela maximizada, mas o daemon **ainda devolve
`tab_bars`** → a barra flutua por cima. O daemon já calcula `maximized_ids` por grupo em
[protocol.rs:583-587](../../etherbit-tiling-daemon/daemon/src/protocol.rs#L583-L587).

**Correção (uma guarda no daemon compartilhado — ADR 0002/0016):** em
[protocol.rs:618](../../etherbit-tiling-daemon/daemon/src/protocol.rs#L618), só estender `tab_bars` quando
**não houver** janela maximizada no grupo (uma janela maximizada ocupa o monitor inteiro e ocultaria
qualquer barra por baixo):

```rust
// Soberania do modo maximizado: enquanto houver janela maximizada no grupo, nenhuma barra de abas
// é emitida (ela reaparece ao desmaximizar, no relayout seguinte). Vale p/ GNOME e KDE.
if maximized_ids.is_empty() {
    tab_bars.extend(res.tab_bars.iter().map(TabBarDto::from));
}
```

Ambas as pontes reconstroem as barras a partir da lista do daemon a cada relayout (GNOME
`_rebuildTabBars` → `_destroyTabBars` + rebuild; KDE `apply_bars` reconcilia por `stack_id`), então
uma lista vazia **remove** as barras; ao desmaximizar, o relayout as traz de volta. `notify::maximized-*`
(GNOME) / evento equivalente (KDE) já disparam relayout no instante da maximização.

**Fora de escopo (nota):** `fullscreen` não vem no `WindowInfo` (só `maximized`). Cobrir tela cheia
exigiria as pontes mapearem fullscreen→maximized no snapshot; fica como follow-up se necessário.

---

## Bug A — Fix cirúrgico do drag-to-ungroup

### GNOME (`extension.ts`) — suprimir relayout durante o gesto

**Causa-raiz:** o gesto usa `captured-event` no stage sem suprimir relayout. Se qualquer relayout
disparar entre o press e o release, `_destroyTabBars` destrói `drag.tab` (a aba efêmera) — o grab
implícito do Clutter sobre a aba reativa fica preso (ponteiro trava) e o `_finishTabDrag` perde a
referência. O gesto de mover janela (`_onGrabBegin`) já resolve isso com `_suppressRelayout`; o de
aba **não**.

**Correção** (reusar o mecanismo existente `_suppressRelayout`/`_releaseSuppression`):

- [`_beginTabDrag` (extension.ts:1511-1523)](../../platform-linux-gnome/extension/src/extension.ts#L1511-L1523):
  espelhar [`_onGrabBegin`:1045-1049](../../platform-linux-gnome/extension/src/extension.ts#L1045-L1049) —
  cancelar `_settleSource` em corrida e `this._suppressRelayout = true`. Mantém as barras vivas pela
  duração do gesto.
- [`_finishTabDrag` (extension.ts:1536-1553)](../../platform-linux-gnome/extension/src/extension.ts#L1536-L1553):
  chamar `this._releaseSuppression()` em **todos** os caminhos de saída (soltou dentro → retorna;
  soltou fora → `_ejectTabAt`). O `_scheduleRelayout()` interno do `_ejectTabAt` fica coalescido em
  `_relayoutPending` e é disparado uma única vez pelo `_releaseSuppression` (mesmo padrão do
  `_onGrabEnd`).

### KDE (helper `overlay.rs`) — não reconciliar barras com arraste pendente

**Causa-raiz:** sob o grab implícito do ponteiro, o release volta na **mesma** superfície do press
([overlay.rs:376-384](../../etherbit-tiling-daemon/preview/src/overlay.rs#L376-L384)). Se um `ShowTabs`
chegar no meio do arraste, [`apply_bars`:239-242](../../etherbit-tiling-daemon/preview/src/overlay.rs#L239-L242)
**dropa/recria** a `LayerSurface` da barra → o grab quebra e o `on_pointer_release` cai no
`if &drag.surface != surface { return; }` (drop ignorado) ou o ponteiro trava.

**Correção:** no topo de [`apply_bars` (overlay.rs:237)](../../etherbit-tiling-daemon/preview/src/overlay.rs#L237),
adiar a reconciliação enquanto houver arraste pendente:

```rust
// Não reconstruir/dropar superfícies de barra durante um arraste de guia (ADR 0042): destruí-las
// quebraria o grab implícito do ponteiro (drop ignorado / ponteiro preso). O próximo ShowTabs após
// o release reconcilia normalmente.
if self.drag.is_some() {
    return;
}
```

`on_pointer_release` já faz `self.drag.take()` incondicional, então o arraste é sempre limpo no
release — o guard não pode prender as barras indefinidamente.

---

## Arquivos a modificar

- [etherbit-tiling-daemon/daemon/src/protocol.rs](../../etherbit-tiling-daemon/daemon/src/protocol.rs) — guarda `maximized_ids.is_empty()` no `tab_bars.extend` (~618) + teste.
- [etherbit-tiling-daemon/preview/src/overlay.rs](../../etherbit-tiling-daemon/preview/src/overlay.rs) — guard `self.drag.is_some()` no topo de `apply_bars` (~237).
- [platform-linux-gnome/extension/src/extension.ts](../../platform-linux-gnome/extension/src/extension.ts) — `_suppressRelayout`/settle em `_beginTabDrag` (~1511) e `_releaseSuppression` em `_finishTabDrag` (~1536).

## Testes

**Rust (daemon `protocol.rs`, `#[cfg(test)]`) — Bug B:** novo teste espelhando o de stack que hoje
espera `tab_bars.len()==1` ([protocol.rs:848](../../etherbit-tiling-daemon/daemon/src/protocol.rs#L848)):
stack `[1,2]` com a janela `1` marcada `maximized: true` → `res.tab_bars` **vazio** (e `rects`/`trees`
continuam). Guarda contra regressão da guarda.

**GNOME/KDE Bug A e o efeito visual do Bug B:** sem cobertura unitária viável (event loop GJS /
Wayland do helper). Ficam para **verificação em sessão real** (gate obrigatório abaixo).

## Verificação end-to-end

1. `cargo test` no daemon (novo teste do Bug B passa) e `cargo build` do daemon; `pnpm typecheck`/`pnpm build` na extension.
2. **Sessão real GNOME/Wayland:** (a) Bug B — agrupar 2+ janelas, maximizar a ativa → a barra de abas some; desmaximizar → volta. (b) Bug A — clicar numa aba e arrastá-la para fora da barra → a janela é ejetada e reposicionada, sem travar o ponteiro; clicar sem arrastar → troca de aba normal.
3. **Sessão real KDE/KWin:** repetir (a) e (b) no KDE.

## Riscos

- **Bug A é verification-gated:** os fixes vêm de análise estática (não há repro em sessão aqui). Se
  a sessão real mostrar que o gesto ainda falha, o fallback registrado é remover o gesto (mantendo o
  menu) — mas só após tentar o fix, conforme decidido.
- GNOME: se o `captured-event` perder o BUTTON_RELEASE, a supressão ficaria presa — mesmo risco já
  existente do gesto; o release no stage (fase de captura) é confiável.
- KDE: se um arraste "vazar" sem release, `apply_bars` ficaria adiado — mitigado pelo `take()`
  incondicional no release (press→release sempre limpa `self.drag`).
- Bug B: nenhum — só deixa de emitir barras enquanto maximizado; retrocompatível (contrato intacto).
