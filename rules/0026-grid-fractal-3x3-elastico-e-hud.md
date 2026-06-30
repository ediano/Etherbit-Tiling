# 0026 — Grid fractal 3×3 elástico (substitui o BSP) e HUD de preview com 9 zonas

**Status:** 🔄 **Zonas/escopo substituídos** por
[0028](0028-eixos-limpos-cosmic-e-kde-sem-abas.md) — o jogo da velha 3×3, os cantos, a célula unitária
e o split local de 1/3 saíram em favor de eixos limpos 50/50; o `Node::Grid` (binário) e a máquina de
min-size/auto-float **permanecem**. Aceita em sua origem (substituiu a topologia de
[0018](0018-abas-atalhos-globais-drag-to-group.md)/[0019](0019-arvore-bsp-persistente-resize-elastico.md)/[0021](0021-tamanhos-minimos-geometry-hints.md)/[0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md);
estende [0016](0016-extensao-ponte-burra-render-no-daemon.md))

## Contexto

O motor **Ether Flow** era uma **árvore BSP persistente** (`Node::Leaf | Split | Stack`, `ratio` por nó —
[0019](0019-arvore-bsp-persistente-resize-elastico.md)): cada nó dividia o espaço em **dois** pela
proporção de um split. Isso entrega grades, mas o split binário não modela diretamente a interação
"jogo da velha" desejada — uma **matriz de até 3×3** por nó, com **merge no centro**, **linha/coluna
inteira nos eixos**, **célula nos cantos**, e um **HUD de preview** que distingue **escopo local** (corpo
de uma janela) de **escopo global** (bordas/gaps da tela). O split binário também tornava o preview de
drag um cálculo do Rust por tick (`ResolveDropZone`), acoplando a renderização do HUD a uma ida ao daemon.

## Decisão

### Modelo: grid elástico de até 3×3 por nó (substitui o `Split`)

`Node::Split` é **removido**. O enum `Node` passa a ser:

- `Leaf(u64)` — uma janela (ocupa 100% se for a raiz);
- `Stack { members, active }` — **mantido** (o quadrante **centro** = merge/abas);
- `Grid { cols: Vec<f64>, rows: Vec<f64>, cells: Vec<GridChild> }` — uma matriz **elástica** de
  **1..=3 colunas × 1..=3 linhas**; `cols`/`rows` são frações (somam 1) e cada
  `GridChild { node, col, row, col_span, row_span }` posiciona um filho recursivo numa faixa de células.

**Princípio:** o "3×3" é o **teto de subdivisão por nó** e a metáfora de interação; as tracks são
**elásticas** (1–3 por eixo). Isso unifica: janela única → `Leaf`; bloco global 50% →
`Grid { cols:[0.5,0.5] }`; coluna local 1/3 → `Grid { cols:[1/3,2/3] }`; subdivisão **infinita** →
a célula-alvo de um 3×3 cheio vira um **sub-`Grid`** (fractal). A geometria deriva os retângulos das
tracks (com `inner_gap` entre elas, `outer_gap` na borda da área) e **recorre** nos filhos.

### Semântica das 9 zonas + escopo (drop)

| Zona (jogo da velha)                                          | Ação no drop                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **5 — Centro**                                                | **Merge/abas**: o alvo vira `Stack { [alvo, arrastada] }`                                                        |
| **2/4/6/8 — Eixos**                                           | A nova janela toma a **linha/coluna inteira** daquele lado (track 1/3); o alvo é empurrado para as 2/3 restantes |
| **1/3/7/9 — Cantos**                                          | A nova janela toma a **célula de canto**; o alvo ocupa o restante (span)                                         |
| **Escopo Global** (perto das bordas da tela / em _gap_ vazio) | Insere como **nó principal do workspace**: bloco de **50%**; o resto cascateia no outro 50%                      |
| **Escopo Local** (sobre o corpo de uma janela)                | Subdivide **dentro** da submatriz daquela janela                                                                 |

### Min-size como span elástico em cascata (generaliza [0021](0021-tamanhos-minimos-geometry-hints.md))

A máquina de mínimos do split binário é **generalizada para tracks N-árias**: `min_extent(Grid)` soma os
mínimos por track no eixo (+ `inner_gap`) e usa `max` no perpendicular; a geometria **clampa por track**.
Quando um filho exige mais que sua célula, **expande seu span** e as tracks vizinhas **encolhem em
cascata** (100% preenchido, sem cantos vazios nem sobreposição). A **janela focada/nova é protegida**
(nunca é vítima); **auto-float** (`enforce_min_sizes`/`floating_rect`) permanece como rede de segurança
no caso impossível. **Stacks** seguem agregando o `max` dos mínimos dos membros sob a âncora.

### HUD calculado na ponte (emenda ao [0016](0016-extensao-ponte-burra-render-no-daemon.md))

O preview de drag deixa de ser resolvido no Rust por tick (`ResolveDropZone`). A **matemática das zonas
vira um módulo puro espelhado na ponte** (`resolveHotZone` em `bridge.ts`, testado em vitest): lê as
coordenadas físicas da janela-alvo sob o cursor, **divide por 3** (local) ou usa as bordas/gap do monitor
(global), e devolve a zona + os retângulos a acender — **sem D-Bus**. O **core só é acionado no drop**:
a ponte chama `MoveWindow(state, dragged, target, zone, scope)` e o Rust **reconverte a árvore** e aplica
o relayout rígido de uma vez. Isso **reafirma** o 0016 (ponte desenha, daemon sem estado, core puro);
apenas move a aritmética **barata e efêmera** do preview para a ponte (ganho de desempenho em VMs).

### HUD por plataforma (mantém "diferença de apresentação aceita" do 0016/0018/0025)

- **GNOME:** a extensão (dentro do Mutter) desenha as **9 células translúcidas** com `St.Widget` em
  `Main.layoutManager.uiGroup` — estático, efêmero, sem animação (reafirma 0016). Centro = realce de
  merge; eixos = linha/coluna inteira; cantos = célula.
- **KDE:** o KWin _Script_ (QJSEngine) **não desenha overlay de 9 células** — usa o primitivo nativo
  `workspace.showOutline(rect)` para realçar **só a zona resultante** (1 retângulo). **Paridade
  funcional**, não visual (mesma família do 0016/0018/0025). A barra de abas clicável do KDE
  (wgpu/wlr-layer-shell, 0025) **não** é reusada para o HUD nesta decisão.

> **Emenda [0029](0029-daemon-sem-framework-visual.md):** o HUD do KDE chegou a ter um overlay `wgpu`
> próprio no daemon (`ShowDropHud`/`HideDropHud`); ele foi **removido**. O preview do KDE é agora
> **exclusivamente** o `workspace.showOutline` nativo, e o daemon não contém mais código gráfico.

### Contrato D-Bus

`Split → Grid` é espelhado em todos os pontos (núcleo, daemon `protocol.rs`/`service.rs`, e as duas
pontes): `NodeDto` ganha `{ "grid": { cols, rows, cells } }` (untagged, `#[serde(default)]`), `{"win":id}`
e `{"stack":{...}}` mantidos. `MoveWindow` ganha o parâmetro `scope`. IDs seguem viajando como **string**
no `callDBus` do KDE ([0009](0009-nomenclatura-dbus-uuid.md)); a tradução `internalId ↔ transporte`
(`treeToTransport`/`treeFromTransport`) passa a **recorrer nas `cells`** do `Grid`.

## Consequências

- **Core ainda puro, daemon ainda sem estado, ponte ainda dona do estado leve** (a árvore com `Grid`
  viaja em `state_json`/`trees_json`). Reafirma [0002](0002-arquitetura-core-agnostico.md)/0016.
- **Reescrita do motor e dos testes:** `compute_geometry`/`reconcile`/`move_window`/`resize_window` e os
  ~57 testes do `layout.rs` foram reescritos para o grid. A máquina de mínimos/auto-float, os stacks e o
  esqueleto de drop foram **reaproveitados** (generalizados), não jogados fora.
- **ADRs substituídos na topologia:** 0018/0019/0021/0022 têm o status alterado para _Substituída por
  #0026_ na parte de árvore BSP; o que permanece válido (stacks como conceito, min-size como requisito,
  Unmaximize Recovery, contrato espelhado, daemon sem estado) foi transportado para cá.
- **Limitação registrada (KDE):** sem as 9 células visuais (só outline da zona resultante), igual à
  família de degradações já aceitas. Latência zero/paridade visual no KDE continuaria a depender de um
  KWin _Effect_ ou de estender a superfície wgpu/layer-shell do 0025 — fora do escopo desta decisão.
- **Fora do escopo:** `platform-macos` (Swift, não compila no container Linux). O core continua
  agnóstico; o consumo macOS do novo modelo é **trabalho futuro** adaptado no host.
