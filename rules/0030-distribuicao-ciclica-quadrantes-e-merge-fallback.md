# 0030 — Distribuição Cíclica em Quadrantes e Merge Fallback

**Status:** ✅ Aceita (substitui a **regra de inserção** do
[0019](0019-arvore-bsp-persistente-resize-elastico.md); estende o
[0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md); refina o auto-floating do
[0021](0021-tamanhos-minimos-geometry-hints.md). Reafirma
[0016](0016-extensao-ponte-burra-render-no-daemon.md)/[0002](0002-arquitetura-core-agnostico.md))

## Contexto

A inserção do [0019](0019-arvore-bsp-persistente-resize-elastico.md) rachava a folha **focada** (ou a
maior) — comportamento dependente do foco e pouco previsível. A UX desejada é uma ordem de spawn
**determinística e posicional**, em quadrantes, com rotação cíclica anti-horária (inspiração COSMIC /
Pop!\_OS): a posição de cada nova janela é função do **número de janelas**, não do foco. Em paralelo, o
fallback de colapso de tamanho mínimo do [0021](0021-tamanhos-minimos-geometry-hints.md) era
**auto-floating** (isola e centraliza a janela); no GNOME, com abas, há uma contingência melhor —
**agrupar a janela como aba** no quadrante focado, preservando o tiling.

## Decisão

### Distribuição Cíclica em Quadrantes (`core/src/layout.rs`)

A inserção (`insert_one` → **`insert_cyclic`**) passa a ser governada pelo **slot que entra**
(`count_before + 1`, onde `count_before = collect_leaf_ids(tree).len()` — stack conta como **1 slot**):

- **W1** (`count_before == 0`): folha única (**100%**).
- **W2** (`== 1`): split **horizontal** (lado a lado), nova à **direita**.
- **W3** (`== 2`): divide a **metade direita** na vertical (nova embaixo).
- **W4** (`== 3`): divide a **metade esquerda** na vertical → **4 quadrantes** simétricos
  (TL=W1, TR=W2, BR=W3, BL=W4).
- **W5+** (`>= 4`): ciclo **anti-horário** `CYCLE = [BR, BL, TR, TL]`,
  `q = CYCLE[(count_before - 4) % 4]`. Divide ao meio (aspect-aware, **50/50**) a **maior folha do
  quadrante** da vez. **W9** reinicia em BR (rodada 2), e assim por diante.

**Resolução geométrica do quadrante.** O quadrante é resolvido pelo **centro da folha** vs. o centro da
área interna (`leaf_in_region`/`leaf_in_quadrant`, reusando `geom_leaves`) — **nunca** pela estrutura da
árvore. Assim o ciclo sobrevive a rearranjos/resizes **persistentes**: o que importa é onde a folha está
**desenhada**. Convenção de borda: `>=` para direita/baixo (determinística). **Quadrante vazio** (árvore
rearranjada) → fallback para a **maior folha global** (`largest_leaf_id`).

**Foco não governa mais a inserção.** `focused` é mantido na assinatura de `reconcile` (contrato com o
daemon) mas só serve à **proteção anti-floating** do [0021](0021-tamanhos-minimos-geometry-hints.md)
(`enforce_min_sizes`).

**Bootstrap ≡ incremental.** `balanced_node`/`half_rects` são removidas; o bootstrap (árvore vazia) vira
`cyclic_bootstrap` = *fold* de `insert_cyclic` sobre os ids. Garante a invariante: reconciliar **N** ids
de uma vez é idêntico a abrir **1→N** uma a uma (teste `reconcile_bootstrap_matches_cyclic_incremental`).

**Contagem por estado, não monotônica.** `count_before` é recomputado do estado **atual** da árvore a
cada inserção. Fechar uma janela e abrir outra trata a nova como "entrando o slot N+1" do estado
colapsado — preserva idempotência (`reconcile_is_idempotent`) e pureza (sem contador persistido).

**Caminho legado mantido.** `bsp_rects`/`compute_layout(_with)` continuam **BSP balanceado** (não
alinhados ao ciclo). O daemon usa só `reconcile`+`compute_constrained`; o legado serve retrocompat e
testes. Para N≥5 os dois caminhos divergem na ordem interna dos slots — aceitável (sem consumidor do
legado para o layout "real").

### Merge Fallback sob colapso de pixels

Quando os tamanhos mínimos impedem novos fracionamentos, a contingência é **dependente de plataforma**,
então o **core só sinaliza** (a lista `LayoutResult.floating`/`LayoutResultDto.floating` já existente é a
verdade: "quem o grid não comporta"). **Sem mudança de protocolo.**

- **GNOME (abas):** a janela que floataria é **agrupada como aba** (linear) no **quadrante focado** —
  alvo = janela **focada** do grupo (se visível) ou a **maior** janela visível do grupo
  (`mergeFallback`/`pickMergeTarget` na ponte, reusando `addToStack`, que **nunca recursa** — abas
  ficam **planas**, via `materialize_stacks`). Um merge dispara novo relayout; o min do stack vira o
  `max` dos membros (+ header) e `floating` esvazia. **Guard anti-loop** (`_mergeAttempted`): se a
  janela **ainda** floata após o merge (tela minúscula), deixa de tentar e cai no **floating legado**
  como rede de segurança; o id é liberado do guard quando deixa de floatar.
- **KDE (tiling puro, [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md)):** **sem abas** — mantém o
  **auto-floating**. Nenhuma mudança de código (herda o ciclo de graça via daemon).

## Consequências

- **Reafirma 0016/0002:** core puro/sem deps decide o ciclo; daemon sem estado; ponte dona do estado
  leve (stacks). O Merge Fallback vive na **ponte GNOME** (regra de plataforma), não no core.
- **ADRs afetados:** a **regra de inserção** do [0019](0019-arvore-bsp-persistente-resize-elastico.md) é
  substituída (foco → ciclo posicional geométrico); o auto-floating do
  [0021](0021-tamanhos-minimos-geometry-hints.md) é refinado (no GNOME, colapso vira merge-em-aba;
  floating é rede de segurança); o [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md) é estendido
  (Merge Fallback é **GNOME-only**, KDE mantém floating; splits seguem **50/50**).
- **Testes:** `layout.rs` ganha 6 casos do ciclo (`cyclic_w1_w4_form_2x2`, `cyclic_w5_w8_anticlockwise`,
  `cyclic_w9_round2_returns_to_br`, `cyclic_quadrant_resolved_by_geometry_after_rearrange`,
  `cyclic_quadrant_empty_falls_back_to_largest`, `cyclic_count_after_removal`); `reconcile_bootstrap_*` e
  `resize_window_vertical_axis` são reajustados à nova forma. A ponte GNOME ganha os testes de
  `mergeFallback` (foco/maior, guard anti-loop, não-recursão). KDE inalterado.
- **Fora do escopo:** `platform-macos` (Swift, não compila no container). O core segue agnóstico; o
  consumo macOS do ciclo é trabalho futuro no host.
