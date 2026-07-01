# 0043 — Trava de spawn por janela de graça (unmaximize universal no nascimento)

**Status:** ✅ Aceita
(emenda [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) e
[0034](0034-estabilizacao-spawn-gnome-wayland.md) — o spawn-unmaximize deixa de depender apenas do
guard `everTiled` e passa a uma **janela de graça por tempo**; desbloqueia o agrupamento por colisão de
[0041](0041-agrupamento-por-colisao-estrita.md)/[0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md);
reafirma [0002](0002-arquitetura-core-agnostico.md)/[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md))

## Contexto

Duas anomalias persistiam no fluxo de novas janelas, ambas com a **mesma causa-raiz**:

1. **Maximização parasita no spawn.** Janelas nasciam maximizadas em tela cheia — inclusive a
   **primeiríssima** de um workspace limpo e instâncias duplicadas (2º terminal, 2º gerenciador de
   arquivos) — ignorando o grid.
2. **Ejeção híbrida por limite de hardware.** Janelas rígidas (`min-width`/`min-height`) que não cabiam
   ficavam sobrepostas/flutuantes em vez de agrupar automaticamente em abas.

O core `retain_tileable_when_maximized` **exclui do grid** toda janela maximizada que ainda não está na
árvore (o compositor a mantém maximizada por cima; ela só entra ao ser desmaximizada — Unmaximize
Recovery de [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md)). Todo o desenho
**depende de a ponte de fato desmaximizar a janela recém-nascida**. Quando o spawn-unmaximize não
dispara, a janela (a) fica presa maximizada e (b) nunca entra no grid, logo **nunca colide** e o
agrupamento por colisão de [0041](0041-agrupamento-por-colisao-estrita.md) **nunca é acionado** —
parecendo "ejetada". As duas anomalias são o mesmo bug visto de dois ângulos.

O ponto exato era o guard de `spawnUnmaximizeIfBorn`:
`!enabled || everTiled.has(id) || !isMaximized → return`. O `everTiled` **não distinguia**:

- **auto-maximização tardia do app no spawn** — apps GTK que restauram o estado `maximized` (gsettings)
  **depois** do último settle tick ([0034](0034-estabilizacao-spawn-gnome-wayland.md):
  `SPAWN_SETTLE_MS = [50, 150, 400]`). Como a janela já ganhou slot nesse meio-tempo (entrou em
  `everTiled`), a auto-maximização era lida como **manual** e preservada → janela presa maximizada;
- **maximização manual do usuário** pós-inicialização, que **deve** ser preservada (congela o grid).

O settle de 400 ms era curto demais para o restore de sessão em boot frio.

## Decisão

Introduzir uma **janela de graça por tempo** por janela recém-criada. Dentro dela, **qualquer**
maximização/fullscreen é tratada como "nascida no spawn" e desmaximizada incondicionalmente — mesmo que
a janela já tenha sido tilada (`everTiled`). **Após** a graça, vale o comportamento anterior: só
desmaximiza quem nunca foi tilada; do contrário é ato **manual** do usuário e é preservado (Unmaximize
Recovery, grid congelado em memória; ao desmaximizar, volta milimetricamente ao slot).

A decisão é um **predicado puro** compartilhado (`shouldSuppressSpawnMaximize`), testável em vitest:

```
suprime = enabled && isMaximized && (withinSpawnGrace || !everTiled)
```

- **GNOME** (ponte Wayland, assíncrona): graça de `SPAWN_MAXIMIZE_GRACE_US = 1_500_000` µs medida com
  `GLib.get_monotonic_time()`; `spawnAt` guardado no `Tracked` por janela. Os gatilhos existentes
  (`window-created` síncrono, `first-frame`, settle ticks, `notify::maximized-*`) seguem chamando o
  mesmo método — nenhum timer novo: a auto-maximização tardia dentro da graça já dispara
  `notify::maximized-*` → desmaximiza.
- **KDE** (KWin, síncrono): graça de `SPAWN_MAXIMIZE_GRACE_MS = 1500` ms via `Date.now()`; `spawnAt` em
  `Map<windowId, number>`, registrado no `windowAdded` e limpo no `windowRemoved`. O sinal
  `maximizedChanged` já reexecuta o spawn-unmaximize dentro da graça.

**Tradeoff aceito:** durante a graça (1,5 s), uma maximização manual muito rápida logo após abrir a
janela é revertida. É raro e coerente com o princípio "maximização é ato estritamente manual
**pós-inicialização**"; o valor é ajustável.

## Consequências

- **Regra II (spawn sem maximização):** toda janela nasce desmaximizada e entra no Grid Cíclico — a
  primeira ocupa o nó raiz (100%), as seguintes fracionam o layout. Restore tardio de apps lentos é
  coberto pela graça.
- **Regra I (agrupamento por colisão):** como consequência de a janela rígida agora entrar no grid, o
  core emite `collisions` e o merge de [0041](0041-agrupamento-por-colisao-estrita.md)/[0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md)
  agrupa em abas. O merge retorna **antes** de aplicar a geometria de esmagamento, então não há frame
  de sobreposição na primeira detecção. Nenhuma mudança no core/daemon.
- **Paridade GNOME ⇄ KDE** mantida pelo predicado puro comum.
