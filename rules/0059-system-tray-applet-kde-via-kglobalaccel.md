# 0059 — System Tray Applet do KDE (Plasma/Applet) para acesso rápido, via kglobalaccel

**Status:** ✅ Aceita
(emenda [0057](0057-persistencia-dos-grupos-desligados-e-rejeicao-do-seletor-dinamico.md) — a
"superfície de config dinâmica" cuja ausência justificou rejeitar o seletor dinâmico no KCM estático
**chegou**; reafirma [0016](0016-extensao-ponte-burra-render-no-daemon.md)/[0017](0017-daemon-sem-estado-de-janelas.md)
— a lógica KDE fica no KDE e o daemon segue agnóstico; reusa o canal de
[0039](0039-kde-abas-visuais-no-helper-de-overlay.md) — `invokeShortcut` via kglobalaccel; ícone e
identidade alinhados a [0056](0056-identidade-estavel-de-monitor-por-output-name-kde.md))

## Contexto

No GNOME, o indicador da barra superior (`indicator.ts`) dá acesso rápido ao tiling. No KDE, só
existiam o **KWin Script** (ponte) e o **KCM genérico de KWin Scripts** — para qualquer ajuste local
o usuário precisava mergulhar em _Configurações do Sistema → KWin Scripts_, uma fricção severa de UX.
O [0057](0057-persistencia-dos-grupos-desligados-e-rejeicao-do-seletor-dinamico.md) já previa esta
lacuna: rejeitou o seletor por-monitor no KCM estático "reavaliar só se/quando houver uma superfície
de config dinâmica". Este ADR entrega essa superfície: um **Plasma Applet** para a **System Tray**.

Duas tensões precisavam ser resolvidas sem ferir a arquitetura:

1. **Quem conhece o "monitor/workspace ativo"?** Só o KWin Script — via API de scripting do KWin
   (`workspace.activeWindow.output.name`, ADR 0056). Um Plasmoid roda no **plasmashell**, sem essa
   API; só alcança D-Bus/kglobalaccel. Replicar a identidade de monitor no QML duplicaria lógica e
   fugiria da fonte única.
2. **O daemon é agnóstico e não deve ganhar conceito de "monitor/workspace do KDE"** (0016/0017).

## Decisão

### A) Applet dispara ações NOMEADAS do KWin Script (lógica KDE no KDE)

O applet **não** computa identidade de monitor nem escreve `disabled_groups` direto no daemon. Ele
**invoca por nome**, via `org.kde.kglobalaccel /component/kwin invokeShortcut`, ações registradas
pelo KWin Script — exatamente o canal que o helper de preview já usa (ADR 0039). Novas ações **sem
tecla** (accel `''`), no KWin Script:

- `EtherbitToggleMonitor` — liga/desliga o tiling no **monitor ativo × todos os workspaces**;
- `EtherbitToggleWorkspace` — liga/desliga o tiling no **workspace atual × todos os monitores**;
- (reusa a chave-mestra existente `EtherbitToggleEnabled`, Meta+Shift+Y).

O toggle de **eixo** (helper puro `toggleAxisDisabled` em `bridge.ts`): se **todas** as chaves do
eixo já estão desligadas → religa todas; senão → desliga todas. Cada ação termina em
`persistDisabledGroups()` (ADR 0057) + `retile()` — reusando o caminho do Meta+Y. Assim a identidade
estável de monitor (0056) e a persistência (0057) permanecem **no KDE**; o daemon e o contrato D-Bus
ficam **inalterados** (nenhuma mudança em Rust).

### B) Applet QML puro, D-Bus via motor `executable`

O KPackage `Plasma/Applet` (`platform-linux-kde/plasmoid/`) é 100% QML/JS — sem C++, sem build step
(coerente com a ponte fina). O helper `EtherbitDBus.qml` usa o motor `executable` do Plasma5Support
para `qdbus6`/`kcmshell6`. Ele:

- **lê** o estado só para exibir, via `GetConfig` (`enabled`, contagem de `disabled_groups`);
- **dispara** as três ações via `invokeShortcut`;
- reconcilia o popup com o daemon após cada ação (Timer curto — não assina `ConfigChanged`, para
  manter o applet simples).

O ícone é `view-grid-symbolic` (tema nativo, SVG elástico), o mesmo do GNOME e do KWin Script.
`X-Plasma-NotificationArea: true` registra o applet na categoria _Status e Notificações_ da bandeja.

### C) "Abrir configurações" = KCM de KWin Scripts (best-effort)

Não há KCM próprio do Etherbit nem deep-link público para a engrenagem de um KWin Script específico
(limite herdado do 0057). O botão executa `kcmshell6 kcm_kwin_scripts` (fallback
`systemsettings kcm_kwin_scripts`): abre a **lista de KWin Scripts direto**, pulando o menu genérico
de Configurações de Janelas — mas sem auto-abrir a aba do Etherbit. Criar um KCM dedicado foi
descartado (escopo grande; contradiz a rejeição do seletor dinâmico no 0057).

## Consequências

- **UX:** ícone operacional na System Tray com popup leve (chave-mestra + toggles por monitor e por
  workspace + abrir config), pareando a experiência com o indicador do GNOME.
- **Arquitetura:** daemon e contrato D-Bus intocados; toda a lógica de ativação/identidade fica no
  KWin Script (KDE no KDE). Aditivo: duas ações keyless no KWin Script + um helper puro testável.
- **Limitações aceitas:** (a) os toggles de monitor/workspace são **ações** — o applet não reflete um
  checkmark vivo por-eixo (não conhece a identidade do monitor ativo); reflete só a chave-mestra e a
  contagem de grupos. (b) `collectOutputs()` enumera monitores a partir das janelas atuais — um
  monitor sem janelas fica de fora do eixo "workspace". (c) o botão de config não deep-linka a aba do
  Etherbit. (d) o instalador não força o applet no painel; com `X-Plasma-NotificationArea` ele fica
  elegível, o usuário garante a visibilidade em _Bandeja → Entradas_.
- **Contrato de atalhos:** `EtherbitToggleMonitor`/`EtherbitToggleWorkspace` são estáveis — o applet
  os invoca por nome; renomeá-los quebra o applet (como o `TAB_ACTION_SHORTCUT` do 0039).
- **Testes:** vitest cobre `toggleAxisDisabled` (regra do eixo). O ciclo real (ícone → popup →
  toggle → persistência → reconcile) é validado em **sessão Plasma 6 real** (como 0055–0058).
- **Empacotamento:** o applet entra no `etherbit-tiling-kde.tar.gz` (build/install/uninstall); QML
  puro, sem toolchain nova. Bundles antigos sem `plasmoid/` seguem instalando (bloco opcional).
- **Fora do escopo:** GNOME (já tem seu indicador); `platform-macos`; um KCM próprio do Etherbit.
