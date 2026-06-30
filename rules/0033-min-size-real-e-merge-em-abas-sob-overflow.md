# 0033 — Min-size real, sinal de overflow e Merge Fallback em abas (paridade GNOME ⇄ KDE)

**Status:** ✅ Aceita
(emenda [0021](0021-tamanhos-minimos-geometry-hints.md) — as pontes deixam de zerar o min de apps
tiláveis; emenda [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) — o core volta a
**emitir** `floating` como sinal de _overflow_; **reativa** o Merge Fallback de
[0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md), que estava dormente; emenda
[0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md) — reintroduz abas no KDE para o caso de overflow,
buscando paridade com o GNOME; reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md))
A parte **B** (sinal de overflow `floating`) e a parte **C** (Merge Fallback) foram **descontinuadas** por
[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md) — esmagamento impositivo de min-size,
agrupamento só manual. A parte **A** (min-size **real** nas pontes) **permanece**.

## Contexto

Em sessão real no **Wayland**, apps com `min-width`/`min-height` nativos grandes (ex.: **Ubuntu Store**,
GNOME Software) nascendo num quadrante pequeno da Distribuição Cíclica eram **ejetados para flutuante**
pelo compositor.

A causa é a política do [0021](0021-tamanhos-minimos-geometry-hints.md)/[0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md):
as pontes **zeravam** o min-size de janelas tiláveis (`normal && resizable && maximizable → [0,0]`) para
"fixar o app no slot, recortando o conteúdo". Esse truque é de origem **X11**. No **Wayland o cliente
controla o próprio tamanho** e **recusa** encolher abaixo do seu `xdg min_size`: zerar o hint não fixa
nada — o app transborda e o Mutter/KWin o **ejeta para o modo flutuante**, justamente o que o tiling
deve evitar. A cascata de [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) comprime
geometricamente sem sobrepor, mas a geometria comprimida é **ignorada** pelo cliente Wayland.

Além disso, o Merge Fallback (agrupar em abas) de [0030](0030-distribuicao-ciclica-quadrantes-e-merge-fallback.md)
— a saída correta para "não cabe", pois cada aba recebe o slot inteiro — ficou **dormente** desde o
[0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) (que zerou `floating`), e o KDE
nem o tinha (abas removidas pelo [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md)).

## Decisão

### A) Min-size REAL nas pontes

GNOME (`_snapshot`) e KDE (coleta do `retile`) param de zerar o min e enviam o `min_width`/`min_height`
**real** (`Meta.Window.get_min_size()` / `KWinWindow.minSize`) para **toda** janela.

### B) Sinal de overflow no core (`core/src/layout.rs`)

`geometry_from_tree` passa a detectar, **após** a cascata (`solve_tracks`) ter comprimido o máximo, as
folhas cujo slot final ainda ficou **abaixo do mínimo** (`detect_overflow`: `round(slot) < min` em
qualquer eixo, `<` estrito). Essas janelas voltam a ser reportadas em **`LayoutResult.floating`** —
reusando o campo existente (já consumido pelas pontes; `#[serde(default)]` no DTO mantém a
retrocompat). As janelas **seguem tiladas** (não somem do grid); `floating` é só o sinal "não cabe".
`solve_tracks`/`geom_leaves_min` **não mudam** — a cascata e o viés da focada de
[0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md) seguem valendo (quando a cascata
**resolve**, `floating` sai vazio).

### C) Merge Fallback reativado nas DUAS pontes (paridade)

Ao receber `floating` não-vazio, a ponte agrupa a janela como **aba** no quadrante focado
(`mergeFallback` → `addToStack`), onde cada aba recebe o slot inteiro e o app cabe. Um guard
`_mergeAttempted` evita o loop sync↔merge; o que ainda estourar após o merge cai no float-and-elevate
legado como rede.

- **GNOME:** o caminho já existia (estava dormente) — apenas volta a receber `floating`.
- **KDE:** **reintroduz o subsistema de abas** para esse caso (emenda [0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md)):
  estado `stacks`/`mergeAttempted`/`stackHidden` na ponte, `serializeState` enviando os stacks reais
  (o core/daemon já materializam `Node::Stack`), preservação de stacks na tradução
  internalId ↔ transporte, e render mínimo (minimizar abas inativas + ativa no slot).

### Escopo do KDE (mínimo viável)

A **barra de abas clicável** do KDE permanece fora deste ADR (depende do helper nativo
`etherbit-tiling-preview` do [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md));
a troca de aba se dá por foco. Não há gesto de _ungroup_ nem _drag-to-group_ no KDE — só o agrupamento
automático sob overflow. A paridade de **comportamento de layout** (mesmo algoritmo cíclico, cascata e
Merge Fallback) está garantida; a paridade de **UI da barra** fica como evolução futura.

## Consequências

- **Reafirma 0002/0016:** o core puro decide o overflow; o daemon segue sem estado (repassa `floating`,
  zero mudança estrutural); as pontes só aplicam.
- **Contrato inalterado:** `compute_constrained`/`LayoutResultDto` mantêm a assinatura; só a **semântica**
  de `floating` muda (de "congelado/vazio" para "overflow pós-cascata").
- **Retrocompat:** daemon novo + ponte GNOME antiga reativaria o float-and-elevate legado (= comportamento
  pré-0031, aceitável e some ao atualizar a ponte).
- **Testes:** `layout.rs` inverte os casos de overflow real (`min_inviavel_comprime_e_sinaliza_overflow`,
  `impossivel_comprime_e_sinaliza_ambas_em_overflow`, `focada_satura_no_min_vizinho_comprime`,
  `focada_mantem_min_demais_comprimem`) e ganha `detect_overflow_sinaliza_so_abaixo_do_min_estrito`;
  `protocol.rs` ajusta os `sync_*`; vitest do KDE ganha a suíte de `mergeFallback`/`addToStack`/
  `parseTabBars`. O encaixe no spawn e o caso Ubuntu Store são validados em **sessão real**.
- **Spawn no GNOME (correlato):** o encaixe da 1ª janela passa a ser gatilhado pelo sinal `first-frame`
  do `Meta.WindowActor` (já mapeado/dimensionado no Wayland), com desmaximização atômica antes do 1º
  posicionamento — encerra o bug da "1ª janela flutuante".
- **Fora do escopo:** `platform-macos` (Swift); a barra de abas clicável do KDE.
