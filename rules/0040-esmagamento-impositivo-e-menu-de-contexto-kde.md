# 0040 — Esmagamento impositivo de min-size (sem merge/float automático) e menu de contexto na aba (KDE)

**Status:** ✅ Aceita
(emenda [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) — quebra a invariante
"`Σ tracks == avail` sempre, nunca overflow"; emenda [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md)
— o core deixa de emitir `floating` e o sinal overflow→merge é descontinuado (a parte A, min-size **real**
nas pontes, permanece); substitui a parte **Merge Fallback** do [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)
— agrupamento automático removido, agrupamento passa a ser **só manual**; emenda
[0039](0039-kde-abas-visuais-no-helper-de-overlay.md) — o clique direito na aba abre um **menu de
contexto**, não mais ungroup imediato; reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md))
**Emendado por [0041](0041-agrupamento-por-colisao-estrita.md):** as partes **B** (sinal de overflow) e
**C** (merge automático) são **revertidas/adaptadas** — o agrupamento automático volta, agora só sob
**colapso estrito** (sinal `collisions` por célula) e em **GNOME e KDE**. As partes **A** (esmagamento
impositivo), o menu de contexto e o spawn-unmaximize **permanecem**.

## Contexto

Duas regressões de comportamento sobraram depois dos ADRs 0038/0039:

1. **Oscilação de janelas rígidas no GNOME.** Apps com `min-width`/`min-height` físicos grandes
   (Calculadora, GNOME Settings, Ubuntu Store) entravam num loop visual: o core não acomodava o mínimo na
   cascata, reportava a janela em `floating` (`detect_overflow`), e a ponte respondia com **agrupamento
   automático** (Merge Fallback, [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)/[0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md))
   ou com o **float-and-elevate legado**. A causa-raiz está no ramo "NÃO CABE" do `solve_tracks`: as
   tracks **não-prioritárias** com mínimo rígido recebiam `rest_avail * (min/rest_sum)` — ou seja, **menos
   que o mínimo**. O cliente Wayland **recusa** encolher abaixo do seu `xdg min_size`, a geometria real
   diverge da pedida, a verificação de convergência (`geometryConverged`, epsilon de 2px) falha e o
   relayout re-dispara indefinidamente (a janela fica "parcialmente flutuante" oscilando).

2. **Ejeção direta indesejada no KDE.** O clique **direito** numa aba desagrupava a janela na hora
   (`hit_test_local` → `ungroup`). A UX desejada é um passo intermediário: abrir um micro-menu de contexto
   com uma única opção "Desagrupar"; só a confirmação por clique esquerdo é que ejeta.

O agrupamento automático sob colapso de pixels, além de causar o vai-e-vem, viola a expectativa de que
**agrupar é uma ação do usuário** — não algo que o gerenciador faz sozinho para "dar um jeito" na falta
de espaço.

## Decisão

### A) Esmagamento impositivo no core (`core/src/layout.rs`)

O ramo "CABE" do `solve_tracks` (saturação elástica) **não muda**. O ramo "NÃO CABE" passa a garantir que
**toda track com mínimo rígido receba sempre ≥ seu mínimo**; as tracks flexíveis (`min ≈ 0`) absorvem toda
a compressão:

- Se `Σ mins rígidos ≤ avail`: cada rígida recebe seu mínimo exato; as flexíveis dividem o que sobra por
  fração (podendo chegar a 0).
- Se `Σ mins rígidos > avail` (**esmagamento impositivo**): cada rígida recebe seu mínimo **exato** e as
  flexíveis vão a 0. A soma pode **exceder** o espaço (`Σ tracks > avail`) — o **deslocamento
  compensatório** empurra as vizinhas para fora da borda (recorte do compositor), mantendo a janela rígida
  no seu tamanho mínimo.

Isto **quebra deliberadamente** a invariante de [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md)
("`Σ tracks == avail` sempre, nunca overflow") e a substitui por: **a track rígida recebe sempre ≥ seu
mínimo**. Como o slot entregue passa a ser satisfatível, o cliente Wayland aceita, a geometria real
coincide com a pedida e `geometryConverged` volta a curto-circuitar o relayout — **fim da oscilação**.

O parâmetro `priority` (viés da focada/nova de [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md))
permanece na assinatura por compatibilidade, mas no ramo impositivo influencia apenas a **ordem do
cursor** (quem ancora na origem e fica visível), não mais o tamanho.

### B) Fim do sinal de overflow e do Merge Fallback automático

- **Core:** `geometry_from_tree` deixa de chamar `detect_overflow`; `LayoutResult.floating` fica **sempre
  vazio** (o campo permanece no struct/DTO por retrocompat). Reverte a parte B de
  [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md).
- **Pontes (GNOME e KDE):** o Merge Fallback automático (`mergeFallback`/`pickMergeTarget`) e o
  float-and-elevate legado (`floatingAbove`/`releaseToFloating`/`make_above`) são **removidos**. Reverte a
  parte C de [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md) e a seção _Merge Fallback_ de
  [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md).
- **Agrupamento passa a ser estritamente manual:** o **drag-to-group** (zona de drop `center`,
  `addToStack`) permanece intacto nas duas pontes. A Distribuição Cíclica em Quadrantes de
  [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md) permanece.
- A parte A de [0033](0033-min-size-real-e-merge-em-abas-sob-overflow.md) (pontes enviam o `min_width`/
  `min_height` **real**, sem zerar) **permanece** — é o que alimenta o esmagamento impositivo.

### C) Menu de contexto na aba do KDE (helper de overlay)

O clique **direito** numa guia deixa de enfileirar `ungroup` na hora. Em vez disso, o helper nativo
(`etherbit-tiling-preview`, [0039](0039-kde-abas-visuais-no-helper-de-overlay.md)) abre uma nova
`LayerSurface` SHM de menu posicionada no cursor, com um único item **"Desagrupar"**. O clique
**esquerdo** sobre esse item enfileira a **mesma** `TabAction { kind: "ungroup" }` de antes (contrato
D-Bus inalterado: o KWin Script continua drenando `ungroup` via `DrainTabActions`). Clique fora, em outra
superfície, ou direito de novo → o menu fecha sem ação (dismiss). A lógica de hit-test (`hit_test_local`
agora devolve um `BarHit` — `Action` ou `OpenContextMenu` — e há `menu_hit_test`) vive no módulo puro e
testável `tabs.rs`, fora do Wayland. O KWin Script segue como ponte burra ([0013](0013-camada-kde-kwin-script.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md)):
**não pinta nem captura ponteiro**.

### D) Spawn-unmaximize mantido

A regra de [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md)/[0034](0034-estabilizacao-spawn-gnome-wayland.md)
permanece intacta: com tiling ativo, nenhuma janela inicia maximizada; desmaximizar manualmente devolve a
janela ao slot original. Nada nesta decisão depende de `floating`/merge, então a remoção não a afeta.

## Consequências

- **Reafirma 0002/0016:** o core puro decide a geometria (inclusive o esmagamento); o daemon segue sem
  estado (repassa `floating` vazio); as pontes só aplicam ou agrupam **a mando do usuário**.
- **Contrato inalterado:** `compute_constrained`/`LayoutResultDto` mantêm assinatura; só a **semântica** de
  `floating` muda (de "overflow pós-cascata" para "sempre vazio"). `TabAction`/`DrainTabActions` idem.
- **Limitações conhecidas:**
  - **Overflow extremo** (muitas janelas rígidas cujos mínimos somam mais que a tela): as vizinhas são
    recortadas fora da borda (deslocamento compensatório). É a escolha consciente para acabar com a
    oscilação; a alternativa (clampar à tela) reintroduziria a recusa do cliente e o loop no pior caso.
  - **Menu KDE:** rótulo "Desagrupar" **PT-only** na v1 (o helper ainda não tem i18n — dívida); sem
    navegação por teclado (dismiss só por clique, sem ESC); o **primeiro** clique fora do menu apenas o
    fecha, não age na barra (comportamento padrão de popups).
- **Testes:** `layout.rs` inverte os casos de overflow (a rígida não-focada agora recebe seu mínimo e
  `floating` fica vazio) e ganha casos do esmagamento impositivo; `tabs.rs` troca o teste de
  ungroup-no-direito por abertura de menu + `menu_hit_test`; as suítes de `mergeFallback` das pontes
  (GNOME e KDE) são removidas; `protocol.rs` espera `floating` vazio. O caso Calculadora/GNOME Settings/
  Ubuntu Store e o menu do KDE são validados em **sessão real**.
- **Fora do escopo:** `platform-macos` (Swift); i18n do rótulo do menu; navegação por teclado no menu.
