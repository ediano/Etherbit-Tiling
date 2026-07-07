# 0058 — Blindagem do arraste→abas em hardware real (Sintoma A, KDE): lookup do alvo + recálculo da zona no drop

**Status:** ✅ Aceita
(emenda [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md)/[0039](0039-kde-abas-visuais-no-helper-de-overlay.md)/[0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)
— robustece a resolução da janela-alvo sob o cursor e recalcula a zona de drop no ponto final; reafirma
[0016](0016-extensao-ponte-burra-render-no-daemon.md): correção **100% de ponte KDE**, sem tocar core,
daemon ou D-Bus)

## Contexto

Testes em **monitores físicos** relataram que o **agrupamento por abas não era acionado no arraste**:
soltar uma janela no **centro** de outra, em vez de agrupar em aba, produzia um rearranjo do grid
(edge-tiling), "caótico".

A hipótese inicial era **escala de DPI**. A investigação **descartou** essa causa: a zona central usa
**frações do retângulo do alvo** (`resolveHotZone`: `tfx=(cursor.x-target.x)/target.width` em
`(1/3, 2/3)`), invariante a escala e a offset. O mecanismo real está na **resolução da janela-alvo sob o
cursor** (`windowUnderPointObj`), que iterava `workspace.windowList()` sem filtrar:

- **abas inativas MINIMIZADAS** (membros de stack, `minimized = true`), cujo `frameGeometry` fantasma
  ainda cobre o slot → alvo errado;
- **janelas de OUTRO desktop virtual**, cujos frames colidem com o mesmo ponto;
- **janelas mortas** — tocar `internalId`/`frameGeometry` de um wrapper órfão lança `TypeError` e
  **abortava o lookup inteiro** → alvo `null`.

Quando o alvo saía errado/nulo, `resolveHotZone` caía no ramo **global** (edge-tiling) e a aba nunca era
formada. Havia ainda uma divergência menor: `onMoveFinish` confiava no `lastHot` do último `onMoveStep`
(throttled por posição), que podia estar **defasado** do ponto real de drop.

## Decisão

Correção **defensiva** na ponte KDE, sem repro sintético (a confirmação final é em hardware):

### A) `windowUnderPointObj` filtra antes do teste geométrico

Pula (i) referências **mortas** — `isLiveWindow` PRIMEIRO, antes de qualquer acesso a propriedade; (ii)
janelas **minimizadas** (abas fantasma); (iii) janelas de **outro desktop virtual** (resolve o desktop da
arrastada e exige igualdade). Só então testa a contenção do ponto.

### B) `onMoveFinish` recalcula a zona no cursor FINAL

Em vez de reusar `lastHot`, o drop **recomputa** `resolveHotZone` a partir do `cursorPos` final e do alvo
recém-resolvido — elimina a divergência do throttle e casa com o outline que o usuário viu por último.
(Muda levemente a **semântica** do drop: passa a valer o ponto real de soltura, não a última amostra —
por isso um ADR próprio e não só uma emenda silenciosa.)

### C) Trace de diagnóstico gated

`onMoveStep` e `onMoveFinish` logam (sob a chave `debug` já existente) `cursor`, `target` (id+rect ou
`null`), `monitor` e a zona resolvida (`scope/dropZone`) — rastro de repro em hardware sem nova superfície
de config.

## Consequências

- **Comportamento:** o alvo sob o cursor deixa de ser "roubado" por abas minimizadas ou janelas de outro
  desktop, e o lookup não aborta em janela morta — o **centro** volta a agrupar em aba de forma previsível;
  o drop reflete o ponto real de soltura.
- **Reafirma 0016:** matemática da zona segue no core/`resolveHotZone` puro; a **captura do ponteiro e a
  resolução do alvo** são da ponte.
- **Contrato:** `MoveWindow`/`SyncWindows` inalterados. **Sem mudança no core Rust, no daemon ou no
  D-Bus.**
- **Testes:** os filtros dependem de `KWin.windowList()` e são validados em **sessão real**; o
  `resolveHotZone` puro (centro vs. borda) segue coberto por vitest. As correções (i)–(iii) de
  `windowUnderPointObj` são robustez pura, seguras independentemente do repro.
- **Honestidade:** são fortes **candidatos** de causa-raiz por análise estática; a confirmação definitiva
  do Sintoma A exige repro em **multimonitor + escala fracionária**, com o trace `debug` ligado.
- **Fora do escopo:** `platform-macos` (Swift); GNOME (arraste próprio via Clutter).
