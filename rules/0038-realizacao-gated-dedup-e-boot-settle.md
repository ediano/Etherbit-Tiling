# 0038 — Dedup gated por realização + boot settle cascade: tiling no boot frio e min-size tardio

**Status:** ✅ Aceita
(emenda [0034](0034-estabilizacao-spawn-gnome-wayland.md) — a rede de estabilização do spawn não cobria
janelas **pré-existentes** ao `enable()` nem o **envenenamento do dedup**; emenda
[0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md) — relaxa o latch `settled` do `size-changed`
para reagir ao min-size negociado **em mais de um passo**; reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md) — core,
daemon e contrato D-Bus **intactos**, a correção é 100% na ponte GNOME)

## Contexto

Mesmo após [0037](0037-resizeable-estado-dependente-e-unfullscreen-spawn.md) (que sanou o descarte
espúrio por `non_resizable` da 1ª janela), em sessão real no **GNOME/Wayland** persistiam dois sintomas:

1. **Boot frio não tila.** A 1ª janela nascia flutuante e o grid só "acordava" após um toggle manual
   `disable()`→`enable()`. A evidência empírica era decisiva: o motor e a matemática estavam corretos
   (reativar organizava tudo na hora), logo o defeito era de **ciclo de vida**, não de layout.
2. **Janelas de min-size rígido presas em estado híbrido.** Apps como GNOME Settings e Ubuntu Store
   ficavam meio flutuantes, sobrepondo o grid, em vez de empurrar as vizinhas (cascata) ou virar aba
   (Merge Fallback).

A auditoria do `extension.ts` mostrou que os mecanismos de bootstrap, varredura e Merge Fallback **já
existiam e estavam corretos** — a hipótese de "ambiente gráfico não pronto" (`global.display` ausente no
`enable()`) era **falsa**: extensões carregam **depois** do shell. As causas reais eram três defeitos
sutis na própria maquinaria:

1. **Envenenamento do dedup `_lastLayoutSig`.** No boot, o 1º sync calculava a geometria certa e a
   aplicava, mas o compositor **descartava** o `move_resize_frame` (janelas ainda não realizadas). A
   assinatura era gravada **mesmo assim**; os re-disparos da rede de settle recalculavam assinatura
   **idêntica** → caíam no dedup → **nunca reaplicavam**. O toggle funcionava só porque `disable()` zera
   `_lastLayoutSig`.
2. **Janelas pré-existentes sem rede de retry.** Janelas abertas **antes** do `enable()` não disparam
   `window-created`, logo não ganham a rede `first-frame`/`size-changed`/`SPAWN_SETTLE_MS`. O `enable()`
   fazia **um único** `_scheduleRelayout()`; se descartado, nada reaplicava.
3. **Latch one-shot `settled` no `size-changed`.** Travava no 1º `min > 0`; apps que negociam o min XDG
   real **depois** do spawn (às vezes em vários passos) tinham os `size-changed` seguintes ignorados.

## Decisão

### A) Dedup gated por realização da geometria (a causa do boot)

O curto-circuito do dedup deixa de confiar só na assinatura: só pula a reaplicação se
`layoutSig === _lastLayoutSig` **E** a geometria do ciclo anterior **pegou na tela**. A ponte registra,
por id, o slot que **de fato committou** (`_lastAppliedRects` — só janelas visíveis e **não-maximizadas**,
gravado pós-`move_resize_frame`) e, no próximo ciclo, confronta com o `get_frame_rect()` atual via
`geometryConverged` (função **pura** em `bridge.ts`, testada em vitest, tolerância de
`RELAYOUT_CONVERGE_EPSILON_PX = 2px`; ids ausentes — fechados/maximizados — são ignorados). Não convergiu
→ **reaplica**. `_lastAppliedRects` é invalidado junto de `_lastLayoutSig` (no `disable` e no
`_releaseToFloating`).

**Por que não vira loop:** assim que um tick aplica com a janela já realizada, o frame passa a bater →
converge → o dedup engata e o laço estabiliza num passo. A latência assíncrona do Wayland causa no máximo
1–2 reaplicações idênticas (o compositor no-opa um move para o mesmo rect), limitadas pelo debounce de
80ms e pela cadência de settle. Bônus: auto-cura qualquer override externo da geometria.

### B) Boot settle cascade (janelas pré-existentes)

O `enable()` passa a reagendar relayouts nos **mesmos offsets** de `SPAWN_SETTLE_MS` (`[50, 150, 400]ms`),
além do disparo imediato (`_scheduleBootSettle`). Cobre as janelas abertas antes do `enable()` — que não
têm a rede per-janela. Combinado com (A), elas convergem assim que daemon **e** realização das janelas
estiverem prontos, **sem depender do toggle**. Os timers são rastreados (`_bootSettleIds`) e cancelados no
`disable()`.

### C) `size-changed` sempre re-tila (min-size tardio)

Remove o latch `settled` e o gate `_isTileable` que o alimentava (agora código morto): o handler de
`size-changed` passa a **sempre** `_scheduleRelayout()`. Apps de min-size rígido, ao assentarem o min real
depois do spawn, re-disparam o ciclo → o re-snapshot lê o min atual → o core sinaliza overflow → cascata
elástica empurra as vizinhas **ou** Merge Fallback agrupa em aba (caminhos de
[0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)/[0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)),
em **tempo real**. Não há loop: nossa própria aplicação roda sob `_suppressRelayout` (coalesce
trailing-edge) e o dedup gated por realização de (A) converge num passo.

## Consequências

- **Tiling 100% operacional no boot frio**, sem o toggle `disable()`→`enable()` para "acordar" o grid.
- **GNOME Settings / Ubuntu Store entram no grid de forma previsível** (empurrando vizinhas ou virando
  aba), sem sobreposição nem estado híbrido flutuante.
- **Core, daemon e contrato D-Bus intactos:** nada novo no `WindowSnapshot`/`LayoutResultDto`; a robustez
  é toda timing/estado da ponte. Reafirma 0002/0016.
- **Lógica pura coberta por vitest:** `geometryConverged` ganha testes (convergido, fora de epsilon, id
  ausente, desvio por eixo). O timing/estado do Wayland vive em `extension.ts` (não roda em vitest,
  [0012](0012-testes-isolados-por-plataforma.md)) — validado em sessão real.
- **Fora do escopo:** `platform-macos` (Swift) e o KDE — o KWin reporta geometria estável de forma
  síncrona no `windowAdded` e não sofre nem do envenenamento do dedup nem da realização tardia.
