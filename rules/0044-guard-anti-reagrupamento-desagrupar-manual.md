# 0044 — Guard anti-re-agrupamento: "desagrupou pelo usuário, fica desagrupado"

**Status:** ✅ Aceita
(emenda [0041](0041-agrupamento-por-colisao-estrita.md) e
[0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md) — implementa o guard
persistente "o usuário desagrupou, não re-agrupe" que ambos deixaram **explicitamente fora de escopo**;
reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md):
o guard é **estado de ponte**, o core/daemon seguem agnósticos e sem estado)

## Contexto

O agrupamento por colisão ([0041](0041-agrupamento-por-colisao-estrita.md)/[0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md))
segue o princípio "uma vez agrupado por colisão, fica agrupado até o usuário desagrupar". Faltava o
**simétrico**. Em sessão real, arrastar uma aba para **fora** do grupo — ou desagrupar pelo menu — numa
**célula apertada** tira a janela do stack, mas o próximo sync do core **reemite** a colisão
(`Σ mins rígidos > avail` volta a valer) e a ponte a **re-agrupa** automaticamente: a janela é
**"sugada de volta"** às abas.

O guard de idempotência existente (`_mergedCollisions`/`mergedCollisions`) é anti-**oscilação por
conjunto** — ele evita re-merjar o **mesmo conjunto** que já foi agrupado —, mas **não captura a
intenção do usuário**: quando um membro sai, a **chave do conjunto muda** e a entrada é limpa (o
conjunto deixa de aparecer no sinal), então nada bloqueia o re-merge. A lógica de colisão é consumida
por **cada ponte** (não pelo core), então o guard mora nas pontes.

## Decisão

### A) Guard persistente de desagrupamento por ponte

Cada ponte mantém um conjunto dos ids **estáveis** que o usuário desagrupou **explicitamente**:
`_userUngrouped: Set<number>` no GNOME (`stable_sequence`) e `userUngrouped: Set<string>` no KDE
(`internalId`). É **populado em toda ação de desagrupar do usuário** — menu ("Desagrupar Janela") **e**
drag-eject (drag-to-ungroup do [0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md)),
nas duas pontes, sempre após o `removeIdFromStacks` confirmar a ejeção.

### B) Filtro na consumação de `collisions` (helper puro compartilhado)

Antes do `addToStack`, cada ponte filtra os membros da colisão pelo guard via um helper **puro** novo em
`bridge.ts`, `filterRegroupable<T>(members, userUngrouped): T[]` (genérico: `number` no GNOME, `string`
no KDE; espelhado nos dois `bridge.ts` por serem arquivos isolados — [0012](0012-typescript-nas-pontes.md)).
O helper remove os ids desagrupados e devolve o **restante** só se sobrarem **≥ 2** (senão `[]`),
preservando a **ordem** (âncora = 1º) e o guard `≥ 2` do [0041](0041-agrupamento-por-colisao-estrita.md).
Assim: vizinhos **não** desagrupados ainda se agrupam entre si; a janela desagrupada fica de **fora**. A
chave de `_mergedCollisions`/`liveCollisions` continua no **conjunto ORIGINAL** do sinal (idempotência
inalterada); o filtro só decide **o que** agrupar.

### C) Limpeza só por ação do usuário ou morte da janela (nunca por tempo)

O id sai do guard em dois eventos, simétricos ao [0041](0041-agrupamento-por-colisao-estrita.md): (1) a
janela **fecha** — `unmanaged` no GNOME (junto de `removeIdFromStacks`/`_stackHidden`),
`windowRemoved` no KDE; (2) o usuário **re-agrupa** manualmente por drag-to-group central — `addToStack`
do ramo `center` em `_onGrabEnd` (GNOME) e `onMoveFinish` (KDE) removem o id. **Não há expiração por
tempo/N-syncs** (seria a "sucção de volta" apenas atrasada, imprevisível). O `disable()` do GNOME limpa
o guard junto de `_stacks`/`_mergedCollisions`.

## Consequências

- **Comportamento:** desagrupar (menu **ou** arraste) numa célula apertada agora **persiste** — a janela
  não volta às abas sozinha. Com o drop "cai onde foi solta" ([0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md))
  ela assenta onde foi solta, normalmente **fora** da célula apertada.
- **Overflow como escolha explícita (não bug):** uma janela desagrupada que **permanece** numa célula
  apertada e não é re-agrupada **transborda** sob esmagamento impositivo
  ([0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)) — recebe ≥ seu mínimo, empurra a
  vizinha, mas **converge** (sem oscilação, a rede garante). O critério de aceite passa de "zero
  sobreposição sempre" para **"zero sobreposição, salvo desagrupamento explícito do usuário"**. Para
  evitar o overflow: dar espaço (fechar vizinha, redimensionar, mover de quadrante/monitor).
- **Reafirma 0002/0016:** o core/daemon **não mudam** (o guard é estado de ponte); o sinal `collisions`
  mantém a forma; as pontes só decidem, a mando do usuário, o que **não** reagrupar.
- **Contrato:** nenhum DTO/D-Bus muda. `TabAction`/menu/spawn inalterados.
- **Testes:** vitest do helper `filterRegroupable` nas **duas** pontes (filtra o desagrupado; colapsa a
  `[]` quando sobra < 2; passthrough sem desagrupado; preserva ordem; guard cobrindo todos; ≥3 membros).
  O **efeito visual** (desagrupar não volta às abas; overflow como escolha; reagrupar manual reabilita) é
  validado em **sessão real**, GNOME e KDE (coerente com o padrão dos ADRs 0038-0043).
- **Fora do escopo:** `platform-macos` (Swift); persistir o guard entre reinícios do compositor (é
  intencionalmente por-sessão, pois `stable_sequence`/`internalId` são específicos de sessão);
  sincronizar o guard **entre** pontes (GNOME e KDE são sessões de compositores distintos que não
  coexistem).
