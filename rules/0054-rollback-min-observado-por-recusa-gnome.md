# 0054 — Rollback do min-size observado por recusa (GNOME-only)

**Status:** ✅ Aceita
(revoga [0053](0053-min-observado-por-recusa-gnome.md): o _feed_ do min observado por recusa é
REMOVIDO da extensão GNOME. Reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md)
e mantém o [0052](0052-rollback-compensacao-rigida-e-spawn-merge-gnome.md): a ponte volta a enviar o
min-size CRU do `get_min_size` (com a memoização por minimização do [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md))
ao core, que segue com o esmagamento impositivo [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md).
O núcleo Rust, o daemon e TODO o KDE permanecem intactos.)

## Contexto

O [0053](0053-min-observado-por-recusa-gnome.md) reintroduziu, numa fatia estreita, o aprendizado do
**min observado por recusa**: a extensão GNOME detectava quando uma janela recusava encolher (frame
aplicado > comandado) e passava a enviar esse tamanho como `min_width`/`min_height` no snapshot, para o
esmagamento do core reservar o espaço.

Em **sessão real**, o comportamento **piorou** — mesma família de instabilidade que já havia motivado o
rollback do [0052](0052-rollback-compensacao-rigida-e-spawn-merge-gnome.md). Alimentar o core com um
mínimo derivado de observação, ainda que restrito a recusas, reintroduz um acoplamento entre a geometria
observada e a decisão de layout que se mostra frágil na prática. Decisão: **abandonar** também esta
tentativa e voltar ao min-size cru + esmagamento puro do core.

## Decisão

Remover 100% do que o [0053](0053-min-observado-por-recusa-gnome.md) adicionou à extensão GNOME,
restaurando os arquivos afetados ao estado imediatamente anterior (ADR 0052):

- **`bridge.ts`:** removidas as funções puras `learnRefusedMin` e `applyRefusedFloor` e seus testes em
  `bridge.test.ts`. Preservada a memoização do min real por minimização (`effectiveMinSize`/`_lastMinSizes`,
  [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)) — é anterior ao 0053 e alimenta o core.
- **`extension.ts`:** removidos o estado `_refusedMins`, o método `_learnRefusals` (e sua chamada no
  `_relayout`), a composição do piso no `_minSize` e a limpeza no `unmanaged`. O `_minSize` volta a
  devolver apenas `effectiveMinSize(...)` (min cru/memoizado).

Janelas rígidas que mentem `min≈0` voltam ao comportamento anterior ao 0053 (o core lhes dá o slot
cíclico; a acomodação fica por conta do que o cliente Wayland aceitar) — preferível à regressão que a
observação causava.

## Consequências

- **Comportamento:** retorno ao grid do 0052 (esmagamento puro do core sobre o min-size cru); fim da
  regressão introduzida pelo 0053.
- **KDE / core / daemon intactos:** nada muda fora da extensão GNOME; o contrato D-Bus não muda (a ponte
  segue enviando `min_width`/`min_height` do `get_min_size` ao core).
- **Histórico preservado:** o [0053](0053-min-observado-por-recusa-gnome.md) não é apagado — muda de
  status para Revogada por #0054 (regra de ouro do projeto).
- **Release:** este rollback é um commit `revert` — gera **release de patch** pela automação
  (`.releaserc.json`: `{ type: revert → patch }`).
- **Fora do escopo:** `platform-macos`; KDE/KWin; core e daemon.
