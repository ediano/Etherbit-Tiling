# 0013 — Camada KDE via KWin Script (Wayland-only)

**Status:** ✅ Aceita

## Contexto
Queremos suportar **KDE Plasma 6**, exclusivamente sob **Wayland**. No GNOME, a camada nativa é uma
*GNOME Shell extension* que escuta eventos do Mutter e aplica o layout. No KDE/Wayland o compositor e
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
  não ESM. `minify: false`; alvo `es2019`. Como não há `@girs/*` para o KWin, os globais são tipados
  à mão em `kwin-globals.d.ts`. Lógica pura (`config.ts`, `tiling.ts`) fica isolada e testável em Node
  (ver estratégia de testes por plataforma).
- **Configuração nativa do KWin Script** (não um plasmoid de bandeja nesta fase): `main.xml` + `config.ui`
  (widgets `objectName = kcfg_<chave>`), acessível em *Configurações do Sistema → KWin Scripts → ⚙*.
  Os valores ficam em `~/.config/kwinrc`. O script lê via `readConfig()` e **propaga ao daemon** via
  `callDBus(... Set*)`, mantendo o TOML e o autostart consistentes.
- **Instalação/atualização** via `kpackagetool6 --type=KWin/Script -i|-u`, habilitação via
  `kwriteconfig6 ... <Id>Enabled true` e recarga sem logout via `qdbus org.kde.KWin /KWin reconfigure`.

## Consequências
- **Limitação vs. GNOME:** o `callDBus` do KWin faz *chamadas* de método, mas não há caminho simples
  para **assinar** o sinal `ConfigChanged` do daemon. No KDE a entrada de configuração é o `kwinrc`
  (via `readConfig`/reconfigure); o fluxo é script → daemon (one-way), não bidirecional.
- O layout atual usa um **placeholder** (`tileColumns`) até o core (Ether Flow) decidir o layout —
  mesmo estágio do GNOME (TODO marcado em `main.ts`).
- Requer Plasma 6 (`kpackagetool6`/`kwriteconfig6`/`qdbus6`). Não há fallback X11.
- A baseline de JS do QJSEngine (es2019) é mais conservadora que a do GJS (ES2022); manter o alvo do Vite.

## Emenda (2026-06): linha de corte explícita, daemon em dev e observabilidade da ponte

- **Linha de corte EXCLUSIVA:** **KDE Plasma ≥ 6**, **KDE Frameworks ≥ 6**, **Qt ≥ 6**, sem
  retrocompatibilidade. Os instaladores passam a aceitar **apenas** `qdbus6`/`qdbus-qt6` para o
  `KWin reconfigure` — o `qdbus` puro foi removido da cadeia de fallback porque, num sistema misto,
  pode ser o do **Qt 5** e falar com o KWin errado. Sem nenhum dos dois, o install avisa/erra.
- **O daemon é cliente-obrigatório, e em DEV vem à parte:** como a camada KDE entrega só o KWin
  Script, o `scripts/install.sh` agora faz um *health-check* (`busctl --user status …`) e orienta
  rodar o daemon (`cargo run --manifest-path etherbit-tiling-daemon/Cargo.toml`) ou o pacote completo.
  O `install-kde.sh` valida o daemon com `Ping` após subir o systemd e corrige o `ExecStart` para o
  `$BIN_DIR` real (não o hardcode `%h/.local/bin`).
- **Observabilidade contra a falha silenciosa:** o `callDBus` engole `ServiceUnknown` sem erro. A
  ponte passa a fazer um **handshake `Ping`** na carga e logar com prefixo `[etherbit]`; a regra de
  diagnóstico é "`ponte carregando` sem `Ping OK` ⇒ daemon inacessível". A chave `debug` (kwinrc)
  liga o detalhamento por evento. Ver [0020](0020-resiliencia-ipc-dbus.md) e `docs/DIAGNOSTICO-IPC.md`.
