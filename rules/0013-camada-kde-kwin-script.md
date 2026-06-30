# 0013 — Camada KDE via KWin Script (Wayland-only)

**Status:** ✅ Aceita

## Contexto

Queremos suportar **KDE Plasma 6**, exclusivamente sob **Wayland**. No GNOME, a camada nativa é uma
_GNOME Shell extension_ que escuta eventos do Mutter e aplica o layout. No KDE/Wayland o compositor e
gerenciador de janelas é o **KWin**, que **não** tem o conceito de "extensions" do GNOME Shell. O ponto
de extensão equivalente é um **KWin Script** (JavaScript executado dentro do próprio KWin), com acesso
aos globais `workspace` (sinais `windowAdded`/`windowRemoved`/`windowActivated`, `clientArea()`), ao
objeto `Window` (geometria via `frameGeometry`, flags de classificação) e a `callDBus()`/`readConfig()`.

Decisões a fixar: **o que** a camada KDE entrega, **como** é compilada e **como** é configurada.

## Decisão

- **A camada KDE (`platform-linux-kde/`) entrega apenas o KWin Script** (`kwin-script/`), análogo da
  `extension/` do GNOME. O daemon **não** é recriado aqui — é reaproveitado (ver [0014](0014-daemon-linux-compartilhado.md)).
- **Wayland apenas.** Sem suporte/teste em X11.
- **Empacotamento KPackage** (`KPackageStructure: "KWin/Script"`): `metadata.json` na raiz, código em
  `contents/code/`, config em `contents/config/main.xml` (KConfigXT) e UI em `contents/ui/config.ui`.
  `KPlugin.Id = etherbit-tiling` define a pasta de instalação (`~/.local/share/kwin/scripts/etherbit-tiling/`).
- **Tooling espelha o GNOME (ADR [0010](0010-tooling-extensao-e-zbus.md)): TypeScript + Vite + pnpm + vitest.**
  Diferença crítica: o KWin avalia `main.js` num contexto de **script clássico** (QJSEngine do Qt), sem
  `import`/`export` em runtime. Por isso o Vite empacota em **IIFE** (bundle único auto-executável),
  não ESM. `minify: false`; alvo `es2019` (**corrigido para `es2017`** — ver emendas 2026-06 abaixo).
  Como não há `@girs/*` para o KWin, os globais são tipados
  à mão em `kwin-globals.d.ts`. Lógica pura (`config.ts`, `tiling.ts`) fica isolada e testável em Node
  (ver estratégia de testes por plataforma).
- **Configuração nativa do KWin Script** (não um plasmoid de bandeja nesta fase): `main.xml` + `config.ui`
  (widgets `objectName = kcfg_<chave>`), acessível em _Configurações do Sistema → KWin Scripts → ⚙_.
  Os valores ficam em `~/.config/kwinrc`. O script lê via `readConfig()` e **propaga ao daemon** via
  `callDBus(... Set*)`, mantendo o TOML e o autostart consistentes.
- **Instalação/atualização** via `kpackagetool6 --type=KWin/Script -i|-u`, habilitação via
  `kwriteconfig6 ... <Id>Enabled true` e recarga sem logout via `qdbus org.kde.KWin /KWin reconfigure`.

## Consequências

- **Limitação vs. GNOME:** o `callDBus` do KWin faz _chamadas_ de método, mas não há caminho simples
  para **assinar** o sinal `ConfigChanged` do daemon. No KDE a entrada de configuração é o `kwinrc`
  (via `readConfig`/reconfigure); o fluxo é script → daemon (one-way), não bidirecional.
- O layout atual usa um **placeholder** (`tileColumns`) até o core (Ether Flow) decidir o layout —
  mesmo estágio do GNOME (TODO marcado em `main.ts`).
- Requer Plasma 6 (`kpackagetool6`/`kwriteconfig6`/`qdbus6`). Não há fallback X11.
- A baseline de JS do QJSEngine é mais conservadora que a do GJS (ES2022); manter o alvo do Vite
  baixo (**`es2017`** — ver emendas 2026-06; as hipóteses iniciais `es2019`/`es2018` provaram-se
  otimistas demais).

## Emenda (2026-06): linha de corte explícita, daemon em dev e observabilidade da ponte

- **Linha de corte EXCLUSIVA:** **KDE Plasma ≥ 6**, **KDE Frameworks ≥ 6**, **Qt ≥ 6**, sem
  retrocompatibilidade. Os instaladores passam a aceitar **apenas** `qdbus6`/`qdbus-qt6` para o
  `KWin reconfigure` — o `qdbus` puro foi removido da cadeia de fallback porque, num sistema misto,
  pode ser o do **Qt 5** e falar com o KWin errado. Sem nenhum dos dois, o install avisa/erra.
- **O daemon é cliente-obrigatório, e em DEV vem à parte:** como a camada KDE entrega só o KWin
  Script, o `scripts/install.sh` agora faz um _health-check_ (`busctl --user status …`) e orienta
  rodar o daemon (`cargo run --manifest-path etherbit-tiling-daemon/Cargo.toml`) ou o pacote completo.
  O `install-kde.sh` valida o daemon com `Ping` após subir o systemd e corrige o `ExecStart` para o
  `$BIN_DIR` real (não o hardcode `%h/.local/bin`).
- **Observabilidade contra a falha silenciosa:** o `callDBus` engole `ServiceUnknown` sem erro. A
  ponte passa a fazer um **handshake `Ping`** na carga e logar com prefixo `[etherbit]`; a regra de
  diagnóstico é "`ponte carregando` sem `Ping OK` ⇒ daemon inacessível". A chave `debug` (kwinrc)
  liga o detalhamento por evento. Ver [0020](0020-resiliencia-ipc-dbus.md) e `docs/DIAGNOSTICO-IPC.md`.

## Emenda (2026-06): alvo do Vite `es2019` → `es2018` (optional catch binding)

- **Sintoma real em VM limpa (Kubuntu/Plasma 6):** `kwin_scripting: .../main.js:23: error: Syntax error`
  já na carga — o KWin rejeita o script inteiro e o tiling fica inerte.
- **Causa:** a linha 23 é um `} catch {` (**optional catch binding**, uma feature **ES2019**). O
  QJSEngine do Qt 6 **não** aceita `catch` sem a variável de erro. A premissa original ("QJSEngine
  cobre ES2019 com folga") estava errada justamente na única adição sintática do ES2019. Como o alvo
  era `es2019`, o esbuild **preservava** o `catch {` em vez de transpilá-lo.
- **Correção:** alvo do Vite agora é **`es2018`**. O esbuild reescreve `} catch {` → `} catch (e) {`
  (e qualquer sintaxe ≥ES2019, como `?.`/`??`), mantendo o bundle interpretável. Validado: bundle
  gerado sem `catch {`, sem `?.`/`??` e sem `export`/`import` vazados, ainda como IIFE puro.
- **Nota:** o `export`/`import` no runtime clássico continua sendo um risco real (daí a IIFE), mas
  **não** era a causa deste `Syntax error` — o bundle já não continha ESM. A linha 23 era o `catch {`.

## Emenda (2026-06): `workspace.windows` é QML-only → usar `workspace.windowList()`

- **Sintoma real em VM limpa (Kubuntu/Plasma 6):** após corrigir o `Syntax error`, a ponte abortava na
  carga com `kwin_scripting: .../main.js:933: error: Type error`, na linha da **captura inicial de
  janelas** (`for (const win of workspace.windows)`). O log chegava a `ponte carregando` mas nunca a
  `ponte carregada`.
- **Causa:** `workspace.windows` é uma propriedade exposta **apenas na API QML** do KWin; na API
  **JavaScript** (este script — `X-Plasma-API: "javascript"`) ela **não existe**. No QJSEngine, acessar
  propriedade inexistente devolve `undefined`, e iterar `undefined` com `for…of` lança `Type error`. A
  premissa de que `windows` valia em ambas as APIs estava errada.
- **Correção:** usar o **método `workspace.windowList()`** (equivalente JS — "lists all clients … Not
  available in QML") em todas as enumerações de janelas; `kwin-globals.d.ts` passa a declará-lo como
  método. Os demais membros usados (`currentDesktop`, `desktops`, `activeWindow`, `cursorPos`,
  `clientArea`, `showOutline`/`hideOutline`) **são** disponíveis em JS e ficam inalterados.
- **Nota:** apenas null-guardar a iteração pararia o crash, mas a ponte enxergaria **zero** janelas
  (falha silenciosa, sem tiling) — por isso a correção é trocar a API, não blindar o `undefined`.
- Referência: doc da API do KWin (Workspace) — `windowList()` vs. propriedade QML `windows`.

## Emenda (2026-06): alvo do Vite `es2018` → `es2017` (object spread)

- **Sintoma real (Plasma 6, após nova compilação das regras de UI):** `kwin_scripting:
.../main.js:199: error: Unexpected token '...'` já na carga — o KWin rejeita o script inteiro e o
  tiling fica **completamente** inerte (nenhum handler é registrado).
- **Causa:** a linha era `outline: { ...target }` (**object spread**, uma feature **ES2018**) no HUD
  de drop-zone (`bridge.ts`, introduzido com o jogo-da-velha — ADR 0026). O QJSEngine do Qt 6 **não**
  aceita `{ ...x }`. Como o alvo era `es2018`, o esbuild **preservava** o spread em vez de transpilá-lo.
  (Array spread `[...]` e rest `(...args)`, ES2015, sempre foram aceitos — só o object spread quebra.)
- **Correção (dupla, defensiva):**
  1. **Fonte:** o `outline` passou a usar literal explícito `{ x, y, width, height }`, consistente com
     os ramos irmãos da mesma função (que nunca usaram spread).
  2. **Build:** alvo do Vite agora é **`es2017`**. O esbuild transpila qualquer `{ ...x }` futuro
     (`__spreadValues`), **mantém** o downlevel do `optional catch binding` (ES2019, emenda anterior) e
     preserva array spread/rest (ES2015). Validado: bundle gerado sem `{ ...` cru.
- **Lição:** o alvo do Vite é a fronteira de sintaxe que o QJSEngine tolera; cada feature sintática
  ≥ES2018 adicionada à fonte precisa ser coberta pelo downlevel do esbuild (manter o alvo conservador).

## Emenda (2026-06): KWin Script não pinta superfícies — preview translúcido vive num helper

- **Limite real da API:** o KWin _Script_ (QJSEngine, `X-Plasma-API: javascript`) expõe **só**
  `workspace.showOutline`/`hideOutline` para desenho — um **contorno opaco**. Não há `Qt`/QML/
  `createQmlObject`/`PlasmaCore` no contexto do script (a API QML do KWin é `undefined` em JS). Um KWin
  _Effect_ scriptado também não pinta retângulos livres (só anima janelas existentes).
- **Consequência (ADR [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md)):** o
  preview **translúcido** (alpha 0.3–0.4) é impossível dentro do Script. Ele vive num **helper nativo
  separado** (`etherbit-tiling-preview`): cliente Wayland wlr-layer-shell que desenha o retângulo via
  SHM, acionado por D-Bus pela ponte. O `showOutline` nativo permanece como **fallback**.
- **Lição:** translucidez/superfícies próprias no KDE só por C++ ou cliente Wayland dedicado — nunca
  por um KWin Script/Effect scriptado.
