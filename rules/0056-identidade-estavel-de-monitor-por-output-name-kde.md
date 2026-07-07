# 0056 — Identidade estável de monitor por `output.name` na ponte KDE

**Status:** ✅ Aceita
(corrige o isolamento por monitor em hardware real; emenda [0019](0019-arvore-bsp-persistente-e-resize-elastico.md)
— estado por `(monitor, workspace)` passa a ser chaveado pelo **nome do conector**, não pelo índice
posicional; reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md):
mudança **100% de ponte KDE** — core, daemon, contrato D-Bus e GNOME inalterados)

## Contexto

Testes com **múltiplos monitores físicos** revelaram que o Etherbit **perdia o isolamento de layout por
tela**: abrir/redimensionar janelas num monitor desalinhava o grid dos outros, e o estado persistente
"trocava de tela".

A causa **não** é o algoritmo do core — o core é estritamente isolado (uma `LayoutTree` por
`(monitor, workspace)`, testado). A causa é a **identidade do monitor na ponte KDE**: o `monitor` era um
**índice posicional** derivado de `collectOutputs().indexOf(win.output)`. Esse índice:

- muda quando um monitor é conectado/desconectado/reordenado (hotplug); e
- pior no KDE, dependia da **ordem de descoberta pelas janelas atuais** (a `collectOutputs()` só lista
  outputs que têm janela).

Como os mapas persistentes da ponte (`order`, `trees`, `stacks`, `disabled`) eram chaveados por
`orderKey(index, workspace)`, qualquer reordenação **remapeava o estado para o monitor físico errado** —
o "desalinhamento entre telas" relatado.

## Decisão

**Chavear todo o estado persistente da ponte pelo NOME do output** (`output.name`, ex. `"DP-1"`), que é a
identidade intrínseca e estável do conector; **manter o índice numérico `u32` só no contrato** com o
daemon/core (o `WorkArea.index`, que o core casa por posição).

- `orderKey(monitor, workspace)` passa a aceitar um **token string** (o nome); `parseOrderKey` devolve
  `[nomeString, workspace]` (divide no último `:`). Um helper `outputNameOf(output)` lê `output.name`,
  com **fallback** para o índice posicional (`#idx`) quando o KWin não expuser `name` (nunca quebra).
- No `retile()`, monta-se a tradução **nome↔índice** do ciclo (`nameToIndex`/`indexToName`); as janelas
  são agrupadas pela chave-por-nome, mas o snapshot ainda carrega o **índice numérico** (`monitor`).
- `serializeState(...)` recebe `nameToIndex` e **traduz nome→índice** ao emitir `disabled_groups`,
  `stacks` e `trees`. Grupo cujo monitor está **desconectado** (nome ausente no mapa atual) é **omitido do
  sync** — o estado nome-keyed **sobrevive na ponte** e reancora quando o monitor volta.
- `parseLayoutTrees(...)` recebe `indexToName` e **traduz índice→nome** ao reconstruir a chave das
  árvores devolvidas pelo core.
- `KWinOutput` deixa de ser `unknown` e passa a expor `name?: string` (`kwin-globals.d.ts`).

## Consequências

- **Comportamento:** o layout, os stacks e os grupos desligados ficam **presos ao monitor físico**;
  hotplug/reordenação não troca mais o grid entre telas. Um monitor removido preserva seu estado, que
  reaparece intacto ao reconectar.
- **Reafirma 0002/0016:** o core segue agnóstico e keyed por índice; a **identidade estável é
  responsabilidade da ponte**, que traduz nome↔índice na fronteira do contrato.
- **Blast radius mínimo:** mudam só `main.ts`, `bridge.ts`, `kwin-globals.d.ts` e `bridge.test.ts` do
  KDE. **Core, `protocol.rs`, `service.rs` e a extensão GNOME não mudam** — o GNOME segue enviando índices
  numéricos; o contrato de fio (`SyncWindows`/`MoveWindow`) é idêntico.
- **Base para 0057:** a persistência dos grupos desligados usa este nome estável como chave.
- **Testes:** vitest cobre a tradução nome↔índice em `serializeState`/`parseLayoutTrees`, a **omissão de
  monitor desconectado**, e um round-trip simulando **reordenação** (`[DP-1,HDMI-1]→[HDMI-1,DP-1]`)
  provando que a árvore continua presa a `DP-1`. A leitura de `output.name` em runtime é validada em
  **sessão Plasma 6 real** (com o fallback de índice como rede).
- **Limitação conhecida:** se uma versão antiga do KWin Script não expuser `output.name`, cai-se no índice
  posicional (`#idx`) — comportamento legado (pior isolamento no hotplug), nunca crash.
- **Fora do escopo:** `platform-macos` (Swift); GNOME.
