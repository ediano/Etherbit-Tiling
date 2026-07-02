# 0053 — Min-size observado por recusa (converge-safe, GNOME-only): encaixe de janelas rígidas que mentem `min≈0`

**Status:** 🔄 Revogada por [0054](0054-rollback-min-observado-por-recusa-gnome.md)
(o _feed_ do min observado por recusa **piorou o comportamento do grid em sessão real** e foi removido
da extensão GNOME; volta-se ao esmagamento puro do core [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md).
Histórico da decisão original abaixo, preservado pela regra de ouro.)

(histórico — emenda [0052](0052-rollback-compensacao-rigida-e-spawn-merge-gnome.md) — reintroduzia, numa fatia
**estreita e converge-safe**, apenas o _feed_ do min observado ao core, SEM a compensação de exibição,
o spawn-merge, os gaps invioláveis nem o slot unificado que o 0052 removeu; emenda
[0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md) — compõe o piso aprendido sobre a memoização
do min por minimização; alimenta o esmagamento impositivo do core [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md);
reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md).
O núcleo Rust, o daemon e TODO o KDE permanecem intactos.)

## Contexto

O core **já faz** o encaixe "empurrando/comprimindo vizinhos": o **esmagamento impositivo**
([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md), `solve_tracks` em `core/src/layout.rs`)
garante que toda janela com min-size rígido receba **≥ seu mínimo**, as vizinhas flexíveis absorvem a
compressão em cascata e, no limite, transbordam a borda. É agnóstico (compartilhado com o KDE, que é
estável justamente por isso).

O problema residual dos toolkits híbridos no Wayland (Ubuntu Store/Flutter, e por arrasto a Calculadora
GTK4) **não é o algoritmo** — é **metadado errado**: esses clientes reportam `get_min_size() ≈ 0` ao
Mutter, mas **recusam** encolher abaixo do seu mínimo interno. O core, achando a janela flexível, dá uma
célula pequena; o cliente ignora o `move_resize_frame`; a geometria real diverge da pedida;
`geometryConverged` (epsilon 2px) falha e o `_relayout` re-dispara indefinidamente — a janela "congela"
oscilando (o mesmo modo de falha descrito na causa-raiz do [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)).

A pilha revertida 0048–0051 tentou resolver isso na **camada de exibição** e aprendendo o mínimo a
partir de **qualquer** tamanho observado (célula grande do grid, resize pós-gesto), o que **inflava** o
mínimo em espiral (por isso o [0051](0051-anti-inflacao-min-observado-gnome.md)) e gerava gaps fantasmas
e loops de reabsorção — daí o rollback do [0052](0052-rollback-compensacao-rigida-e-spawn-merge-gnome.md).

## Decisão

Descobrir o **mínimo REAL** por observação e enviá-lo ao core como metadado — mantendo a ponte **burra**
([0016](0016-extensao-ponte-burra-render-no-daemon.md)): a extensão **não transforma geometria**, só
reporta um `min_width`/`min_height` mais preciso; quem decide o layout segue sendo o core.

### A) Aprendizado por RECUSA (`platform-linux-gnome/extension/src/bridge.ts`, puro)

`learnRefusedMin(cache, id, commanded, actual, epsilon, cap)` grava um piso por id **apenas** quando o
frame aplicado (`actual`) volta **maior** que o comandado (`commanded`) além do `epsilon` num eixo — i.e.,
a janela **recusou** aquele eixo. O piso:

- **só CRESCE** (nunca reduz numa chamada) e é **limitado a `cap`** (a área útil do monitor);
- é aprendido **só de recusas** — nunca de tamanhos voluntariamente grandes (célula ampla do grid ou
  resize manual do usuário). Como o grid só **amplia** o `commanded` e amplitude **nunca** conta como
  recusa, **não há realimentação** que infle o piso: ele converge ao **ponto fixo** que é o mínimo de
  conteúdo do app. Essa é a diferença essencial para o 0048–0051 (que aprendiam de qualquer observação).

`applyRefusedFloor(raw, floor)` compõe o piso sobre o min reportado (o maior em cada eixo). Ambas as
funções são puras e testadas em vitest.

### B) Fiação na extensão (`platform-linux-gnome/extension/src/extension.ts`)

- `_learnRefusals(windows)` roda **no início do `_relayout`**, reusando a medição que já existe
  (`_lastAppliedRects` comandado × `get_frame_rect()` atual, mesmo epsilon da convergência ADR 0038).
  Roda **antes** de montar os snapshots, então o piso corrigido entra **já neste ciclo**. Maximizada/
  fullscreen/morta são puladas (o frame não reflete o slot) — sem risco de aprender de estado transitório.
- `_minSize` compõe `applyRefusedFloor(effectiveMinSize(...), _refusedMins.get(id))`; o piso flui pelo
  `_snapshot` (`min_width`/`min_height`) → daemon → core → **esmagamento (0040)** reserva o espaço e
  comprime/empurra os vizinhos. O frame real passa a coincidir com o pedido → `geometryConverged`
  curto-circuita → **fim da oscilação**.
- Ciclo de vida: `_refusedMins` é limpo no `unmanaged` (janela fechada), junto de `_lastMinSizes`/
  `_everTiled`.

### C) Sem novo contrato

Nenhuma mudança no D-Bus, na config do daemon, no gschema ou no `LayoutOptions`. O campo
`min_width`/`min_height` do snapshot e o esmagamento do core **já existem** — só passam a receber o
valor correto vindo do GNOME.

## Consequências

- **Reafirma 0002/0016:** o core puro decide o layout (inclusive o encaixe por compressão); a ponte só
  reporta metadado mais fiel — **não** faz transformação de exibição (o pecado do 0048–0051).
- **KDE / core / daemon intactos:** o KDE monta seus próprios snapshots e **não** envia min observado; o
  KWin absorve rigidez nativamente. Comportamento do KDE **idêntico** ao atual. Contrato D-Bus inalterado.
- **Por que NÃO repete o loop do 0051:** aprendizado só-de-recusa (ponto fixo = min de conteúdo),
  só-cresce + teto do monitor, e **sem** caminho de realimentação do grid; sem spawn-merge, sem slot
  unificado, sem geometria compensada na tela.
- **Testes:** `bridge.test.ts` cobre `learnRefusedMin` (aprende só de recusa; ignora frame obediente;
  respeita o cap; só-cresce; não infla na recusa repetida; preserva o eixo não-recusado) e
  `applyRefusedFloor`. O caso Ubuntu Store (Flutter) + Calculadora GTK4 é validado em **sessão real**
  GNOME/Wayland (padrão dos ADRs): a janela rígida passa a reservar seu espaço e comprimir vizinhos em
  vez de congelar/oscilar; o `relayout` converge no journal.
- **Limitações conhecidas:**
  - **Piso estagnado** se o conteúdo do app reduzir o min real depois: super-reserva **cosmética**, não
    é loop (o piso só cresce na sessão). Re-probe futuro pode zerar ao desligar/religar o tiling.
  - **App que recusa QUALQUER tamanho abaixo de ~tela inteira:** o core (0040) empurra as vizinhas para
    fora da borda (deslocamento compensatório, escolha consciente do 0040) — o melhor possível sem flutuar.
- **Fora do escopo:** `platform-macos`; KDE/KWin; core e daemon (inalterados).
