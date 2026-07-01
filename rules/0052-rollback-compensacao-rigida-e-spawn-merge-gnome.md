# 0052 — Rollback da compensação de janelas rígidas e Spawn-Time Merge (GNOME-only)

**Status:** ✅ Aceita
(revoga [0048](0048-compensacao-fisica-min-size-gnome.md), [0049](0049-gaps-inviolaveis-e-spawn-time-merge.md),
[0050](0050-unificacao-barra-janela-slot-compensado-gnome.md) e [0051](0051-anti-inflacao-min-observado-gnome.md):
toda a pilha de compensação/aprendizado/spawn-merge é REMOVIDA da extensão GNOME. Reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md): a
ponte volta a ser "burra", apenas aplicando a geometria crua do core. O núcleo Rust, o daemon e TODO o
KDE permanecem intactos.)

## Contexto

As camadas GNOME-only introduzidas por 0048-0051 — compensação física de min-size, min observado
(0048-D), gaps invioláveis + Spawn-Time Merge "em espiral" (0049), unificação barra/janela por slot
(0050) e anti-inflação do min observado (0051) — geraram, na prática, **instabilidades severas e
imprevisíveis** no grid elástico do GNOME:

- **Desorganização pós-desagrupamento:** ao extrair uma janela de um grupo de abas, o grid falhava em
  reinserir o nó na coordenada do ponteiro, colapsando a proporção de células vizinhas independentes.
- **Gaps fantasmas:** o recálculo elástico passou a gerar "buracos" e lacunas assimétricas que não
  correspondiam ao gap configurado.
- **Vazamento e loops:** janelas rígidas (toolkits híbridos GTK/Libadwaita/Flutter no Wayland)
  transbordando para fora do monitor, recusando o fluxo cíclico, com loops de reabsorção fantasma.

A tentativa de **forçar** o comportamento de min-size de janelas rígidas na camada de EXIBIÇÃO do
GNOME (empuxo/absorção de vizinhas, trava no mínimo, agrupamento preventivo no spawn) provou-se frágil
e de manutenção custosa. Decisão estratégica: **abandonar a abordagem** e voltar ao grid cíclico puro
e estável anterior ao 0048.

## Decisão

Remover 100% da pilha 0048-0051 da extensão GNOME, restaurando os arquivos afetados ao estado
imediatamente anterior ao 0048 (ADR 0047):

- **Compensação e aprendizado (0048/0050/0051):** exclusão de `rigid-compensation.ts` e seus testes; a
  ponte volta a aplicar os `rects`/`tab_bars` CRUS do core sem transformação de exibição. Removidos o
  aprendizado do min observado (`learnObservedMin`, `_observedMins`, `_effectiveMin`) e a unificação
  por slot. Preservada a memoização do min real por minimização (`effectiveMinSize`/`_lastMinSizes`,
  [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)) — é anterior ao 0048 e alimenta o core.
- **Spawn-Time Merge (0049):** removido o agrupamento preventivo no spawn (`_pendingSpawnEval`,
  `pickResident`, `shouldMergeOnSpawn`); o spawn volta ao grid cíclico puro. Agrupamento só manual no
  centro ([0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)) permanece.
- **Toggles:** removidas as chaves GSettings `rigid-compensation` e `spawn-merge` do schema da extensão
  e os respectivos switches da UI do indicador.

Janelas rígidas que não couberem no slot voltam a flutuar/transbordar sob **controle manual do
usuário** — exatamente como na versão estável inicial.

## Consequências

- **Comportamento:** retorno ao grid e posicionamento cíclico puro (0030) anterior aos patches; fim
  dos gaps fantasmas, do vazamento assistido e dos loops de reabsorção no desagrupamento.
- **KDE / core / daemon intactos:** o KDE Plasma (fluido e estável) não é tocado; o contrato D-Bus não
  muda (a ponte segue enviando `min_width`/`min_height` crus do `get_min_size` ao core, que mantém seu
  esmagamento impositivo [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md), compartilhado).
- **Preserva:** grid cíclico ([0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)),
  agrupamento manual e drag-to-ungroup ([0045](0045-desagrupar-reancora-no-lugar-zona-eject.md)/[0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)/[0047](0047-desagrupar-por-arraste-pela-barra-de-titulo.md)),
  min-size real por minimização ([0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)).
- **Histórico preservado:** os ADRs 0048-0051 não são apagados — mudam de status para Revogada por
  #0052 (regra de ouro do projeto).
- **Trade-off aceito:** sem a compensação, apps de min-size grande podem transbordar/flutuar no GNOME;
  é a responsabilidade manual do usuário, preferível à instabilidade que a automação causava.
- **Fora do escopo:** `platform-macos`; KDE/KWin; core e daemon.
