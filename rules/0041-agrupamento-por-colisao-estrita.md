# 0041 — Agrupamento automático por colisão estrita (reverte B/C do 0040; mantém esmagamento, menu e spawn)

**Status:** ✅ Aceita
(emenda [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md) — **reverte a parte B** (o core
volta a emitir um sinal de "não cabe", agora `collisions`, geométrico por célula) e a **parte C** (as
pontes voltam a agrupar automaticamente sob colapso, **GNOME e KDE**); **mantém** a parte A (esmagamento
impositivo como prioridade reguladora), o menu de contexto KDE e o spawn-unmaximize; reativa, adaptado,
o espírito do Merge Fallback de [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)/[0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md);
reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md))

## Contexto

O [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md) matou a **oscilação** de janelas
rígidas trocando "sinalizar overflow + agrupar" por "**esmagamento impositivo** + agrupar só manual". O
esmagamento resolveu a causa-raiz da oscilação: a track rígida passou a receber **sempre ≥ seu mínimo**,
o cliente Wayland aceita o slot, a geometria converge e o relayout não re-dispara.

Sobrou, porém, a **limitação conhecida** que o próprio 0040 documentou: no **overflow extremo** (mínimos
rígidos cuja soma excede a célula/tela), o esmagamento entrega a cada janela seu mínimo e **empurra a
vizinha para fora da borda** (deslocamento compensatório) — visualmente, **sobreposição**. Em sessão
real (GNOME e KDE), abrir dois apps de mínimo grande no mesmo quadrante (Calculadora + GNOME Settings /
Ubuntu Store) produz exatamente isso.

A saída correta de UX para "não cabe" sempre foi **agrupar em abas** (cada aba recebe a célula inteira e
o app cabe). O 0040 a removeu por dois motivos: (1) o agrupamento automático causava o vai-e-vem — mas a
causa real era o slot `< min` que o cliente recusava, **já eliminada pelo esmagamento**; (2) filosofia
"agrupar é ação do usuário". Esta decisão **reverte (2)** para o caso de **colapso físico estrito**: quando
não há pixels para deformar, agrupar é a única saída sem sobreposição — e, com o esmagamento como rede, o
vai-e-vem **não retorna**.

## Decisão

### A) Esmagamento impositivo permanece a PRIORIDADE (core — inalterado)

O `solve_tracks` (`core/src/layout.rs`) não muda: enquanto há espaço para comprimir elasticamente, ele
comprime; no ramo "não cabe", toda track rígida recebe ≥ seu mínimo. É a rede que garante convergência
**durante e depois** do agrupamento (o cliente Wayland nunca recusa o slot → sem loop de relayout).

### B′) Sinal de colisão no core (reverte/adapta a parte B do 0040)

`geom_leaves_min` passa a detectar, em cada grid, o **colapso por célula**: um eixo cujas tracks
**não cabem** (`tracks_overflow`: `Σ mins rígidos > avail`) — o **mesmo gatilho** do ramo impositivo do
`solve_tracks` (helper único, impossível divergir). As folhas do grid colapsado são emitidas em
**`LayoutResult.collisions: Vec<CollisionGroup { cell_id, member_ids }>`** — campo **novo** (não reusa
`floating`, que segue **sempre vazio** e marcado _deprecated_; `CollisionGroup` entrega o **conjunto a
agrupar**, então a ponte não reinventa `pickMergeTarget`). **Guard:** só emite com **≥ 2 membros** — uma
janela sozinha maior que a célula não tem com quem agrupar e **fica no esmagamento** (sem re-merge em
loop). A detecção é puramente geométrica/agnóstica (mínimos, área, gaps, topologia), nunca título/toolkit
— reafirma [0002](0002-arquitetura-core-agnostico.md)/[0029](0029-daemon-sem-framework-visual.md). O DTO
`LayoutResultDto` ganha `collisions` com `#[serde(default)]` (retrocompat: ausente = comportamento 0040).

### C′) Agrupamento automático nas DUAS pontes (reverte/adapta a parte C do 0040)

GNOME (`extension.ts`) e KDE (`main.ts`) consomem `collisions` no relayout e agrupam os membros via o
`addToStack` já existente (o mesmo do drag-to-group). **Idempotência/anti-oscilação:** um guard por
conjunto (`collisionKey`, ordem-insensível) em `_mergedCollisions`/`mergedCollisions` evita re-agrupar o
mesmo conjunto; a entrada é descartada quando o conjunto deixa de aparecer no sinal. O KDE traduz os ids
de **transporte → estável** (`transportToStable`) antes do `addToStack` (contrato de IDs-string,
[0009](0009-nomenclatura-dbus-uuid-e-contrato-json.md)). **Não** reintroduz o float-and-elevate legado —
só o merge-em-abas. O **drag-to-group** manual e o menu "Desagrupar" seguem intactos.

### Permanência (sem auto-desagrupar)

Uma vez agrupado, **fica agrupado** — o usuário desagrupa pelo menu/Super+S. É o que mata o vai-e-vem: o
merge vira `Node::Stack`, a célula **deixa de colapsar** (cada aba recebe a célula inteira), `collisions`
esvazia no próximo sync e nada re-dispara. Fechar uma das duas dissolve o stack (`< 2` membros) e devolve
a outra ao grid.

### Regra II correlata (UI das abas)

O GNOME passa a desenhar abas com **largura fixa `barWidth/N` + truncamento** (`Pango.EllipsizeMode.END`),
ignorando o comprimento do título — espelhando o `tabs.rs::layout_slots` que o KDE já usa. Simetria
perfeita (1/N) nas duas plataformas.

## Consequências

- **Reafirma 0002/0016:** o core puro decide a colisão (geometria, sem título); o daemon segue sem estado
  (repassa `collisions`); as pontes só agrupam.
- **Contrato:** `LayoutResultDto` ganha `collisions` (`#[serde(default)]`, retrocompat — daemon novo +
  ponte antiga, ou vice-versa, degrada ao comportamento 0040 sem crash). `floating` mantido vazio/
  deprecated. `TabAction`/menu/spawn inalterados.
- **Comportamento esperado (não é bug):** se o usuário desagrupar manualmente duas janelas que **ainda
  não cabem**, elas re-colidem e são **re-agrupadas** no próximo sync (o critério de aceite é "zero
  sobreposição"). Para mantê-las lado a lado é preciso dar espaço (fechar uma, redimensionar, mover de
  monitor/quadrante).
- **Limitação herdada:** a janela patológica (mínimo maior que a tela, **sozinha**) continua sob
  esmagamento (transborda a borda) — não há com quem agrupar.
- **Testes:** `layout.rs` ganha casos de colisão (emitida no colapso, guard `≥2`, idempotência pós-stack,
  `tracks_overflow` coincide com o ramo, agnosticismo a `app_id`) e os casos de esmagamento passam a
  afirmar `collisions` **além** do mínimo entregue; `protocol.rs` valida `collisions` no JSON, o default
  retrocompat e o **título ignorado** (fronteira agnóstica); o vitest de GNOME e KDE ganha `parseCollisions`
  - `collisionKey` (o `parseFloating` morto é removido). O caso Calculadora/Settings/Store e a ausência de
    vai-e-vem são validados em **sessão real**.
- **Fora do escopo:** `platform-macos` (Swift); um guard persistente de "o usuário desagrupou, não
  re-agrupe" (evolução futura, se a re-agregação incomodar).
