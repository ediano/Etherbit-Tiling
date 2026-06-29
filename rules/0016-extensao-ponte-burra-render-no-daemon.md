# 0016 — Extensão "ponte burra", layout no core e renderização no daemon

**Status:** ✅ Aceita

## Contexto
Sob **Wayland em VMs sem aceleração 3D** (GNOME Boxes / LLVMpipe) o ecossistema travava ou não
inicializava. A causa raiz era carga de renderização e lógica acoplada dentro do **GNOME Shell (JS)**:
qualquer desenho customizado (ex.: a "Borda Ativa") e animação no processo do compositor sob
rasterização por software congela a UI.

Surgiu também a tentação de mover a renderização da borda para o daemon Rust com `wgpu`. Porém, sob
Wayland, **um processo separado não desenha overlay ao redor das janelas de outros apps** — só o
compositor pode (o COSMIC contorna isso *sendo* o compositor; o Etherbit roda *sobre* GNOME/KWin). O
ADR [0002](0002-arquitetura-core-agnostico.md) já separa **decisão de layout** (core) de **aplicação**
(camadas nativas), mas faltava firmar onde mora a renderização e o quanto a camada nativa pode conter.

## Decisão
- **A extensão GNOME e o KWin Script são "pontes burras":** não decidem layout e não desenham nada,
  **com a única exceção do preview estático de drop zone** (ver Emenda 2026 abaixo). Atuam como ponte
  IPC de via dupla — coletam metadados brutos das janelas e áreas úteis, chamam `SyncWindows` no
  daemon e **aplicam** os retângulos-alvo devolvidos (`move_resize_frame` no GNOME, `frameGeometry`
  no KWin), de forma **instantânea e geométrica** (sem animação em JS).
- **A decisão de layout vive no core (`etherbit-tiling-core`):** `compute_layout` e `is_tileable`
  (filtro cirúrgico) são únicos e agnósticos, sem dependências nem GL. Elimina a duplicação que existia
  no `_shouldIgnore` (GNOME) e no `tileColumns`/`shouldTile` (KDE).
- **Contrato D-Bus `SyncWindows(windows_json, monitors_json) -> layout_json`** (request/response): serve
  GNOME e KDE igualmente. O KWin Script **não assina sinais**, então usa o RETORNO (modelo *pull*); o
  daemon permanece **sem estado de janelas** (a verdade vive no compositor).
- **A "Borda Ativa" é removida do produto.** Não é desenhável por um cliente Wayland; só pelo
  compositor. Os campos `active_border`/`border_color`/`border_width` e o método `SetActiveBorder`
  ficam no schema como **inertes/reservados** (evita churn no contrato espelhado), mas o controle some
  do indicador e nada os renderiza.
- **A renderização das janelas PRÓPRIAS do daemon usa `wgpu`** (ex.: futuro painel de configurações
  rápidas), atrás da feature `wgpu-ui` (desligada por padrão). O `wgpu` pede adapter de hardware e recai
  automática e transparentemente para software (`force_fallback_adapter` → lavapipe/LLVMpipe), garantindo
  que nunca congele por falta de GPU. **Não** se usa `wgpu` para overlay sobre janelas alheias.
- **Autostart blindado:** os instaladores injetam o UUID em `org.gnome.shell enabled-extensions`
  (via `gnome-extensions enable` ou `gsettings`) e garantem `disable-user-extensions=false`, para o
  Shell carregar a extensão automaticamente no próximo login Wayland — sem passo manual. O daemon
  mantém o serviço `systemd --user` + `.desktop`.

## Emenda (2026): Drop Zone Preview

Recurso novo: ao **arrastar** uma janela, um indicador semi-transparente mostra em tempo real a área
que ela ocupará ao soltar. Isso reabre a questão "quem desenha?" — e a resposta confirma e refina
esta ADR em vez de revogá-la (status permanece **✅ Aceita**).

- **A matemática continua 100% no Rust.** O core ganha `detect_drop_zone(area, x, y, opts)` (zona +
  retângulo, FRAÇÕES da área) e o daemon expõe `ResolveDropZone(x, y, monitors_json) ->
  preview_json` (request/response, **modelo pull**, espelhável GNOME/KDE). A ponte **não decide**
  a zona — só envia o ponto do cursor e recebe o retângulo pronto.
- **O preview é desenhado pela EXTENSÃO**, não pelo daemon. Sob Wayland/GNOME (Mutter, **sem
  `wlr-layer-shell`**) apenas o compositor pode sobrepor janelas alheias; a extensão roda **dentro**
  do compositor e pode, o daemon (processo separado) não. O `wgpu` segue **reservado às janelas
  próprias do daemon** — não é usado para este overlay.
- **Por que isto NÃO reintroduz o problema da "Borda Ativa":** aquela era um overlay **animado e
  contínuo** sobre a janela focada (custo de render constante → congela LLVMpipe). O preview é um
  **único `St.Widget` estático, não-reativo, sem animação e efêmero** (existe só durante o grab de
  movimento), reposicionado por `set_position/set_size`. Custo desprezível. A proibição de **animação
  em JS** permanece de pé.
- **KDE (KWin Script):** mesma matemática (chama `ResolveDropZone`), mas o indicador usa o primitivo
  **nativo** `workspace.showOutline(rect)` / `hideOutline()` — não há equivalente ao `St.Widget`
  preenchido, e uma caixa QML seria peso/fragilidade fora da "ponte burra". O arrasto é rastreado por
  eventos (`Window.interactiveMoveResizeStarted/Stepped/Finished`), sem polling. **Diferença de
  apresentação aceita:** GNOME = caixa preenchida semi-transparente; KDE = *outline* nativo (o mesmo
  do quick-tile). Paridade funcional total.
- **O daemon permanece SEM ESTADO.** O motor de layout evoluiu de colunas para uma **divisão binária
  (BSP) determinística** (grades simétricas infinitas, isoladas por `(monitor, workspace)`), que é
  função pura da **ordem** das janelas. Essa ordem (estado leve) vive na **ponte**, não no daemon —
  o que mantém a paridade pull do KDE e o princípio "a verdade vive no compositor". O drop apenas
  reordena e dispara o relayout. **Resize manual proporcional persistente exigiria estado e fica como
  trabalho futuro (novo ADR).**

## Emenda (2026): Abas, atalhos globais e drag-to-group → ver [0018](0018-abas-atalhos-globais-drag-to-group.md)

A barra de abas é a **segunda exceção** de "desenho na ponte" (após o preview de drop): GNOME usa um
`St.Widget` (`St.BoxLayout`); o KDE, por limitação do KWin *Script* (sem overlay QML confiável), usa
apresentação nativa (aba ativa visível, inativas minimizadas, troca dirigida por ativação). A
matemática (slots/stacks, `detect_drop_target`) segue 100% no core, e o estado novo (stacks, aba
ativa, grupos com tiling desligado) vive na **ponte** — o daemon **permanece sem estado**. Detalhes,
contrato D-Bus evoluído e atalhos em [0018](0018-abas-atalhos-globais-drag-to-group.md). Status deste
ADR permanece **✅ Aceita** (o 0018 o estende, não o revoga).

## Emenda (2026): Árvore persistente e resize → ver [0019](0019-arvore-bsp-persistente-resize-elastico.md)

O "trabalho futuro" de **resize manual proporcional persistente** acima foi cumprido pelo
[0019](0019-arvore-bsp-persistente-resize-elastico.md): o motor evoluiu do BSP função-da-ordem para
uma **árvore BSP persistente com `ratio` por nó**. **Crucial:** a árvore vive como estado leve da
**ponte** (viaja em `state_json` e volta no `layout_json`/`trees_json`) — o **daemon continua sem
estado** e o core continua puro (recebe a árvore, devolve a árvore/geometria). Cantos arredondados
seguem a regra deste ADR: a extensão GNOME (dentro do Mutter) anexa um efeito ao ator; o daemon
(processo externo) não desenha sobre janelas alheias, e o KDE depende do efeito nativo do KWin.
Status permanece **✅ Aceita** (o 0019 o estende, não o revoga).

## Emenda (2026): Resiliência de IPC → ver [0020](0020-resiliencia-ipc-dbus.md)

O ciclo de vida "daemon só sobe no login + uma conexão sem reconexão" se mostrou frágil após
ociosidade/suspensão (parava até o reboot). O [0020](0020-resiliencia-ipc-dbus.md) adiciona **ativação
D-Bus** (o daemon é relançado sob demanda), **reconexão + watch de nome na ponte** e um **wake
handshake via logind**. O daemon segue **sem estado** — o que torna "sair e reativar" uma recuperação
segura. Status permanece **✅ Aceita**.

## Emenda (2026): Grid 3×3 e HUD calculado na ponte → ver [0026](0026-grid-fractal-3x3-elastico-e-hud.md)

O motor evoluiu do BSP binário para um **grid 3×3 elástico** ([0026](0026-grid-fractal-3x3-elastico-e-hud.md)).
Junto, o **preview de drag deixa de ser resolvido no Rust por tick** (`ResolveDropZone`): a matemática das
9 zonas (dividir o alvo por 3 / bordas do monitor) vira um **módulo puro espelhado na ponte**
(`resolveHotZone`), e o **core só é acionado no drop** (`MoveWindow`). Isso **não** revoga este ADR — a
ponte continua a única que desenha (GNOME = células `St.Widget`; KDE = `showOutline` da zona resultante),
o daemon continua **sem estado** e o core continua puro; apenas a aritmética **barata e efêmera** do
preview migra para a ponte (desempenho em VMs). Status permanece **✅ Aceita**.

## Consequências
- **Resiliência estrutural:** como a extensão não renderiza layout e aplica geometria instantânea, o
  congelamento em LLVMpipe deixa de ocorrer — sem precisar detectar render por software no compositor.
  A flag/runtime de "degradação suave" no lado JS torna-se desnecessária. O overlay de drop zone é
  estático/efêmero (um ator reposicionado, sem loop de render) e não recria esse risco.
- **Core agnóstico de fato:** `etherbit-tiling-core` deixa de ser stub e passa a conter o Ether Flow
  (hoje, layout em colunas como placeholder), testável isoladamente. Reafirma o ADR 0002.
- **Paridade GNOME/KDE:** o mesmo método `SyncWindows`/`ResolveDropZone` e o módulo puro espelhado
  `bridge.ts` (como `config.ts` já é espelhado) cobrem as duas camadas. O `id` enviado ao daemon
  segue opaco por chamada; a **ordem estável** (que torna o BSP determinístico e o drop persistente)
  usa uma chave estável de sessão: `get_stable_sequence()` no GNOME e `internalId` no KDE.
- **Limitação registrada:** desenhar bordas/efeitos sobre janelas de terceiros exigiria o Etherbit ser
  o compositor (modelo COSMIC), fora do escopo de extensão/KWin Script.
- **wgpu opcional:** mantém o daemon leve e o CI sem GPU (feature desligada); habilita-se localmente com
  `cargo run --features wgpu-ui`.
