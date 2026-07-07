# 0064 — Resize elástico sensível ao min-size real; barreira síncrona de descarte (GNOME) e indicador de drop sem outline nativo (KDE)

**Status:** ✅ Aceita
(emenda [0019](0019-arvore-bsp-persistente-resize-elastico.md) — o resize elástico deixa de clampar a
proporção só por um piso proporcional fixo (`MIN_RATIO = 0.05`) e passa a clampá-la aos **mínimos REAIS
(px)** das duas subárvores do split governante; **companheira** de
[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md) — o esmagamento impositivo do render fica
**inalterado** (ver "Rejeitado"); estende as salvaguardas de descarte de
[0062](0062-abas-kde-ciclo-de-vida-do-helper-e-salvaguardas-de-descarte-gnome.md) com uma reaplicação
**síncrona**; emenda [0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md)/
[0039](0039-kde-abas-visuais-no-helper-de-overlay.md) — o indicador de drop do KDE deixa de usar o
outline nativo do KWin; reafirma [0002](0002-arquitetura-core-agnostico.md)/[0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)
— tudo agnóstico, derivado da `WorkArea`/`MinSizes` em tempo real, sem hardcode de resolução)

## Contexto

Testes em hardware real num arranjo multi-monitor **assimétrico** (4K + Full HD, escala fracionária)
reportaram anomalias geométricas de limite. O diagnóstico forense (logs em `docs/logs/`, últimos 20 min)
reduziu os sintomas a causas-raiz precisas:

1. **GNOME — ejeção de monitor e esmagamento a 67px no resize.** Ao expandir a penúltima janela em
   direção à borda externa, a última era **ejetada para o monitor vizinho**. Causa: `resize_window`
   (core) converte o delta em proporção e chama `adjust_ratio`, cujo **único** clamp era
   `MIN_RATIO = 0.05`. 5% de um extent ~1340px ≈ **67px** — o resize era **cego ao min-size real** do
   vizinho (visível nos logs: `5@… 67x552`). Um cliente Wayland que **recusa** a largura sub-min
   renderiza mais largo, transborda a borda, e no snapshot seguinte o `get_monitor()` do Mutter o
   reatribui ao display vizinho. É GNOME-específico porque o Mutter **permite** o overflow (o KWin já
   clampa o frame à tela).

2. **GNOME — sobreposição vertical no descarte de pilha assimétrica.** Numa coluna de 3 janelas
   empilhadas ao lado de 2, fechar um nó deixava a janela **central** sobreposta à inferior por alguns
   frames. A rede de [0062](0062-abas-kde-ciclo-de-vida-do-helper-e-salvaguardas-de-descarte-gnome.md)
   (liveness + `sawDead`) já evita selar a topologia antiga, mas o relayout pós-descarte era **deferido**
   (debounce de 80 ms) — havia uma janela temporal com a sobrevivente no slot obsoleto.

3. **KDE — "drawdown expansiva" no indicador de drop.** Ao arrastar para agrupar, o indicador simulava
   uma animação de expansão que sugeria agrupar janelas de quadrantes **adjacentes** (falso — a lógica
   agrupa só o quadrante alvo). Causa: o KDE desenhava **dois** overlays — o `workspace.showOutline`
   **nativo do KWin** (que tem animação de expansão embutida) além do preview translúcido do helper (já
   fixado ao output, [0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md)). A animação
   fantasma é a do outline nativo.

4. **KDE — captura de spawn maximizado / inércia de resize.** Já endereçado por
   [0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md) (`maximizedIds` + `!everTiled`); os
   novos logs KDE não reproduzem. Tratado como **verificação de build** (a própria 0063 alertou que o
   sintoma vinha de bundle desatualizado), sem novo código.

## Decisão

### A) Core — resize elástico sensível ao min-size real (agnóstico)

`resize_window` ganha um parâmetro `min: &MinSizes` e o repassa a `adjust_ratio`, que no grid
**governante** substitui o clamp `[MIN_RATIO, 1−MIN_RATIO]` por limites derivados dos mínimos reais das
duas subárvores (via `track_mins`/`min_extent`, a mesma verdade do render). Com extent `E` do split:

```
lo = max(m_first  / E, MIN_RATIO)
hi = min(1 − m_second / E, 1 − MIN_RATIO)
nr = if lo ≤ hi { (r0 + delta).clamp(lo, hi) } else { r0 }
```

Assim a expansão **trava no pixel** da borda de menor-tamanho do vizinho (e o próprio arrastado não
encolhe abaixo do seu min). O guard `lo > hi → congela em r0` evita o panic do `f64::clamp` e é o
hand-off correto: `m_first + m_second > E` é a **sobre-subscrição** genuína do
[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md), não um resize que o usuário possa
melhorar. Com `MinSizes` vazio, `lo/hi` colapsam a `[MIN_RATIO, 1−MIN_RATIO]` — **retrocompat
byte-a-byte**. O `snap` por aresta ([0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md))
é preservado.

**Plumbing (sem tocar a assinatura D-Bus):** o `ResizeWindow` não carrega o array de janelas (só
`monitors_json + state_json`). Estendemos o `SyncStateDto` (já argumento do resize) com
`mins: Vec<WinMinDto>` (`#[serde(default)]`, `de_px` tolerante). O daemon monta um `MinSizes` global via
`build_min_sizes` (agora `pub`, reusa a agregação de stack: âncora = `max` dos membros + `group_header_px`)
e o passa ao core. As pontes GNOME/KDE anexam os mínimos que **já** coletam ao `state_json` no caminho
de resize; o `SyncWindows` não muda (usa o min do próprio `windows_json`). Pontes antigas (sem `mins`) →
mapa vazio → piso proporcional antigo (opt-in, sem regressão).

### B) GNOME — barreira SÍNCRONA pós-descarte + pin de monitor no resize

- **Barreira síncrona:** o handler `unmanaged` passa a **reaplicar imediatamente** (não no debounce de
  80 ms) quando não há apply em curso — o `_relayout` já filtra a janela em `unmanaged` (`_isWindowLive`),
  então a passada síncrona vê só as sobreviventes e as encaixa no **mesmo frame**, fechando a janela
  temporal do overlap vertical. Sob supressão (apply em voo), cai no caminho pendente honrado pelo settle.
- **Pin de monitor no resize:** enquanto a janela arrastada está em resize manual, o `_snapshot` mantém
  seu monitor de **origem** (capturado no grab) — um overflow transitório do Mutter mid-resize não a
  reatribui ao display vizinho. Defense-in-depth ao item (A), que já fecha a causa raiz.

### C) KDE — indicador de drop só pelo helper translúcido (sem outline nativo)

O `updateOutline` deixa de chamar `workspace.showOutline()`/`hideOutline()` e passa a acionar **apenas**
o preview translúcido do helper `etherbit-tiling-preview` (`ShowPreview`/`HidePreview`), que desenha um
retângulo **estático** fixado ao output ([0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md))
e limitado ao frame do alvo/quadrante. Some a animação de expansão do KWin; o indicador reflete
exatamente o escopo de pixels do destino. A lógica de drop (`resolveHotZone`/`MoveWindow`) é intacta.

### D) KDE — captura de spawn/inércia: verificação de build

Sem alteração de código (coberto por [0063](0063-tags-por-output-e-maximizacao-por-estado-real-kde.md)).
Ação operacional: recompilar/reinstalar o bundle KDE e revalidar em hardware antes de diagnosticar
regressão.

## Rejeitado — amendar o esmagamento impositivo do render (0040) para "fixação de borda"

A diretiva pediu que o render **nunca** projetasse coordenadas para fora do monitor sob pressão de
mínimos. Uma tentativa de clampar o `solve_tracks` à borda foi **rejeitada** por ser incompatível com
invariantes testadas do [0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md):

- **Clampar o TAMANHO** da última track à borda a entrega **abaixo do mínimo** → o cliente Wayland
  recusa → a verificação de convergência da ponte nunca casa → **busy-loop de relayout** (exatamente a
  oscilação que o 0040 eliminou).
- **Clampar só a ORIGEM** cria **sobreposição** das tracks sobre-subscritas → quebra a invariante
  `assert_no_overlap` (4 testes do core: `min_inviavel_entrega_min_e_nao_floata`,
  `impossivel_entrega_min_a_ambas_sem_floatar`, `focada_rigida_*`).

Sob sobre-subscrição **genuína** (mais janelas rígidas do que cabem), "sem overlap + sem ejeção + min
exato" é geometricamente **impossível** — algo cede. O 0040 escolhe conscientemente **transbordar a
borda** (deslocamento compensatório) para manter min exato e convergência. Como o item (A) garante que o
**resize nunca fabrica** essa sobre-subscrição no split que edita (guard `lo > hi`), o único gatilho
restante é abrir apps grandes demais — caso raro cuja mitigação prática é o **pin de monitor** (B), não
esmagar abaixo do min no core. Portanto o render fica **inalterado**.

## Consequências

- **Fim da ejeção/67px no resize** em qualquer monitor/proporção, agnóstico (beneficia GNOME, KDE e o
  macOS futuro); costura preservada em `inner_gap`.
- **Fim do overlap vertical pós-descarte** em pilha assimétrica (reaplicação no mesmo frame).
- **Indicador de drop do KDE** contido no quadrante alvo, sem animação fantasma.
- **Contrato D-Bus estável** (só campo `mins` opt-in no `state_json`); daemon robusto a pontes antigas.
- **Testes:** core — `resize_window_trava_no_min_width_do_vizinho`, `…_min_height_vertical`,
  `…_min_da_propria_janela` (novos), demais de resize passam com `MinSizes` vazio (retrocompat); daemon —
  `resize_window_min_aware_trava_no_min_do_vizinho` e `resize_window_sem_mins_e_retrocompativel`; pontes —
  `serializeState` com `mins`, `updateOutline` sem `showOutline`. Descarte síncrono/pin e o desenho do
  helper são validados em sessão real (hardware), como o resto da camada nativa.
- **String na fronteira:** o adendo consultivo (int32 vs int64 / geometria como String) segue
  **dispensado** ([0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)): a raiz aqui
  é **semântica de clamp**, não precisão/capacidade numérica. String permanece só para **IDs** (uint64 do
  KWin, [0009](0009-nomenclatura-dbus-uuid.md)).
