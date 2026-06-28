# 0017 — Migração para domínio próprio (`ediano.dev`)

**Status:** ✅ Aceita

## Contexto
Os identificadores baseados em domínio usavam `etherbit.org` (forward) e `org.etherbit` (reverso
D-Bus) — um domínio que **não pertence ao autor**. Com domínio próprio disponível (`ediano.dev`),
migramos para ele: mais profissional, estável e sob controle do autor. O ADR
[0009](0009-nomenclatura-dbus-uuid.md) fixou a *forma* desses nomes (DNS reverso, UUID alinhado,
contrato JSON); aqui mudam apenas os **valores** do domínio.

Regra técnica: identificadores D-Bus usam **DNS reverso**. O reverso de `ediano.dev` é `dev.ediano`
(portanto `ediano.dev.etherbit` não é reverso válido e foi descartado).

## Decisão
- **Bus name / interface:** `org.etherbit.Tiling` → **`dev.ediano.etherbit.Tiling`**
- **Object path:** `/org/etherbit/Tiling` → **`/dev/ediano/etherbit/Tiling`**
- **UUID da extensão GNOME:** `tiling@etherbit.org` → **`etherbit.tiling@ediano.dev`** (apex `ediano.dev`,
  shortname `etherbit.tiling`). O diretório de instalação e o `.desktop` de autostart usam o mesmo nome.
- **`ProjectDirs`** do daemon: `("org", "etherbit", "tiling")` → **`("dev", "ediano", "tiling")`**. No
  Linux o caminho usa **só** o `application` (`"tiling"`), então a config continua em
  `~/.config/tiling/` — **sem quebra**; a mudança só afeta o bundle id macOS/Windows.
- **Permanecem inalterados** (são marca, não domínio — ver ADR [0008](0008-nome-etherbit.md)): crates
  `etherbit-tiling-*`, KPackage Id `etherbit-tiling`, serviço `etherbit-tiling-daemon.service`, e as URLs
  do site (`etherbit-tiling.vercel.app`, até o DNS apontar para o domínio próprio).

## Consequências
- **Breaking para instalações existentes** (aceitável pré-1.0): a extensão passa a ter novo UUID (novo
  diretório, precisa reabilitar) e o daemon publica novo nome D-Bus. Quem tinha a versão antiga fica com
  o `.desktop` antigo (`tiling@etherbit.org.desktop`) órfão; não há migração automática. O `version` do
  `metadata.json` subiu para `3` para sinalizar a nova identidade.
- O ADR 0009 teve seus valores atualizados in loco, apontando para este ADR; a *forma* decidida lá
  continua válida.
- Coerência D-Bus reverificada nos três pontos: `#[interface]`/`BUS_NAME`/`OBJECT_PATH` do daemon, o
  `IFACE_XML` da extensão e as constantes do KWin script.
