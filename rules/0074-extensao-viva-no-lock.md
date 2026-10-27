# 0074 — Extensão GNOME segue viva na tela de bloqueio (estado do grid preservado)

**Status:** ✅ Aceita
(estende [0067](0067-auditoria-gnome-timeout-dbus-adocao-e-cantos-csd.md) e [0071](0071-update-sem-logout-hot-reload.md);
só ponte GNOME — core, daemon e contrato D-Bus inalterados.)

## Contexto

Depois de organizar as janelas e bloquear a tela, ao desbloquear o grid voltava embaralhado: a janela da
direita ia para a esquerda, outras iam para o quadrante de baixo.

Sem `session-modes` no `metadata.json`, o GNOME Shell **desativa todas as extensões ao entrar na tela de
bloqueio** e as reativa ao desbloquear. O `disable()` descarta a ordem estável (`_order`), as árvores
(`_trees`), as abas, os flutuantes e os grupos desligados, e o loader (#0071) descarta a instância. No
`enable()` as janelas são readotadas e a ordem é reconstruída pela ordem de `list_windows()`. Como o BSP
do core depende dessa ordem e as árvores se perderam, o layout muda.

## Decisão

- O `metadata.json` declara `"session-modes": ["user", "unlock-dialog"]`. O Shell deixa de chamar
  `disable()`/`enable()` no bloqueio, e todo o estado da ponte é preservado.
- Enquanto `Main.sessionMode.isLocked`, a extensão fica **pausada**: `_scheduleRelayout`/`_relayout` não
  agem (só marcam `_relayoutPending`) e o indicador do painel fica oculto. Assim um `monitors-changed`
  (tela apagando) não mexe no grid atrás do bloqueio.
- Ao desbloquear, ela reexibe o indicador e dispara **um** relayout com o estado intacto.
- Os atalhos já usam `Shell.ActionMode.NORMAL` e não disparam na tela de bloqueio.

## Consequências

- O layout sobrevive ao bloqueio/desbloqueio e à suspensão com bloqueio.
- A revisão do extensions.gnome.org exige justificativa para o `unlock-dialog`. Ela fica documentada
  no comentário do `disable()` e neste ADR.
- O KDE não muda: o script do KWin não é descarregado no bloqueio.
