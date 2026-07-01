# 0047 — Desagrupar por arraste também pela barra de título nativa (GNOME e KDE) e correção do press da tag no GNOME

**Status:** ✅ Aceita
(emenda [0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md),
[0045](0045-desagrupar-reancora-no-lugar-zona-eject.md) e
[0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md) — estende o drag-to-ungroup à
**barra de título nativa** e corrige o press da **tag** no GNOME, que o `St.Button` engolia; reafirma
[0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md): a
correção é **100% de ponte** — core, daemon e contrato D-Bus não mudam)

## Contexto

Testes em sessão real expuseram que o **desagrupar por arraste** ([0042](0042-colisao-por-celula-resize-grab-gnome-e-drag-to-ungroup.md),
reativado por [0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)) estava
desalinhado entre os dois ambientes, com dois sintomas e duas causas-raiz distintas:

- **GNOME — arraste da tag totalmente morto.** A guia (`tab`, `St.BoxLayout`) contém um `activateBtn`
  (`St.Button`) que a preenche. O listener de arraste estava em `tab.connect('button-press-event')`
  na fase **bubble**. O `St.Button` consome o press **primário** (button-mask padrão = botão 1 →
  `EVENT_STOP`) **antes** de o evento subir ao `tab` — então `_beginTabDrag` **nunca** disparava. O
  botão **secundário** não é mascarado → subia → o menu de contexto funcionava. Daí a assimetria
  relatada: "menu funciona, arraste não".
- **GNOME e KDE — arraste da barra de título nativa não desagrupa.** Os handlers de move-grab
  (GNOME `_onGrabEnd`; KDE `onMoveFinish`) resolviam a drop zone e faziam `MoveWindow`, mas **nunca**
  chamavam `removeIdFromStacks`. O core `detach_window` removia a janela da árvore, mas o `stacks` Map
  da ponte ainda a mantinha → `serializeState` **re-materializava** o stack no próximo relayout →
  re-agrupamento ("mantém o agrupamento travado" / "move o bloco inteiro").

O critério de aceite pede **unificação**: em GNOME e KDE, ejetar uma janela do grupo arrastando-a para
fora deve funcionar **tanto pela tag quanto pela barra de título** da janela focada, deixando o resto
do grupo intacto no quadrante.

## Decisão

### A) GNOME: o press da tag é capturado na fase de CAPTURA (não bubble)

`_makeTabButton` troca `tab.connect('button-press-event', …)` (bubble) por
`tab.connect('captured-event', …)`. A fase de captura roda no **pai antes** do filho `St.Button`,
então o `tab` vê o press primário antes de o botão o consumir. O handler filtra
`BUTTON_PRESS`, roteia o **secundário** ao menu (`EVENT_STOP`) e, no **primário**, chama
`_beginTabDrag` e retorna `EVENT_PROPAGATE` — o `activateBtn` ainda recebe o clique normal (troca de
aba quando solto **dentro** da barra). `_beginTabDrag` só arma um `captured-event` de stage que
observa o `BUTTON_RELEASE`, e `_finishTabDrag` decide dentro/fora pela geometria de `_tabBarRects`
([0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)): clique simples **não** ejeta.

### B) GNOME e KDE: arrastar pela barra de título nativa ejeta a janela agrupada

Novo helper **puro e read-only** `isStackMember(stacks, id)` em ambas as pontes (varre todos os grupos
— a janela pode estar num stack de outro monitor/workspace), complementando `removeIdFromStacks` (que
muta). No fim do move-grab, se a janela arrastada é membro de um stack, o gesto **ejeta só ela** e a
reposiciona onde foi solta (regra **"sempre que soltar"**), reusando o caminho de eject já existente:

- **GNOME (`_onGrabEnd`):** ramo novo chama `_ejectTabAt(draggedId, x, y)` (que faz
  `removeIdFromStacks` + `resolveHotZone` + `MoveWindow`, com fallback zona `eject` que reancora o
  grupo no lugar — [0045](0045-desagrupar-reancora-no-lugar-zona-eject.md)).
- **KDE (`onMoveFinish`):** ramo novo espelha o `ungroup_drag` do overlay (traduz o transporte
  **antes** de mutar, `dropEjectedAt` com guard `ejected` e fallback `ejectFromStack` na zona
  `eject`).

**Exceção (re-agrupar):** soltar no **centro de OUTRA janela** não ejeta — segue o `addToStack`
(agrupar em abas), como no drag-to-group manual do centro
([0046](0046-agrupamento-so-manual-no-centro-e-fim-do-auto-colisao.md)). Janela **não-agrupada**
(solta) mantém o tiling normal (split/50%/maximizar) intacto — o ramo só entra sob `isStackMember`.

## Consequências

- **Comportamento:** em GNOME e KDE, desagrupar por arraste funciona **pela tag e pela barra de título
  nativa**, ejetando só a janela focada e deixando o grupo intacto ("cai onde foi solta"). O clique
  simples na aba segue trocando de aba; o clique direito segue abrindo "Desagrupar".
- **Simplificação/reuso:** nenhum fluxo novo de eject — a barra de título reusa `_ejectTabAt` (GNOME)
  e `dropEjectedAt`/`ejectFromStack` (KDE); o único código novo é o helper `isStackMember` e a
  ramificação por membership.
- **Reafirma 0002/0016:** a topologia (`detach_window`, zona `eject`) é do **core**; a captura do
  ponteiro e a decisão de ejetar seguem nas **pontes** (GNOME na extension; KDE no KWin script +
  helper de overlay [0039](0039-kde-abas-visuais-no-helper-de-overlay.md)).
- **Contrato:** `MoveWindow` (zonas `eject`/`left`/`right`/`top`/`bottom`/`center`) inalterado. **Sem
  mudança no core Rust, no daemon ou no D-Bus.**
- **Limitação conhecida:** o arraste pela barra de título **não tem preview específico de "eject"** — o
  outline/HUD do drag mostra a zona de tile como para uma janela solta; ao soltar fora, ejeta assim
  mesmo. É paridade GNOME/KDE (nem o gesto da tag tem preview de eject) e aceita-se por ora.
- **Preserva:** agrupamento só manual no centro, zona `eject` que reancora no lugar, abas 1/N,
  ocultação de abas sob janela maximizada, esmagamento cooperativo de min-size, o menu "Desagrupar".
- **Testes:** vitest cobre o helper puro `isStackMember` (membro de qualquer grupo → `true`; solto e
  Map vazio → `false`; não muta) em ambas as pontes. Os handlers `_onGrabEnd`/`onMoveFinish` e o
  `captured-event` da tag dependem de Clutter/KWin e são validados em **sessão real**, GNOME e KDE
  (padrão dos ADRs 0038-0046).
- **Fora do escopo:** `platform-macos` (Swift).
