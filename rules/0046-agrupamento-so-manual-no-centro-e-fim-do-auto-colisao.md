# 0046 — Agrupamento só manual (drop no centro), fim do auto-agrupamento por colisão e drag-to-ungroup reativado

**Status:** ✅ Aceita
(substitui [0041](0041-agrupamento-por-colisao-estrita.md) e
[0044](0044-guard-anti-reagrupamento-desagrupar-manual.md) — aposenta o agrupamento automático por
colisão e o guard que existia só para contê-lo; emenda
[0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md) (centro geométrico + reativação do
drag-to-ungroup) e [0034](0034-estabilizacao-spawn-gnome-wayland.md) (fim da cascata de settle no spawn);
reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md))

## Contexto

Testes em sessão real expuseram que o comportamento **automático** de agrupamento/compensação brigava com
a intenção do usuário. Quatro sintomas:

- **Sequestro de janelas externas (GNOME):** ao desagrupar a **2ª** janela de um grupo, a célula
  remanescente recolidia, o core reemitia `collisions` e a ponte agrupava o conjunto — arrastando **janelas
  alheias** para o bloco. O guard [0044](0044-guard-anti-reagrupamento-desagrupar-manual.md)
  (`filterRegroupable`/`_userUngrouped`) só filtrava a ejetada, não as externas do conjunto.
- **"Efeito ímã" no drag-to-tile:** a faixa SUPERIOR de 25% da janela-alvo (`STACK_BAND`) disparava o
  agrupamento por **proximidade da borda de cima**, não por intenção clara.
- **Compensação agressiva no spawn:** a cascata de re-tilas escalonadas do GNOME (`_scheduleSpawnSettle`,
  offsets `[50,150,400]ms`) re-lia o min-size e re-tilava 3× por janela, alimentando colisões que agrupavam
  sozinhas em telas apertadas.
- **Drag-to-ungroup inativo (GNOME e KDE):** arrastar uma aba para FORA da barra não ejetava nada.

A raiz comum: o agrupamento **automático** por colisão ([0041](0041-agrupamento-por-colisao-estrita.md))
tenta "consertar" a sobreposição de min-size fundindo janelas em abas — e é justamente esse automatismo que
sequestra externas e polui as coordenadas. A decisão do usuário: **agrupar é um ato voluntário**.

## Decisão

### A) Aposentar o agrupamento automático por colisão (Objetivo 1)

O core deixa de emitir o sinal `collisions`: some `CollisionGroup`, o campo `collisions` de `LayoutResult`,
a detecção `child_below_min` e o ramo de colapso de `geom_leaves_min` (que passa a só preencher a
geometria). O daemon perde `CollisionDto` e a coleta/log de `collisions`. As pontes perdem o caminho de
auto-merge (`parseCollisions`/`collisionKey`/`filterRegroupable`/`_mergedCollisions`) e, com ele, o guard
[0044](0044-guard-anti-reagrupamento-desagrupar-manual.md) (`_userUngrouped`/`userUngrouped`) fica **moot**
e é removido — nada mais re-suga a janela às abas, então não há o que guardar. O **esmagamento cooperativo**
de min-size (`solve_tracks`/`compute_constrained`, [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md))
**permanece**: janelas apertadas encolhem em cascata; se não couberem, aceita-se a sobreposição residual
(limitação de hardware) em vez de fundir em abas.

### B) Agrupamento manual só no centro geométrico (Objetivo 3)

`detect_drop_target` troca a faixa `STACK_BAND` (topo 25%) pelo **miolo central**: só o terço central em
AMBOS os eixos (`1/3 < f < 2/3`) dispara `DropZone::Stack` (agrupar). Fora do centro → split do slot do alvo
pela borda mais próxima (`sub_rect_of_target`, inalterado). Isso unifica o core com as pontes, cujo
`resolveHotZone` já usava o centro `1/3–2/3` — os operadores estritos casam a fronteira pixel a pixel.
O agrupamento MANUAL (drop-no-centro via `addToStack`) segue sendo o **único** caminho de agrupamento.

### C) Remover só a compensação agressiva no spawn (Objetivo 2)

O GNOME perde `_scheduleSpawnSettle`/`SPAWN_SETTLE_MS` (a cascata que re-tilava 3× re-lendo min-size). Ficam
o `first-frame` (gatilho primário determinístico, faz o unmaximize-if-born), o `size-changed` (rede reativa
para min-size negociado tarde) e o **boot settle** (`BOOT_SETTLE_MS`, para janelas abertas antes do
`enable()`). O KDE (KWin síncrono) já re-tilava uma vez — nada a remover.

### D) Reativar o drag-to-ungroup (Objetivo 4)

- **GNOME:** `_finishTabDrag` decide "soltou dentro/fora" pela **geometria da barra do último layout**
  (`_tabBarRects`, coords de stage) em vez do ator efêmero da aba — um relayout no meio do gesto destruía a
  guia e `get_parent()` virava `null`, quebrando a detecção. A remoção da cascata de spawn (C) elimina uma
  fonte de relayout-no-meio-do-gesto.
- **KDE:** o helper `overlay.rs` passa a rastrear `PointerEventKind::Motion` sob o grab implícito
  (`DragState.last_pos`); o `on_pointer_release` decide a ejeção pela **trajetória rastreada** (reforçada
  pelo ponto do release), robusto a compositores que clampeiam a posição do release à superfície da barra.

## Consequências

- **Comportamento:** janelas apertadas **não** viram abas sozinhas nem sequestram vizinhas — ficam
  esmagadas (cooperativo). Agrupar exige soltar no **centro** de outra janela; a borda faz split. Arrastar
  uma aba para fora ejeta e "cai onde foi solta" (GNOME e KDE). Desagrupar pelo menu tira só a janela
  escolhida, estável do início ao fim (o sequestro na 2ª ejeção some pela raiz).
- **Simplificação:** morre toda a máquina de colisão (`CollisionGroup`/`CollisionDto`/`parseCollisions`/
  `collisionKey`/`filterRegroupable`/`_mergedCollisions`/`_userUngrouped`). O desagrupar segue por
  `removeIdFromStacks` + core `detach_window` (zona `eject`, [0045](0045-desagrupar-reancora-no-lugar-zona-eject.md), reafirmada).
- **Contrato D-Bus:** o campo `collisions` do `layout_json` deixa de ser emitido; DTOs antigos com o campo
  desserializam por `#[serde(default)]` (retrocompat). A zona `eject` e o resto do contrato não mudam.
- **Reafirma 0002/0016:** a regra do centro é do **core** (geometria); a renderização das abas e a captura
  de ponteiro seguem nas camadas (GNOME na extension; KDE no helper de overlay, [0039](0039-kde-abas-visuais-no-helper-de-overlay.md)).
- **Preserva:** esmagamento cooperativo de min-size ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)),
  zona `eject` ([0045](0045-desagrupar-reancora-no-lugar-zona-eject.md)), abas 1/N, ocultação de abas sob
  janela maximizada, spawn-unmaximize/janela de graça ([0043](0043-trava-de-spawn-por-janela-de-graca.md)).
- **Testes:** core — `detect_drop_target` centro→Stack / fora-do-centro→split; duas rígidas apertadas não
  agrupam sozinhas (só esmagam); testes de `collisions`/`child_below_min` removidos. Daemon — idem no
  `resolve_drop_zone` e no sync. Pontes — vitest de `parseCollisions`/`collisionKey`/`filterRegroupable`
  removidos; helper KDE mantém `serializes_ungroup_drag_with_coords`. O efeito visual (sem auto-agrupamento,
  agrupar só no centro, drag-to-ungroup ativo) é validado em **sessão real**, GNOME e KDE (padrão dos ADRs
  0038-0045).
- **Fora do escopo:** `platform-macos` (Swift).
