# 0055 — Blacklist de apps na UI do KDE + `SetIgnoreListJson` (JSON sobre D-Bus)

**Status:** ✅ Aceita
(expõe no KDE a `ignore_list` que já existia no core/daemon e no GNOME; reafirma
[0009](0009-ids-uint64-como-string-no-dbus.md) — estruturas compostas trafegam como **JSON string** no
`callDBus` do KWin — e [0016](0016-extensao-ponte-burra-render-no-daemon.md): o filtro é do daemon/core,
a ponte só reporta e reconfigura)

## Contexto

Testes em hardware real confirmaram uma **omissão de interface**: o recurso de **lista de janelas
ignoradas** (impedir que classes específicas — overlays, launchers, apps flutuantes — entrem no tiling)
estava **pronto no core e no daemon**, mas **sem controle visual no KDE**:

- Core: `is_tileable(window, ignore_list)` ([core/src/layout.rs](../core/src/layout.rs)) já filtra por
  `app_id` (case-insensitive).
- Daemon: `Config::ignore_list` ([config.rs](../etherbit-tiling-daemon/daemon/src/config.rs)) e o método
  D-Bus `SetIgnoreList(as)` ([service.rs](../etherbit-tiling-daemon/daemon/src/service.rs)) já persistem
  e aplicam a lista.
- GNOME: a extensão já expõe e chama `SetIgnoreList`.
- **KDE: nunca chamava `SetIgnoreList` e não tinha widget** — a ponte tinha só um campo `ignore_list`
  inerte em `config.ts`/`main.ts`.

A ponte KDE **já serializava `app_id`** (`resourceClass || resourceName`) em cada snapshot, então faltava
apenas **UI + fiação de push** — sem tocar core, daemon-de-layout ou o contrato de `SyncWindows`.

## Decisão

### A) UI nativa (KConfigXT + Qt Designer)

Nova entry `ignoreList` do tipo **`StringList`** em [contents/config/main.xml](../platform-linux-kde/kwin-script/contents/config/main.xml)
e um **`KEditListWidget`** (`objectName="kcfg_ignoreList"`) em
[contents/ui/config.ui](../platform-linux-kde/kwin-script/contents/ui/config.ui) — o widget-padrão de
blacklist do KDE (add/remove por entrada, mesmo do KCM de regras de janela). Os valores persistem no
`kwinrc` como qualquer outro kcfg. i18n pt-BR em `contents/po/pt_BR.po` ([0032](0032-i18n-multilingue.md)).

### B) Fiação `SetIgnoreListJson` (JSON string, não array `as`)

`pushConfigToDaemon()` lê a lista (`readConfig('ignoreList', [])`) e a envia como **JSON string** via um
**novo método** do daemon `SetIgnoreListJson(s)`, que faz `serde_json::from_str::<Vec<String>>` e delega
ao mesmo caminho de `set_ignore_list` (persiste + `ConfigChanged`).

Por que um método novo em vez de reusar `SetIgnoreList(as)`: o `callDBus` do KWin (QJSEngine) **não
empacota array de strings de forma confiável** — a mesma classe de problema que motivou trafegar `uint64`
como string em [0009](0009-ids-uint64-como-string-no-dbus.md). Tudo que a ponte KDE manda cruza o D-Bus
como **string**. O `SetIgnoreList(as)` tipado **permanece intacto** para o proxy do GNOME.

## Consequências

- **Comportamento:** no KDE, o usuário cadastra/edita classes ignoradas nas Configurações do Sistema →
  KWin Scripts → Etherbit ⚙; as janelas dessas classes flutuam e não tilam. Vale no próximo **reload do
  script** (sem watch de `ConfigChanged` no KWin Script — limitação aceita, consistente com os outros
  kcfg).
- **Reafirma 0009/0016:** o filtro (`is_tileable`) e a persistência são do **core/daemon**; a ponte só
  reporta `app_id` e reconfigura. Estrutura composta cruza o D-Bus como **JSON string**.
- **Contrato:** `SyncWindows` inalterado. Novo método aditivo `SetIgnoreListJson`; `SetIgnoreList(as)`
  mantido. **Sem mudança no core Rust nem no algoritmo.**
- **Testes:** vitest cobre o espelho `parseConfig`/`DEFAULT_CONFIG` (`ignore_list`); teste Rust de
  round-trip da config. A captação do `KEditListWidget` pelo KCM de scripts instalados pelo usuário e o
  push efetivo dependem de **sessão Plasma 6 real** (padrão dos ADRs de KDE). Fallback documentado: se o
  binding do `KEditListWidget` se mostrar instável, trocar por um `String` separado por vírgula.
- **Fora do escopo:** `platform-macos` (Swift); GNOME (já tinha a UI).
