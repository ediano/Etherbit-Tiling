# 0063 — Barras de abas fixadas por output e maximização por estado real (KDE); auditoria multi-monitor do GNOME

**Status:** ✅ Aceita
(emenda [0039](0039-kde-abas-visuais-no-helper-de-overlay.md) — cada `LayerSurface` do helper passa a
ser **fixada ao output** que a contém, com margens **locais** ao monitor; emenda
[0043](0043-janela-de-graca-de-spawn-unmaximize.md) — o skip do apply e a captura de spawn passam a
usar **estado real de maximização** (`maximizedIds`) em vez de inferência puramente geométrica;
reafirma [0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md) — o `roundPx`/`de_px`
já resolvem a escala fracionária, então "abas 4K" **não** é DPI; auditoria do GNOME sem mudança de
código; só camadas nativas KDE — core/daemon/contrato D-Bus inalterados)

## Contexto

Testes em hardware real num setup multi-monitor **assimétrico** (principal 4K 3840×2160, secundário
Full HD 1920×1080, com escala fracionária) reportaram três anomalias no KDE, mais um pedido de auditoria
preventiva no GNOME. A hipótese inicial da diretiva — **erro de escala/DPI e coordenadas QML hardcoded** —
**não se aplica**: no KDE as abas não são QML (são desenhadas pelo helper nativo `etherbit-tiling-preview`,
[0039](0039-kde-abas-visuais-no-helper-de-overlay.md)) e não há nenhuma lógica de DPI nas camadas — tudo
opera em **pixels lógicos** e a precisão sub-pixel já é resolvida pelo _snap por aresta_ no core e por
`de_px` no daemon ([0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)).

As causas reais são de **origem de coordenadas** e de **classificação de estado**, não de escala.

1. **KDE — tags invisíveis no monitor fora da origem global.** As `LayerSurface` das barras (e do
   preview e do menu de contexto) eram criadas com `output = None` e posicionadas com **margens em
   coordenadas GLOBAIS do compositor** (`set_margin(b.y, 0, 0, b.x)`). No protocolo `wlr-layer-shell`,
   com `output=None` o compositor ancora a superfície a **um** output e interpreta anchor+margens
   **relativas à origem daquele output**. Logo, uma barra cujo retângulo global pertence a um monitor que
   **não** está na origem global `(0,0)` recebe margens que a jogam **para fora da tela** — invisível.
   Isso explica por que um monitor exibe as tags e o outro não: é origem de coordenadas, não densidade.

2. **KDE — "inércia" no resize manual.** `isMaximized()` inferia maximização **só por geometria**
   (quadro == `MaximizeArea` ±1px). Quando o KWin faz _snap_ de um resize manual à borda da tela, a
   janela iguala a `MaximizeArea` e era classificada como maximizada → o loop de apply a **pulava** →
   ficava fora do grid até o usuário arrastá-la. Falso-positivo, não threshold.

3. **KDE — evasão de spawn maximizado.** Casos residuais em que um app auto-maximiza **depois** do
   `windowAdded` sem uma transição de `maximizedChanged` observável escapavam da desmaximização de spawn.

4. **GNOME — pedido de auditoria multi-monitor assimétrico.** Verificar risco de loop de colisão/gaps
   fantasmas ao transitar janelas entre 4K e Full HD.

## Decisão

### KDE — barras/preview/menu fixados ao output, com margens locais

O helper `etherbit-tiling-preview` (`overlay.rs`) passa a **fixar cada `LayerSurface` ao output que
contém seu retângulo** (`output_at`, via `logical_position`/`logical_size` do `OutputState`) e a
**rebaixar as margens globais do core para a origem lógica desse output** (`set_margin(y − oy, 0, 0,
x − ox)`). Vale para as barras de abas, o preview translúcido do drag e o menu de contexto (cujo clamp
por união de outputs vira clamp **dentro** do output do cursor). Como o output de uma `LayerSurface` é
**imutável** após criada, mover o grupo/preview para outro monitor **recria** a superfície (detecção por
mudança da origem fixada). Sem output conhecido para o ponto → **fallback** ao comportamento antigo
(`output=None` + margem global), para não regredir sessões degeneradas. A conversão global→local é uma
função **pura** (`local_origin_for`) coberta por testes de unidade (monitor na origem, deslocado à
direita, deslocado abaixo, ponto fora).

### KDE — maximização por estado real (`maximizedIds`)

A ponte (`main.ts`) mantém `maximizedIds: Set<string>`, reconciliado no sinal `maximizedChanged`
(`syncMaximizedState`): registra maximização **explícita** e a desfaz. O skip do apply e a captura de
spawn passam a consultar esse conjunto **em vez** da geometria:

- Um **resize manual** até a borda **não** dispara `maximizedChanged` → a janela **não** entra em
  `maximizedIds` → recebe seu slot com gaps (fim da "inércia").
- Uma **maximização explícita** entra no conjunto → segue pulada (Unmaximize Recovery preservado).
- **Captura de spawn agressiva:** no apply, uma janela ainda na **janela de graça**
  ([0043](0043-janela-de-graca-de-spawn-unmaximize.md)) com geometria == `MaximizeArea` mas **fora** de
  `maximizedIds` é desmaximizada imperativamente (`setMaximize(false, false)`) — cobre o app que
  auto-maximiza sem `maximizedChanged` observável.
- **Fallback:** onde o sinal `maximizedChanged` não existe (versões antigas do KWin script), o skip cai
  na inferência geométrica antiga, preservando o Unmaximize Recovery. Alvo real é Plasma 6, onde o sinal
  existe. Janelas **fullScreen** ficam fora de escopo (a API de scripting não expõe `setFullScreen`).

### GNOME — auditoria sem mudança

O caso assimétrico já está neutralizado: coordenadas lógicas por monitor via `getWorkAreaForMonitor`;
`window.get_monitor()` relido a cada relayout (migração entre displays recalcula contra a `WorkArea` do
novo monitor); frações de pixel resolvidas por _snap por aresta_ no core + `de_px` no daemon
([0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)); as tags do GNOME são atores
Clutter no **stage global** (espaço único de coordenadas) — não sofrem o bug de origem por-output do KDE.
Nenhuma alteração de código no GNOME.

### Nota operacional — build empacotado

Os logs que motivaram esta investigação (`invalid type: floating point ..., expected i32`, daemon
rejeitando o `SyncWindows` inteiro sob escala fracionária) foram produzidos por um **build empacotado
desatualizado** (anterior ao `roundPx`/`de_px` do [0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md)).
A fonte já estava corrigida; o sintoma some ao **recompilar/reinstalar** os artefatos. Reforço de
processo: revalidar o `dist-release` contra o branch antes de diagnosticar regressões de hardware.

## Consequências

- Barras, preview e menu aparecem no monitor correto em qualquer arranjo/offset (4K + Full HD, lado a
  lado ou empilhados), sem lógica de DPI.
- Resize manual até quase 100% encaixa imediatamente; Unmaximize Recovery intacto; spawn maximizado
  capturado mesmo sem `maximizedChanged`.
- Escopo restrito às camadas nativas KDE; core, daemon e contrato D-Bus inalterados.
