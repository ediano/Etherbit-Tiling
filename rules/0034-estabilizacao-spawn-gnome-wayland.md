# 0034 — Estabilização de spawn no GNOME/Wayland: micro-delay + sinais reais (paridade com KDE)

**Status:** ✅ Aceita
(emenda [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md) — o sinal `first-frame` deixa de ser
o gatilho **único/suficiente** do encaixe no spawn e passa a **primário com fallback** de estabilização;
emenda [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) — o spawn-unmaximize passa a
ser reaplicado em **três instantes convergentes** (síncrono + `notify::maximized-*` + settle); reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md) — core e
daemon **intactos**, toda a correção é na ponte; reafirma
[0023](0023-compat-api-mutter-feature-detection.md) — feature-detection das APIs Mutter 45→50)

## Contexto

Em sessão real no **Wayland**, três condições de corrida do ciclo de vida de janelas quebravam a
previsibilidade do Grid Cíclico no GNOME — sintomas que o módulo **KDE** (estável) não tem:

1. **Falha no spawn inicial.** A 1ª janela "nasce flutuante" em vez de encaixar no grid.
2. **Cascata de maximização.** Com o Tiling ativo, a 2ª janela aberta enquanto a 1ª está maximizada
   herda/mantém o estado maximizado.
3. **Atraso de encaixe com min-size.** Janelas com `min-width`/`min-height` nativos grandes (ex.: Ubuntu
   Store) nascem flutuantes e só encaixam quando uma **3ª** janela é aberta, forçando um relayout.

A causa é **única**: no instante do `window-created`, o Mutter **ainda não populou** o estado da janela.

- O `Meta.WindowActor` frequentemente **não existe** (`get_compositor_private()` → `null`), então o
  gatilho `first-frame` do [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md) **nunca arma**
  (`firstFrameId = 0`) e o `_scheduleRelayout` de 80 ms aplica geometria **antes** de o ator mapear — o
  Mutter **rejeita** o `move_resize_frame` e a janela fica flutuante (sintoma 1).
- A maximização ainda não foi confirmada → `_isMaximized` retorna `false` e o `_spawnUnmaximizeIfBorn`
  síncrono **não atua** (sintoma 2).
- O `xdg min_size` ainda não foi negociado → `get_min_size()` retorna `[0,0]`; com mínimo zero o core
  **não detecta overflow** (`detect_overflow` exige `round(slot) < min`), então o **Merge Fallback** de
  [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)/[0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)
  não dispara até a 3ª janela popular o min-size (sintoma 3).

O **KWin não tem o problema**: geometria, maximização (`isMaximized` compara `frameGeometry` com
`MaximizeArea`) e `minSize` estão **todos disponíveis síncronos** no `windowAdded`, então a ponte KDE faz
tudo síncrono e sem timers (o sandbox QJSEngine nem tem `setTimeout`). O GNOME **não pode copiar o
síncrono** — precisa **estabilizar**: re-ler o estado quando ele já estiver disponível.

## Decisão

### A) Estabilização por micro-delay (`_scheduleSpawnSettle`)

A ponte arma **sempre**, no `window-created`, uma sequência de timers `GLib.timeout_add` escalonados
(`SPAWN_SETTLE_MS = [50, 150, 400]` ms) — cobrindo o caso "ator ainda inexistente". Cada disparo revalida
a janela (`_isWindowLive`), reaplica `_spawnUnmaximizeIfBorn` (lendo a maximização já confirmada) e chama
`_scheduleRelayout`, que re-snapshota com o `min_size` já negociado. É **idempotente**: o debounce de
80 ms e o dedup por `_lastLayoutSig` colapsam os disparos redundantes, e o `_suppressRelayout` coalesce
os que caem durante a aplicação — **sem loop** sync↔relayout. O `first-frame` permanece como gatilho
**primário** quando o ator já existe (mais preciso); os timers são a **rede determinística**. O
escalonamento absorve a variância de hardware sem fixar um único valor frágil.

### B) Unmaximize robusto em três instantes convergentes

`_spawnUnmaximizeIfBorn` é chamado (1) **síncrono** no nascimento, (2) nos
`notify::maximized-horizontally`/`vertically`, e (3) nos **spawn-settle ticks** — garantindo que ao menos
um pegue o estado de maximização já confirmado. O guard `everTiled` preserva o **Unmaximize Recovery** de
[0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) (uma janela já tilada que o usuário
maximiza manualmente **não** é tocada). Duplo-`unmaximize` é no-op seguro.

### C) Min-size estável → Merge Fallback no nascimento

Os spawn-settle ticks forçam um relayout **depois** de o `xdg min_size` assentar, então o core sinaliza
overflow e a ponte agrupa a janela como **aba** (`mergeFallback`/`addToStack`) já no nascimento, sem
depender de uma 3ª janela. Complementarmente, o one-shot `settled` do `size-changed` em `_onWindowCreated`
deixa de **travar** enquanto o min-size for `[0,0]` numa janela tileável — evitando queimar o gatilho
antes de o overflow ser detectável.

### Limpeza de recursos

Novo campo `Tracked.spawnSettleIds: number[]`, cancelado com `GLib.source_remove` no handler `unmanaged` e
no `disable()` (espelha o tratamento de `firstFrameId`).

## Consequências

- **Reafirma 0002/0016:** o core puro decide overflow/cascata; o daemon segue sem estado; a correção é
  **100% na ponte**. `compute_constrained`/`detect_overflow`/`retain_tileable_when_maximized` e o
  protocolo D-Bus **não mudam**.
- **Paridade com o KDE:** o comportamento de spawn observável (1ª janela encaixa, nenhuma herda
  maximizado, app de min grande vira aba no nascimento) é atingido por **estabilização** em vez do
  síncrono que o Wayland não permite.
- **Custo desprezível:** 2–3 `GLib.timeout_add` por janela nova, de vida curta (≤ 400 ms), idempotentes e
  limpos no fechamento.
- **Testes:** a lógica pura de `bridge.ts` **não muda** (sem teste novo obrigatório; a suíte vitest segue
  como gate de não-regressão). O timing do Wayland (ator/maximização/min-size populando tarde) vive em
  `extension.ts`, que importa `gi://` e **não roda em vitest** ([0012](0012-testes-isolados-por-plataforma.md))
  — é validado em **sessão real** (1ª janela encaixa; 2ª não herda maximizado; Ubuntu Store vira aba no
  nascimento; Unmaximize Recovery preservado; sem flapping/leaks).
- **Timings ajustáveis:** `[50, 150, 400]` ms são pontos de partida calibráveis em sessão real para
  hardware lento, sem mudança estrutural.
- **Fora do escopo:** `platform-macos` (Swift); o KDE (já síncrono e estável, sem timers).
