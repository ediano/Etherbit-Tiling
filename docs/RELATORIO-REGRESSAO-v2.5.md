# Relatório de regressão — tiling GNOME/KDE (v2.2.0 → v2.5.0 → v2.5.1)

> Auditoria solicitada após relato de "falha total de tiling". **Conclusão principal:** a v2.5.1 (HEAD
> atual de `main`) **não é a versão quebrada — é o conserto.** A regressão viveu da v2.3.0 à **v2.5.0**;
> o commit `0b03e24` (branch `fix/kde6-gnome-regressao-ipc`, PR #25), liberado como **v2.5.1**,
> restaura a robustez e adiciona observabilidade. Baseline atual: **110 testes verdes** (core 64 +
> daemon 46).

## Linha do tempo (tags reais do repositório)

| Tag                  | Estado                | Marco                                                |
| -------------------- | --------------------- | ---------------------------------------------------- |
| `v2.1.0`, `v2.2.0`   | ✅ operacional        | pipeline do daemon enxuto; pouca superfície de falha |
| `v2.3.0` (`3f7db85`) | ⚠️ fragilidade cresce | tamanhos mínimos + auto-floating                     |
| `v2.4.0` (`5263bbc`) | ⚠️ fragilidade cresce | `Node::Stack` + estado de maximização                |
| `v2.5.0` (`a4c5910`) | ❌ **falha total**    | maior superfície de cálculo **sem rede de proteção** |
| `v2.5.1` (`0b03e24`) | ✅ **conserto**       | `de_index` + `guard`/`catch_unwind` + `obs.rs`       |

## O que quebrou (v2.2.0 → v2.5.0)

Entre v2.2.0 e v2.5.0, o `protocol.rs` do daemon cresceu **+411 linhas** (árvore BSP persistente +
`reconcile`, tamanhos mínimos/auto-floating, `Node::Stack`). A matemática nova é correta e bem testada,
mas o caminho IPC ganhou muito mais superfície de falha **sem nenhuma rede de proteção**:

1. **Índice negativo rejeitava o array inteiro de janelas.** `WindowDto.monitor`/`workspace` eram
   `u32` apenas com `#[serde(default)]` (em v2.2.0 **e** v2.5.0). Quando o Mutter/KWin reporta uma
   janela sem monitor (`get_monitor() == -1`), o `serde_json` falha ao desserializar `-1` em `u32` e
   **rejeita o array inteiro** — `SyncWindows` retorna erro e **nenhuma** janela é posicionada. À
   medida que as versões v2.3–v2.5.0 passaram a fotografar mais estados de janela (minimizadas,
   maximizadas, em transição), a chance de um `-1` no payload subiu — e qualquer ocorrência paralisava
   todo o relayout.

   ```rust
   // v2.5.0 — platform-linux-daemon/daemon/src/protocol.rs (SEM tolerância)
   #[serde(default)]
   pub monitor: u32,      // payload "monitor": -1  ⇒  erro de parse no ARRAY todo
   #[serde(default)]
   pub workspace: u32,
   ```

2. **Pânico silencioso no core derrubava a task D-Bus.** O `service.rs` chamava o core **sem**
   `catch_unwind`. Um `panic!`/índice fora de faixa em qualquer ramo novo (reconcile, stacks, mínimos)
   abortava a task `tokio` que atende o método D-Bus **sem log**: o cliente recebia `NoReply` e a ponte
   ficava inerte — "extensão carregada, nada se move, nenhuma pista nos logs".

O efeito combinado é exatamente o sintoma relatado: **a extensão/script carrega, mas nenhuma janela é
gerenciada, e não há erro visível.**

## O conserto (v2.5.1 — `0b03e24`)

Estritamente **robustez + observabilidade** — a matemática do BSP/gaps/mínimos **não** foi alterada:

1. **`de_index` — tolerância a índice degenerado** (`WindowDto.monitor/workspace` e `MonitorDto.index`):

   ```rust
   // v2.5.1 — desserializa índice de forma TOLERANTE: satura negativos a 0.
   fn de_index<'de, D>(deserializer: D) -> Result<u32, D::Error>
   where D: serde::Deserializer<'de> {
       let raw = i64::deserialize(deserializer)?;
       Ok(raw.max(0) as u32)   // "-1" vira 0 em vez de rejeitar o array inteiro
   }
   // ...
   #[serde(default, deserialize_with = "de_index")]
   pub monitor: u32,
   ```

2. **`guard`/`catch_unwind` no `service.rs`** — todo método D-Bus que chama o core é envolto: um pânico
   vira `fdo::Error` **logado** (`PÂNICO no core (recuperado pelo guard)`) e o daemon segue vivo para a
   próxima chamada, em vez de morrer em silêncio.

3. **`obs.rs`** — log estruturado do round-trip (`sync_windows: N recebida(s) → M tileável(is)`),
   tornando **visível** qualquer defeito residual.

Cobertura de regressão correspondente (passando hoje): `window_dto_negative_index_saturates_to_zero`,
`sync_tolerates_negative_monitor_in_array`, `sync_rejects_invalid_json`, `sync_tolerates_malformed_tree_blob`.

## Caso KDE ("nunca funcionou")

O script KWin usa API **Plasma 6** correta (`workspace.windowAdded`/`windowList`/`windowRemoved`,
`callDBus`) e o mesmo contrato D-Bus do GNOME. A causa mais provável de "nunca gerenciou janelas"
**não é o código do script**, e sim o **daemon fora do barramento** (instalação/ativação D-Bus
ausente): `callDBus` no sandbox do KWin **engole o erro em silêncio**, então sem o daemon de pé o
script fica estático. Diagnóstico decisivo: procurar `Ping OK` no log do KWin (ver abaixo). Só é bug de
código se `Ping OK` aparecer e ainda assim `SyncWindows` não retornar.

## Como validar e diagnosticar

- **Reproduzir o relatório (somente leitura):**
  - `git diff v2.2.0 v2.5.0 -- platform-linux-daemon/daemon/src/protocol.rs`
  - `git diff v2.5.0 v2.5.1 -- platform-linux-daemon/daemon/src`
- **Baseline (motor saudável):** `cargo test` (core) e
  `cargo test --manifest-path etherbit-tiling-daemon/Cargo.toml` (daemon).
- **Três logs ao vivo (daemon Rust / GNOME Shell / KWin):** procedimento completo em
  [DIAGNOSTICO-IPC.md](DIAGNOSTICO-IPC.md) (seção 0). Em resumo:
  - Daemon: `RUST_LOG=debug ~/.local/bin/etherbit-tiling-daemon` (ou `cargo run --manifest-path etherbit-tiling-daemon/Cargo.toml`)
  - GNOME: `journalctl --user -f -o cat /usr/bin/gnome-shell | grep -iE 'etherbit|JS ERROR|GDBus'`
  - KWin: `journalctl --user -f QT_CATEGORY=kwin_scripting | grep -i etherbit`

## Referências

- [ADR 0020 — resiliência de IPC D-Bus](../rules/0020-resiliencia-ipc-dbus.md)
- [ADR 0013 — camada KDE (KWin Script, Plasma 6)](../rules/0013-camada-kde-kwin-script.md)
- [ADR 0014 — daemon Linux compartilhado](../rules/0014-daemon-linux-compartilhado.md)
