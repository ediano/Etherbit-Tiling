# 0009 — Nomenclatura D-Bus, UUID da extensão e contrato JSON

**Status:** ✅ Aceita

## Contexto

A vertente Linux/GNOME tem duas partes que conversam: o daemon Rust (`etherbit-tiling-daemon`) e a
extensão GNOME Shell (`etherbit-tiling-extension`). Essa conversa é feita por **D-Bus** no barramento
de sessão. Precisávamos fixar nomes estáveis (bus name, object path, interface), o **UUID** da
extensão e o formato do payload de configuração, para que daemon e extensão fiquem acoplados pelo
contrato e não por convenção implícita.

## Decisão

- **Barramento:** sessão (`session bus`). O daemon roda na sessão do usuário; nada de system bus.
- **Bus name / interface:** `dev.ediano.etherbit.Tiling`
- **Object path:** `/dev/ediano/etherbit/Tiling`
- **UUID da extensão:** `etherbit.tiling@ediano.dev` — idêntico no `metadata.json`, no diretório de
  instalação (`~/.local/share/gnome-shell/extensions/etherbit.tiling@ediano.dev/`) e no
  `gnome-extensions enable`. O `.desktop` de autostart usa o mesmo nome.
  > Migrado de `org.etherbit.*` / `tiling@etherbit.org` para o domínio próprio `ediano.dev` —
  > ver ADR [0017](0017-dominio-proprio-ediano-dev.md). A decisão de _forma_ (DNS reverso, nomes
  > alinhados, contrato JSON) permanece; só mudaram os valores do domínio.
- **Contrato da configuração via JSON string:** `GetConfig` retorna `s` (JSON) e o sinal
  `ConfigChanged(s)` carrega o mesmo JSON. O schema evolui só no daemon (serde); a extensão faz
  `JSON.parse`. Métodos de escrita usam tipos D-Bus simples (`SetGaps(uu)`,
  `SetActiveBorder(bsu)`, `SetIgnoreList(as)`, `SetAutostart(b)`).
- **Motor = extensão habilitada:** o indicador da barra só existe enquanto a extensão está
  habilitada (regra herdada do macOS); ligar/desligar o motor é ligar/desligar a extensão.

## Consequências

- O XML de introspecção da interface é a **fonte de verdade compartilhada**: vive no
  `#[interface]` do daemon e replicado no `makeProxyWrapper` da extensão. Mudou um lado, muda o outro.
- JSON string reduz boilerplate de `GVariant` e permite evoluir o schema sem renegociar o XML; em
  troca, abre mão de introspecção tipada por campo.
- Nomes alinhados (`dev.ediano.etherbit.Tiling` ↔ `etherbit.tiling@ediano.dev`) facilitam rastrear o serviço.

## Emenda (2026-06) — IDs de janela como string (`s`), não `uint64`

Com o segundo frontend (KWin/KDE) consumindo o mesmo contrato, surgiu uma incompatibilidade: o
`callDBus` do KWin (QJSEngine, Plasma 6) **não empacota `uint64` (`t`)** — infere o tipo do valor JS
e um inteiro pequeno vira sempre `int32` (`i`), fazendo o daemon rejeitar a assinatura
(`got (siis), expected (stts)` / `got (ssisi), expected (sstsi)`). O GNOME não tinha o problema
porque o Gjs empacota pelo XML de introspecção, caminho que o KWin não oferece.

**Decisão:** os args primitivos de ID de janela de `MoveWindow` (`dragged_id`, `target_id`) e
`ResizeWindow` (`id`) passam de `t`/`u64` para **string decimal (`s`)**; o daemon faz
`parse::<u64>()` (tolerante: IDs reais são ≥ 1, `0` vira no-op). Os **payloads JSON** (`state_json`,
`windows_json`) seguem com IDs numéricos — só os 3 args primitivos mudam. Isso mantém os dois
frontends num **único contrato** sem hack de tipo no KWin. O sinal `TabAction` (`tts`) não muda
(nenhum frontend o envia).
