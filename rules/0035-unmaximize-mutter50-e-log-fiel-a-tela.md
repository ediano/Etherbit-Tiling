# 0035 — `unmaximize()` no Mutter 50 (assinatura 0-arg) + log de relayout fiel à tela

**Status:** ✅ Aceita
(corrige uma regressão residual de [0034](0034-estabilizacao-spawn-gnome-wayland.md) — o spawn-unmaximize
em "três instantes convergentes" reaplicava uma chamada que **lançava** no Mutter 50, então nunca
desmaximizava de fato; reafirma [0023](0023-compat-api-mutter-feature-detection.md) — compat de API
Mutter 45→50; reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md)
— o core e o protocolo seguem como fonte de verdade, o novo dado é só diagnóstico)

## Contexto

Mesmo após [0034](0034-estabilizacao-spawn-gnome-wayland.md), em sessão real no **GNOME 50 / Mutter 50.1**
a 1ª janela (não maximizada) continuava nascendo flutuante e o tiling só "acordava" após 3–4 janelas,
com sobreposições. Os logs mostravam um padrão **determinístico**, estável a cada re-tilagem:

```
[etherbit] relayout: N janelas → (N−1) rects, 0 flutuantes      (1→0, 2→1, 3→2, …)
JS WARNING: ... Too many arguments to method Meta.Window.unmaximize: expected 0, got 1
```

Duas conclusões da auditoria:

1. **Não era timing/overflow.** O log é emitido **depois** do round-trip ao daemon; `flutuantes = 0`
   sempre (o caminho de overflow nunca dispara); e o padrão é **determinístico**, não uma corrida. Logo
   o daemon recebia N janelas e devolvia **N−1** rects — uma janela era estruturalmente excluída do grid.

2. **A causa é a assinatura de `Meta.Window.unmaximize`.** No **Mutter ≥ 46** o método passou a aceitar
   **zero argumentos** (sempre desmaximiza ambos os eixos). A ponte chamava
   `window.unmaximize(Meta.MaximizeFlags.BOTH)` — o GJS emite `Too many arguments …` e a desmaximização
   **não acontece**. Uma janela "nascida maximizada" permanece em `maximized`, e o core, por
   [`retain_tileable_when_maximized`](../etherbit-tiling-daemon/daemon/src/protocol.rs) (0031/0034),
   **mantém-na fora do grid** (sem folha) — ela flutua em tela cheia sobre as demais (as sobreposições).
   Os três instantes do spawn-unmaximize de 0034 reaplicavam a **mesma** chamada que lança: a rede não
   pegava porque o gatilho em si estava quebrado.

Agravante de observabilidade: o log da extensão (`N janelas → M rects`) **conta janelas não-tileáveis**
(snapshot sem pré-filtro) e a linha do daemon que mostraria o portão exato
(`N recebida → M tileável → R rect`) é **gated** atrás de `RUST_LOG`/`ETHERBIT_LOG=debug` — então o
off-by-one parecia um bug do motor quando às vezes é só uma janela de desktop sendo contada.

## Decisão

### A) Corrigir a assinatura de `unmaximize` (a causa)

`_spawnUnmaximizeIfBorn` passa a chamar `window.unmaximize()` **sem argumento** (Mutter ≥ 46). Elimina o
`JS WARNING` recorrente e faz o spawn-unmaximize **efetivamente** desmaximizar → a janela ganha folha e
sai de `maximized_ids`, encaixando no grid já na 1ª. A robustez de 0034 (3 instantes + guard `everTiled`

- Unmaximize Recovery) permanece — agora com um gatilho que funciona.

### B) Log de relayout FIEL À TELA (ponte) + diagnóstico do daemon

- **Daemon devolve `dropped: [{ id, reason }]`** no `LayoutResultDto`: para cada janela RECEBIDA e não
  posicionada, o motivo — `non_normal`/`non_resizable`/`non_maximizable`/`ignored` (reprovou em
  `is_tileable`) ou `excluded_maximized` (`retain_tileable_when_maximized`). É **puramente diagnóstico**:
  não altera o layout e tem `#[serde(default)]` (retrocompat).
- **Ponte loga fiel à tela:**
  `[etherbit] relayout: total=<N> aplicadas=<A> flutuantes=<F> descartadas=[id:motivo, …]` e
  `[etherbit] grid: id@x,y wxh | …` (geometria final aplicada). `total > aplicadas` deixa de parecer
  off-by-one — o motivo está explícito.
- **Descobribilidade:** `docs/DIAGNOSTICO-IPC.md` documenta `ETHERBIT_LOG=debug` e a leitura das linhas.

## Consequências

- **A 1ª janela encaixa imediatamente** (nó raiz, 100% da tela) sem depender de janelas subsequentes.
- **Core e protocolo D-Bus intactos** quanto à lógica de layout; o único acréscimo é o campo opcional
  `dropped` (diagnóstico). `is_tileable`/`retain_tileable_when_maximized` seguem como fonte de verdade —
  o `dropped` apenas **expõe** as decisões delas (o `drop_reason` da ponte-daemon espelha a ordem de
  `is_tileable`).
- **Logs auto-explicativos:** uma futura regressão de "janela some do grid" é diagnosticável só pelo
  journal do gnome-shell, sem `RUST_LOG`.
- **Testes:** a lógica pura do daemon segue coberta por `cargo test`; o parse defensivo de `dropped` na
  ponte espelha `parseFloating` (vitest como gate de não-regressão). O timing do Wayland vive em
  `extension.ts` (não roda em vitest, [0012](0012-testes-isolados-por-plataforma.md)) — validado em
  sessão real: 1ª janela encaixa, sem `JS WARNING` de `unmaximize`, `aplicadas == tileável` por nível.
- **Fora do escopo:** `platform-macos` (Swift); o KDE (síncrono, sem a API do Mutter).
