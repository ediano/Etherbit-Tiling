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
- **Bus name / interface:** `org.etherbit.Tiling`
- **Object path:** `/org/etherbit/Tiling`
- **UUID da extensão:** `tiling@etherbit.org` — idêntico no `metadata.json`, no diretório de
  instalação (`~/.local/share/gnome-shell/extensions/tiling@etherbit.org/`) e no
  `gnome-extensions enable`. O `.desktop` de autostart usa o mesmo nome.
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
- Nomes alinhados (`org.etherbit.Tiling` ↔ `tiling@etherbit.org`) facilitam rastrear o serviço.
