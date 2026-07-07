# 0062 — Ciclo de vida do helper de abas (KDE) e salvaguardas de descarte (GNOME) em hardware real

**Status:** ✅ Aceita
(emenda [0039](0039-kde-abas-visuais-no-helper-de-overlay.md) — o helper de overlay passa a ser
**ativado proativamente** na carga do KWin Script e a **reidratar** as barras num resync de startup,
fechando o "abas invisíveis" quando o helper sobe depois do estado já publicado; emenda
[0038](0038-realizacao-gated-dedup-e-boot-settle.md) — o `_relayout` do GNOME ganha as salvaguardas de
**liveness** e **reconvergência** que o KWin Script já tinha, para o descarte assimétrico não selar uma
sobrevivente num slot sobreposto; reafirma [0059](0059-system-tray-applet-kde-via-kglobalaccel.md)/
[0061](0061-blindagem-multimonitor-desagrupar-e-system-tray-kde.md) — o applet da bandeja está completo,
o "ícone ausente" é empacotamento/habilitação, não código faltante; só camadas nativas — core/daemon/
contrato D-Bus inalterados)

## Contexto

Testes em hardware real (com o GNOME já estável) trouxeram duas anomalias distintas, uma por plataforma,
além de um pedido de parecer sobre a System Tray do KDE.

1. **KDE — abas/tags do grupo invisíveis.** Ao agrupar janelas, o motor vincula-as logicamente e a ponte
   **minimiza as inativas**, mas nenhuma barra de abas aparece: só a última janela do grupo fica visível,
   as anteriores somem sem UI para alternar. A premissa inicial ("componente QML das abas com falha de
   renderização") **não se aplica** — no KDE as abas **não são QML**: são desenhadas pelo helper nativo
   `etherbit-tiling-preview` (wlr-layer-shell + SHM, [0039](0039-kde-abas-visuais-no-helper-de-overlay.md)).
   O sintoma é exatamente o **no-op do helper**: a ponte esconde as inativas, mas o processo que desenharia
   a barra ou não está no barramento, ou subiu **depois** do estado já ter sido publicado — e o dedup
   (`lastTabsKey`) não reemite um `ShowTabs` idêntico para um helper recém-nascido. Confirmado que a
   sessão-alvo é **Wayland** (onde o KWin expõe `zwlr_layer_shell_v1`), então o `LayerShell::bind` sucede;
   a falha é de **ciclo de vida/ativação**, não de ausência de layer-shell.

2. **GNOME — sobreposição residual no descarte.** Numa grade assimétrica (ex.: 2 janelas em cima, 4
   embaixo), fechar uma aplicação faz uma vizinha "desgarrar" e flutuar **por cima** de outra (overlap),
   quebrando o tiling. Causa: o `_relayout` **não filtrava** janelas em `unmanaged` ao montar o snapshot
   (o core recebia N células e dava à sobrevivente um slot da topologia antiga) e **não tinha** a passada
   corretiva que o KWin Script já fazia (`sawDead → retile`, [main.ts](../platform-linux-kde/kwin-script/contents/code/main.ts)).
   O dedup gated por realização ([0038](0038-realizacao-gated-dedup-e-boot-settle.md)) ainda podia **selar**
   a sobrevivente no slot errado, pois ela "convergia" (epsilon 2px) para a geometria sobreposta.

3. **KDE — parecer Go/No-Go da System Tray.** Pedido de análise de viabilidade do applet. **Veredito: GO.**
   O applet já existe e está completo ([0059](0059-system-tray-applet-kde-via-kglobalaccel.md)/[0061](0061-blindagem-multimonitor-desagrupar-e-system-tray-kde.md)):
   KPackage `Plasma/Applet`, QML puro, sem C++, D-Bus via `qdbus6`, **sem código morto no GNOME** (as duas
   superfícies são widgets nativos de shell independentes; nenhum SNI/StatusNotifierItem é introduzido). A
   ausência do ícone é de **empacotamento/habilitação** — não há código a remover.

## Decisão

### A) KDE — ativação proativa do helper + resync de startup (fecha o "abas invisíveis")

- **Ativação proativa (KWin Script):** na carga, logo após o `Ping` do daemon, o script dispara um
  `HideTabs` fire-and-forget na interface `dev.ediano.etherbit.Tabs`. Isso **auto-ativa** o processo
  `etherbit-tiling-preview` via D-Bus (`.service`) **sem depender de um drag prévio** (`ShowPreview`) —
  grupos criados por Meta+S nunca fariam preview e podiam nunca subir o helper.
- **Resync de startup (helper → script):** ao bindar `wlr-layer-shell` com sucesso, o helper envia **um
  wake** pelo MESMO canal dos cliques (kglobalaccel `invokeShortcut`, [0039](0039-kde-abas-visuais-no-helper-de-overlay.md)).
  O `drainTabActions` trata um **drain vazio** (wake sem ação de clique) como sinal de "(re)iniciei sem
  barras": zera o `lastTabsKey` e re-tila, **reemitindo** as barras atuais mesmo com geometria idêntica.
  Sem isso, um helper que sobe depois do estado publicado (ou reinicia) ficava em branco até a próxima
  mudança de layout. Cliques reais nunca caem nesse ramo (drenam ≥1 ação).
- **Diagnóstico (hardware):** o helper loga `apply_bars: N barra(s) recebida(s)` e `desenhando barra
stack=…` no journal. Discriminador: se o **preview translúcido do drag também não aparece**, o helper não
  está rodando (ativação/empacotamento); se aparece mas as abas não, o defeito está no caminho de desenho.

### B) GNOME — liveness no snapshot + reconvergência no apply (fim do overlap pós-descarte)

Paridade com as salvaguardas que o KWin Script já tinha:

1. **Filtro de liveness no snapshot:** `_relayout` descarta janelas não-vivas (`!_isWindowLive`) antes de
   serializar — a janela em `unmanaged` deixa de inflar a grade para N células (espelha o `isLiveWindow`
   do KDE).
2. **Reconvergência `sawDead`:** se uma janela morre **entre** o snapshot e a aplicação, marca e, ao fim,
   **invalida o dedup** (`_lastLayoutSig = ''`) e agenda um relayout corretivo sobre o conjunto sobrevivente
   (espelha o `sawDead → retile` do KDE).
3. **Dedup não sela overlap:** o handler `unmanaged` zera `_lastLayoutSig` antes de reagendar, garantindo
   que a passada pós-fechamento **sempre reaplique** — uma sobrevivente que já "convergiu" para o slot
   antigo não curto-circuita mais o early-return.

### C) System Tray do KDE — mantida; correção é de empacotamento/habilitação

Nenhuma mudança no código do applet. O `packaging/build-kde-release.sh` já estagia o `plasmoid/` e o
`install-kde.sh` já o instala via `kpackagetool6` com a dica de habilitação. Melhorias: o instalador passa
a **avisar** (`warn_no_applet`) quando um bundle antigo **não** traz `plasmoid/` (antes omitia o applet em
silêncio → "ícone ausente" inexplicável), e o README documenta a habilitação (a entrada fica _elegível_,
não é forçada no painel). O `dist-release/` é `gitignore`d — um diretório local stale não é artefato do
repo.

## Consequências

- **Fecha o "abas invisíveis" no KDE Wayland** sem tocar no core/daemon/contrato: só ciclo de vida do
  helper e da ponte. Reafirma [0039](0039-kde-abas-visuais-no-helper-de-overlay.md) (helper desenha; KWin
  Script é ponte burra de pull) e [0029](0029-daemon-sem-framework-visual.md) (daemon sem framework visual).
- **Fim do overlap residual no GNOME:** o descarte assimétrico converge com empuxo/snap exato; nenhuma
  sobrevivente vaza por cima/baixo da vizinha. Só a extensão GNOME muda.
- **Paridade GNOME ⇄ KDE nas salvaguardas de descarte** fica explícita e documentada — a rede
  liveness+reconvergência do KDE passa a existir também no GNOME.
- **System Tray:** parecer GO registrado; sem SNI, sem código morto cruzado; o "ícone ausente" tem causa e
  cura documentadas (habilitar a entrada / reconstruir o bundle).
- **Sem alteração numérica na fronteira.** O adendo consultivo de usar String para dados de tela/workspace
  (int32 vs int64) foi avaliado e **dispensado**: IDs de 64 bits já cruzam como string
  ([0009](0009-nomenclatura-dbus-uuid.md)) ou inteiro pequeno remapeado; coordenadas `i32` têm rede dupla
  `de_px`/`roundPx` ([0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)). Sem risco
  prático de estouro ou perda de precisão de `double`.
- **Testes:** hit-test/layout das abas seguem puros e testados ([tabs.rs](../etherbit-tiling-daemon/preview/src/tabs.rs));
  as suites de `bridge.test.ts` (KDE e GNOME) permanecem verdes. Ativação/resync (kglobalaccel), desenho
  layer-shell e o descarte no Mutter são **validados em sessão real** (hardware), como o resto da camada
  nativa ([0039](0039-kde-abas-visuais-no-helper-de-overlay.md)/[0012](0012-testes-isolados-por-plataforma.md)).
