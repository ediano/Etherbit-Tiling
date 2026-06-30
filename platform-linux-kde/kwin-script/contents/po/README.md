# Traduções do KWin Script (gettext)

A UI de configuração do KWin Script (`contents/ui/config.ui` e os `label` de
`contents/config/main.xml`) é renderizada por um KCM do **próprio KDE**
(`kcm_kwin4_genericscripted`) — não temos acesso ao runtime dela pelo nosso TS.
A única forma de traduzir essas strings é pelo mecanismo **gettext** do KDE
(ADR [0032](../../../../rules/0032-i18n-multilingue.md)).

## Como funciona

- As **strings-fonte** ficam em **inglês** no XML (são os `msgid`). Inglês é o
  default global: qualquer locale sem catálogo cai automaticamente nelas.
- A tradução **pt-BR** vive em `pt_BR.po`, compilada para
  `../locale/pt_BR/LC_MESSAGES/etherbit-tiling.mo`.
- O **domínio** do catálogo é `etherbit-tiling` (= `KPlugin.Id` em
  `metadata.json`). O KPackage do KWin Script expõe `contents/locale/` no caminho
  de busca do gettext para esse domínio, então o KCM aplica o pt-BR quando o
  locale do sistema for `pt_BR`.

> Nota de validação: a captação automática do catálogo pelo KCM de scripts
> instalados pelo usuário (`~/.local/share/kwin/scripts/…`) deve ser confirmada
> numa sessão Plasma 6 real (`LANG=pt_BR` → UI em pt-BR; outro locale → inglês).

## Fluxo de manutenção

1. Mudou uma string no XML? Atualize o `msgid` correspondente em `pt_BR.po`
   (e em `etherbit-tiling.pot`).
2. Recompile o `.mo`:
   ```bash
   msgfmt contents/po/pt_BR.po -o contents/locale/pt_BR/LC_MESSAGES/etherbit-tiling.mo
   ```
   Os scripts `packaging/build-kde-release.sh` e
   `platform-linux-kde/kwin-script/scripts/install.sh` já fazem isso
   automaticamente quando `msgfmt` está disponível.
