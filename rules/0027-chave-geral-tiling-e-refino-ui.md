# 0027 — Chave geral de ativação do tiling, raio como fonte de verdade do arredondamento e remoção do toggle de autostart

**Status:** ✅ Aceita (estende [0016](0016-extensao-ponte-burra-render-no-daemon.md),
[0024](0024-instaladores-upgrade-idempotente-autostart.md) e
[0025](0025-barra-abas-clicavel-kde-entrega-por-pull.md); refina a UI de
[0019](0019-arvore-bsp-persistente-resize-elastico.md))

## Contexto

Três frentes apareceram juntas e se resolvem no mesmo contrato:

1. **UI do indicador GNOME.** Os inputs de Gap/Raio tinham número e símbolos `−`/`+` mal centralizados e
   herdavam do tema um arredondamento de "pílula" (o `St.Entry` sem `border-radius` explícito). Havia
   ainda um **toggle "Cantos arredondados"** redundante: o próprio valor do raio já expressa ligado
   (`> 0`) ou desligado (`0`).
2. **Faltava um liga/desliga GERAL do tiling.** Só existia o toggle **por workspace** (Meta+Y, estado
   `disabled_groups` na ponte). Não havia um "On/Off" global que pausasse o motor e devolvesse as
   janelas ao comportamento flutuante mantendo o daemon vivo.
3. **Bug de foco no KDE.** Clicar numa guia da barra (overlay wgpu do daemon, [0025](0025-barra-abas-clicavel-kde-entrega-por-pull.md))
   marcava a aba ativa (`setActiveMember`) mas **não trocava o foco nem o empilhamento** da janela — o
   usuário precisava fechar uma janela para interagir com a outra.

E o **toggle "Iniciar com o sistema"** se mostrou redundante: o daemon já sobe sozinho via serviço
`systemd --user` + ativação D-Bus ([0024](0024-instaladores-upgrade-idempotente-autostart.md),
[0020](0020-resiliencia-ipc-dbus.md)).

## Decisão

- **Chave geral `enabled` no daemon (fonte de verdade persistida).** Novo campo `enabled: bool`
  (default `true`) em `Config` ([config.rs](../etherbit-tiling-daemon/daemon/src/config.rs)) e método
  D-Bus `SetEnabled(bool)` ([service.rs](../etherbit-tiling-daemon/daemon/src/service.rs)), no mesmo
  molde de `SetGap`/`SetAutostart` (muta, persiste, emite `ConfigChanged`). Retrocompatível pelo
  `#[serde(default)]` do contêiner — daemons/pontes antigos ignoram o campo. Espelhado nas duas
  `TilingConfig`/`DEFAULT_CONFIG` ([GNOME](../platform-linux-gnome/extension/src/config.ts),
  [KDE](../platform-linux-kde/kwin-script/contents/code/config.ts)) e no XML do proxy GNOME.
- **Pausa = a PONTE para de enviar snapshots e LIBERA as janelas; o daemon segue vivo.** Reafirma o
  "daemon sem estado" ([0016](0016-extensao-ponte-burra-render-no-daemon.md)): desligar não derruba o
  processo, só faz a ponte (a) **não chamar `SyncWindows`** e (b) desfazer **o que ela impôs** —
  desminimizar abas, baixar `keepAbove` das auto-flutuantes e (no GNOME) limpar cantos/barras de aba.
  O **estado leve** (ordem/stacks/árvores) é **preservado**, então religar (`enabled = true`)
  reorganiza tudo de volta no grid. No GNOME o gate vive em `_relayout` (`_releaseToFloating`); no KDE
  em `retile` (`releaseToFloating`).
- **Superfícies de controle (assimetria aceita, família [0016](0016-extensao-ponte-burra-render-no-daemon.md)/[0020](0020-resiliencia-ipc-dbus.md)):**
  - **GNOME:** switch mestre **"Ativar tiling"** no topo do indicador → `SetEnabled`. A extensão reage
    ao `ConfigChanged` (relê `enabled` e pausa/retoma).
  - **KDE:** **atalho global `Meta+Shift+Y`** (controle em **tempo real**) que alterna uma flag de
    runtime e chama `SetEnabled`, **mais** um checkbox `enabled` no KCM (default persistido em kwinrc).
    **Limitação registrada:** o atalho **não reescreve** o kwinrc (um KWin _Script_ não escreve
    KConfig de forma confiável), então o estado de runtime volta ao default do KCM se o script
    recarregar. Sem barra/applet novo — manter o KWin _Script_ "ponte burra".
- **Raio dos cantos é a ÚNICA fonte de verdade do arredondamento (refina [0019](0019-arvore-bsp-persistente-resize-elastico.md)).**
  `0` desliga; `> 0` liga. O **toggle "Cantos arredondados" some do GNOME**; a extensão aplica/limpa o
  efeito por `corner_radius > 0`. O campo `rounded_corners` **permanece no contrato** como espelho de
  `corner_radius > 0` (sem churn). O **KDE mantém** seu checkbox `roundedCorners` — ali o arredondamento
  depende do **efeito nativo** do KWin (um _Script_ não instancia shaders), então o controle nativo
  segue fazendo sentido.
- **Toggle de autostart REMOVIDO da UI (GNOME e KDE).** A infra do daemon
  ([autostart.rs](../etherbit-tiling-daemon/daemon/src/autostart.rs) + `SetAutostart`) fica
  **inerte/reservada** (como `active_border` em [0016](0016-extensao-ponte-burra-render-no-daemon.md)):
  evita churn no contrato espelhado e **não** mexe nos instaladores de
  [0024](0024-instaladores-upgrade-idempotente-autostart.md), que continuam armando o autostart por
  systemd/ativação D-Bus. O KDE **deixa de empurrar** `SetAutostart` no load (não gerencia mais o
  `.desktop`).
- **Estética GNOME:** número centralizado (`text-align: center` + `y_align`) e símbolos `−`/`+`
  centralizados (St.Bin já centraliza o filho — **não** se passa `x_align`/`y_align` ao `St.Button`,
  cujo enum `St.Align` colidiria com `Clutter.ActorAlign`); `border-radius` **travado em ≤ 8px** no
  input e nos botões (mata a "pílula", mantém canto suave).
- **Correção do foco no KDE.** No apply das `pending_actions`, o ramo `activate` passa a, além de
  `setActiveMember`, **desminimizar** a janela-alvo e **atribuir `workspace.activeWindow`** (read-write
  na API de scripting do KWin: ativar = **levantar ao topo + focar**). A aba antes ativa vira membro
  inativo e é **minimizada pelo `retile` seguinte**. O tipo `activeWindow` em `kwin-globals.d.ts` passa
  de `readonly` para read-write (refletindo a API real).

## Consequências

- **Contrato espelhado em pontos novos, todos retrocompatíveis:** `enabled` em `config.rs` + nos dois
  `config.ts` + no XML do proxy GNOME; `SetEnabled` em `service.rs`, `dbus.ts` e no `pushConfigToDaemon`
  do KDE. Por `#[serde(default)]`/parse defensivo, daemon e pontes antigos ignoram os campos.
- **Boot inalterado:** só a **UI** de autostart saiu; o serviço/ativação D-Bus que faz o Etherbit subir
  sozinho continua (0024/0020). Sem regressão de "iniciar com o sistema".
- **Cobertura:** round-trips de config (Rust + vitest) cobrem o campo novo; `typecheck`/`build`
  (GNOME/KDE) cobrem os contratos TS. A troca de foco/empilhamento ao clicar na aba e o liga/desliga
  em tempo real são **validados em sessão KWin/GNOME real** (hardware), como o resto da camada nativa.
- **Reafirma 0002/0016:** core puro, daemon sem estado (a pausa vive na ponte), pontes "burras". O 0025
  (barra clicável) ganha o efeito que faltava: o clique agora **realmente** troca a janela ativa.
