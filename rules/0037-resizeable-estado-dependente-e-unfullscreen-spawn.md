# 0037 — `resizeable` estado-dependente no Mutter 50: derivação robusta por min/max + unfullscreen no spawn

**Status:** ✅ Aceita
(emenda [0035](0035-unmaximize-mutter50-e-log-fiel-a-tela.md) — o log `dropped` que 0035 instrumentou
**exonerou** a teoria de maximização e revelou que `Meta.Window.resizeable` é estado-dependente; estende
[0034](0034-estabilizacao-spawn-gnome-wayland.md) — adiciona o **unfullscreen** aos instantes convergentes
do spawn, ao lado do unmaximize; reafirma [0023](0023-compat-api-mutter-feature-detection.md) —
feature-detection Mutter 45→50, agora para `get_max_size`/`is_fullscreen`/`unmake_fullscreen`; reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md) — core,
daemon e contrato D-Bus **intactos**, a correção é 100% na ponte)

## Contexto

Mesmo após [0035](0035-unmaximize-mutter50-e-log-fiel-a-tela.md) (que corrigiu a assinatura 0-arg de
`unmaximize` e instrumentou o campo `dropped`), em sessão real no **GNOME/Wayland (Mutter 50)** a 1ª
janela de cada sessão **nunca** entrava no grid — ficava flutuante "preenchendo a tela" e por cima das
demais. São **dois sintomas com uma causa única**: (1) a 1ª janela não assume o nó raiz e (2)
"sobreposições", que são a própria 1ª janela flutuante cobrindo o grid no centro.

O **novo log fiel à tela de 0035 foi decisivo** e, ironicamente, **refutou a própria hipótese de 0035**.
Os logs mostraram, de forma **determinística** a sessão inteira:

```
[etherbit] relayout: total=2 aplicadas=1 flutuantes=0 descartadas=[1:non_resizable]
```

Duas conclusões da auditoria:

1. **Era `non_resizable`, não `excluded_maximized`.** O daemon monta `dropped` em dois pontos
   (`protocol.rs`): o portão `is_tileable` (`non_resizable`/`non_maximizable`/`non_normal`/`ignored`) e,
   **depois**, `retain_tileable_when_maximized` (`excluded_maximized`). Como o motivo é `non_resizable`, a
   janela morre **no portão `is_tileable` por `resizable == false`**, ANTES de qualquer lógica de
   Unmaximize Recovery (0031/0034/0035) — que ficou **preemptada**. A teoria de maximização de 0035
   estava exonerada.

2. **`Meta.Window.resizeable` é dependente de estado.** A ponte enviava `resizable` direto da propriedade
   crua (`_snapshot`). No Mutter, `resizeable` retorna **`false` enquanto a janela está maximizada ou em
   fullscreen**. Como toda 1ª janela nasce "preenchendo a tela" (confirmado: ocorre com **qualquer** app),
   o snapshot carregava `resizable: false` de forma sistemática. Agravante: `_spawnUnmaximizeIfBorn` só
   trata maximização (não fullscreen), e mesmo desmaximizando não adiantava — o portão já havia descartado
   a janela na mesma passada do snapshot.

## Decisão

### A) `resizable` independente de estado (a causa)

No `_snapshot` (ponte GNOME), `resizable` deixa de ser a leitura crua de `window.resizeable`. Passa por
`isResizable` (função **pura** em `bridge.ts`, testada em vitest): confia no `resizeable === true`
(caminho rápido); quando `false`, deriva dos **hints de tamanho** — a janela só é genuinamente
não-redimensionável se for **`isFixedSize`** (`min == max` em **ambos** os eixos, com `max > 0`). Sem teto
(`max == 0`, hint ausente) ou `min != max` → redimensionável (**paridade Cosmic**). Os hints reais vêm de
`Meta.Window.get_min_size`/`get_max_size` por **feature-detection defensiva** (espelha o `_minSize` de
0033; `get_max_size` não existe nos tipos `@girs` → cast). O mesmo `_isResizable` alimenta o `_isTileable`
(gate do one-shot `size-changed`), evitando incoerência de gate / flapping. **Diálogos de tamanho fixo
reais** (`min == max > 0`) seguem corretamente descartados. O portão `is_tileable` do **core não muda**.

### B) Unfullscreen no spawn (complemento)

Com `resizable` robusto, uma janela nascida **fullscreen** passa o portão, mas o compositor **rejeita**
`move_resize_frame` enquanto durar o fullscreen. Novo `_spawnUnfullscreenIfBorn` (espelha
`_spawnUnmaximizeIfBorn`): desfaz o fullscreen de janela **nascida** fullscreen e **nunca tilada** (guard
`_everTiled` + `_config.enabled`), nos **mesmos instantes convergentes** do unmaximize (síncrono +
`first-frame` + spawn-settle ticks) e num novo `notify::fullscreen` (os `notify::maximized-*` **não**
disparam em transições de fullscreen). `unmake_fullscreen` é 0-arg em toda a linha (sem a armadilha de
assinatura do `unmaximize`), ainda assim chamado por feature-detection (0023).

**Trade-off (consciente):** isso normaliza também apps que abrem **legitimamente** em fullscreen
(player/jogo). É **consistente** com a postura já adotada em
[0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) ("com o Tiling ativo, nenhuma janela
inicia maximizada, mesmo que o app peça") e com o objetivo Cosmic de capturar toda janela normal ao grid.
O guard `_everTiled` preserva quem o usuário põe em fullscreen **depois** de tilado. Uma **allowlist** de
fullscreen legítimo (por `app_id`/tipo) fica como trabalho futuro.

### C) Telemetria enriquecida (espírito 0035)

A ponte loga, por janela descartada, os flags **crus** que explicam o motivo (`drop-detail`: `resizeable`,
`can_maximize`, `fullscreen`, `maximized`, `window_type`, `min`, `max`), correlacionando o `dropped` do
daemon (só `id`+`reason`) com o `Meta.Window` local. É **client-side** (não muda o protocolo D-Bus nem o
daemon) e distingue maximizada vs fullscreen vs tamanho fixo na próxima sessão.

## Consequências

- **A 1ª janela de qualquer app encaixa imediatamente** (nó raiz, 100% com gaps), sem depender de janelas
  subsequentes nem da Unmaximize Recovery.
- **Core, daemon e contrato D-Bus intactos:** `is_tileable`/`retain_tileable_when_maximized`/
  `LayoutResultDto` não mudam; o `WindowSnapshot` da ponte segue com `resizable: boolean` (a robustez é
  calculada ANTES de montar o DTO; nada de `fullscreen`/`max_*` no contrato). Reafirma 0002/0016.
- **Lógica pura coberta por vitest:** `isResizable`/`isFixedSize` ganham testes (raw-true, fixo, min≠max,
  sem-teto, um-eixo travado). O timing/estado do Wayland vive em `extension.ts` (não roda em vitest,
  [0012](0012-testes-isolados-por-plataforma.md)) — validado em sessão real: 1ª janela encaixa, sem
  `non_resizable` espúrio, sem `JS WARNING` de `unmaximize`/`unmake_fullscreen`, diálogo fixo segue
  flutuante, fullscreen pós-tilagem preservado.
- **Logs auto-explicativos:** uma futura regressão de "janela some do grid" é diagnosticável só pelo
  journal (linha `drop-detail`), sem `RUST_LOG`.
- **Fora do escopo:** `platform-macos` (Swift); o KDE — o KWin reporta `isResizable`/geometria já estáveis
  no `windowAdded` (síncrono), sem o sintoma, e não usa a API do `Meta.Window`.
