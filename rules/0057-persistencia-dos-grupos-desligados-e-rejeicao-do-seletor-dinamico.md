# 0057 — Persistência dos grupos com tiling desligado (config do daemon) e rejeição do seletor dinâmico no KCM estático

**Status:** ✅ Aceita
(emenda [0027](0027-chave-geral-de-ativacao-do-tiling.md) — a ativação granular por
`(monitor, workspace)`, hoje só via Meta+Y, passa a **persistir**; usa a chave estável de
[0056](0056-identidade-estavel-de-monitor-por-output-name-kde.md); reafirma
[0016](0016-extensao-ponte-burra-render-no-daemon.md)/[0017](0017-daemon-sem-estado-de-janelas.md): o
daemon guarda **config**, não estado de layout)

## Contexto

Testes em hardware real apontaram uma segunda **omissão de interface**: o core suporta ligar/desligar o
tiling **por monitor e por workspace** (`disabled_groups`, honrado em `compute_layout_with`), e o KDE já
alterna o grupo ativo via **Meta+Y** — mas esse estado era **efêmero na ponte**: sem persistência, sem
setter D-Bus, sem UI/lista. Reiniciar o KWin **perdia** quais telas/workspaces estavam com o tiling
desligado.

A diretiva pedia ainda **seletores visuais por monitor/workspace** nas Configurações do KDE. Aqui há um
limite arquitetural: o painel do KWin Script é um **KConfigXT + `.ui` estático** (KCM
`kcm_kwin4_genericscripted`), que **liga chaves fixas** do `kwinrc` — ele **não enumera monitores/desktops
em runtime**. E o KWin Script **não tem `writeConfig`** (só `readConfig`), então a ponte **não pode**
persistir sozinha.

## Decisão

### A) Persistir via config do daemon (não no `kwinrc`)

Novo campo `Config::disabled_groups: Vec<DisabledGroup>` no daemon, onde
`DisabledGroup { monitor: String, workspace: u32 }` — o `monitor` é o **nome estável do output**
([0056](0056-identidade-estavel-de-monitor-por-output-name-kde.md)). Struct nomeada (não tupla) para
serializar como **tabela TOML válida** (TOML não aceita array heterogêneo `["DP-1", 0]`).

Novo método D-Bus `SetDisabledGroups(s)` — **JSON string** (`[{"monitor":"DP-1","workspace":0}, ...]`),
pela mesma razão do `SetIgnoreListJson`/[0009](0009-ids-uint64-como-string-no-dbus.md) (o `callDBus` do
KWin não empacota estruturas compostas). A ponte:

- **hidrata** o set `disabled` na carga a partir de `GetConfig` (`hydrateDisabledGroups`); e
- **reescreve** via `SetDisabledGroups` a cada toggle **Meta+Y** (`persistDisabledGroups`).

Isso reenquadra "grupos desligados" como **preferência persistida** (como `gap`/`ignore_list`), **não**
estado transitório de layout — não fere o daemon-sem-estado-de-**janelas**
([0017](0017-daemon-sem-estado-de-janelas.md)).

### B) Rejeição do seletor dinâmico no KCM estático

**Não** se adiciona um seletor por-monitor-conectado ao painel: o `.ui` declarativo não expressa um modelo
vivo do conjunto de outputs/desktops. A ativação granular fica com **(a) o atalho Meta+Y** (agora
persistente) mais **o feedback visual já existente** (as janelas do grupo **flutuam** vs. **tilam**).
Descartado também o OSD via `org.freedesktop.Notifications.Notify` — sua assinatura (`susssasa{sv}i`) é
exatamente a marshaling de array/dict que o `callDBus` do KWin faz mal.

## Consequências

- **Comportamento:** desligar o tiling num monitor/workspace com Meta+Y **sobrevive ao reinício do KWin**
  e reancora no **monitor físico certo** ([0056](0056-identidade-estavel-de-monitor-por-output-name-kde.md)).
- **Reafirma 0016/0017:** a ponte segue burra; o daemon persiste **config**, não layout. A hidratação é
  best-effort (daemon fora do barramento → set vazio, comportamento anterior).
- **Contrato:** método aditivo `SetDisabledGroups`; campo aditivo `disabled_groups` (com `#[serde(default)]`,
  configs antigas carregam sem migração). `SyncWindows`/`compute_layout_with` inalterados — o
  `disabled_groups` do layout segue viajando no `state_json`, agora **semeado** pela config.
- **Escopo de UI:** ativação granular sem widget novo (Meta+Y + feedback flutua/tila). Seletor dinâmico
  por monitor fica **fora de escopo** por limite do KCM estático — reavaliar só se/quando houver uma
  superfície de config dinâmica (ex.: via helper de overlay [0039](0039-kde-abas-visuais-no-helper-de-overlay.md)).
- **Testes:** Rust cobre o round-trip TOML/JSON de `disabled_groups`; vitest cobre o espelho
  `parseConfig` (`disabled_groups`). O ciclo hidratar→toggle→persistir→reiniciar é validado em **sessão
  Plasma 6 real**.
- **Fora do escopo:** `platform-macos` (Swift); GNOME (mantém seu próprio toggle Super+Y — persistência
  equivalente pode ser portada depois).
