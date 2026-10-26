# 0070 — Paridade COSMIC no KDE: espelho da 0068 na ponte KWin, borda ativa no helper e atalhos

**Status:** ✅ Aceita
(espelha no KDE a [0068](0068-paridade-cosmic-no-gnome.md) e a adoção da
[0067](0067-auditoria-gnome-timeout-dbus-adocao-e-cantos-csd.md). Estende a
[0039](0039-kde-abas-visuais-no-helper-de-overlay.md): o helper `etherbit-tiling-preview` ganha um terceiro
papel, a borda da janela ativa. Mantém a [0056](0056-identidade-estavel-de-monitor-por-output-name-kde.md): o estado
segue chaveado pelo nome do output. Contrato do daemon inalterado: a ponte KDE só passa a usar campos e
métodos que já existiam.)

## Contexto

Depois da 0068, uma auditoria do KWin Script mostrou que o KDE não tinha nenhum dos comportamentos COSMIC
completos:

- **Recusa de tamanho:** o `frameGeometry` era aplicado sem ler o resultado de volta. Um terminal com
  incremento de caractere ficava encostado no canto do slot.
- **Inserção:** `focused_id` era a janela ativa no momento do sync, e no `windowAdded` essa já é a
  janela **nova**. A âncora do split ficava errada.
- **Atalhos:** não havia foco, move, swap ou resize por teclado, nem orientação, float ou ciclo de abas.
  Os padrões do KWin já ocupavam `Meta`+setas (Quick Tile), `Meta+Shift`+setas (mover para outra tela)
  e `Meta+Alt`+setas (Switch Window). Um `registerShortcut` que esbarra numa tecla ocupada fica sem
  tecla.
- **Borda ativa:** a config existia no kwinrc, mas nunca chegava ao daemon e nada a desenhava. Um KWin
  Script não pinta.
- **Config:** smart gaps, gap externo e modo de inserção não estavam no kwinrc. O título não ia no
  snapshot, então as regras `title:` não funcionavam.
- **Eventos:** não havia sinais de hotplug, de troca de desktop nem de mudança de geometria pelo cliente.
- **Respostas atrasadas** de `SyncWindows` sobrescreviam `trees` e aplicavam geometria velha.
- **Carga do script:** as janelas já maximizadas eram tratadas como "nascidas maximizadas" e
  desmaximizadas.

## Decisão

1. **Ponte KDE** (`bridge.ts`): porta as funções puras do GNOME com ids `string`:
   - recusa de tamanho: `sizeRefused`, `containedIn`, `centerInSlot`, `sameRect`;
   - direção: `neighborInDirection`, `directionZone`;
   - foco: `pushFocus`, `pickInsertAnchor`;
   - abas e float: `cycleStackActive`, `toggleFloating`, `swapInStacks`.

   `WindowSnapshot` ganha `title`, e `serializeState` ganha `floating`, com os ids traduzidos para
   transporte.

2. **Recusa de tamanho** (`main.ts`):
   - `lastApplied` guarda o slot já clampado de cada janela;
   - se o mesmo slot já foi pedido e o cliente ficou menor, a ponte centraliza em vez de reaplicar;
   - `frameGeometryChanged` recentraliza um resize feito pelo próprio cliente, fora de `applying`, do
     arrasto e do resize interativo.
3. **Inserção COSMIC:** o MRU de foco vem do `windowActivated`, e `focused_id` passa a ser
   `pickInsertAnchor`, ignorando janelas flutuantes.
4. **Sync atrasado:** uma resposta com `mySeq < syncSeq` é só confirmada e descartada.
5. **Atalhos** (`Etherbit*`, mesmas teclas do GNOME com `Meta`):
   - **Foco:** pela geometria das janelas visíveis do desktop atual.
   - **Move:** `MoveWindow` local. Sem vizinha no monitor, `workspace.sendClientToScreen` para o
     monitor adjacente, escolhido pela geometria das work-areas.
   - **Swap:** `MoveWindow` `center` local, que é o swap do core, mais `swapInStacks`.
   - **Resize:** `ResizeWindow` de 48 px; se a árvore não mudar, usa a borda oposta.
   - **Orientação:** `ToggleOrientation`.
   - **Float:** `state.floating`.
   - **Abas:** `cycleStackActive`.
6. **Atalhos nativos que colidem** (`install-kde.sh`):
   - via `gdbus` + `org.kde.KGlobalAccel.shortcutKeys`/`setForeignShortcutKeys`, faz backup das ações
     do KWin que colidem (`kde-shortcuts-backup` no estado do usuário, só na primeira instalação);
   - libera essas ações e aplica as teclas do Etherbit;
   - o `uninstall-kde.sh` restaura o backup;
   - opt-out: `ETHERBIT_KEEP_KDE_SHORTCUTS=1`.
7. **Borda ativa:**
   - o helper ganha `ShowBorder(x,y,w,h,thickness,color)`/`HideBorder()` na interface `Preview`;
   - a borda é uma `LayerSurface` na camada `Top`, click-through, com um anel opaco por fora do frame,
     buffer na escala do output e fixada ao output que contém a janela (como a 0063/0065);
   - o script envia a borda no `windowActivated`, depois do apply, no `frameGeometryChanged` da ativa e
     no fim do arrasto, com dedup;
   - ela some com o tiling ou a config desligados, em janela maximizada, fullscreen ou minimizada, e
     durante o arrasto.
8. **Config** (kwinrc e KCM):
   - `outerGap` (-1 = segue o gap), `smartGaps` e `focusInsert`;
   - `pushConfigToDaemon` passa a enviar `SetActiveBorder`, `SetSmartGaps`, `SetInsertMode` e
     `SetOuterGap`;
   - traduções pt-BR no `pt_BR.po`.
9. **Eventos:**
   - `workspace.screensChanged`, `desktopsChanged` e `currentDesktopChanged` disparam retile;
   - `outputChanged`/`desktopsChanged` de cada janela também disparam retile;
   - `captionChanged` re-tila só quando há regras `title:`.

   Todas as conexões são defensivas, porque os sinais são opcionais.

10. **Adoção:** as janelas já abertas na carga do script entram em `everTiled`, preservando
    maximizações feitas antes.

## Limitações

- **Empilhamento da borda.** Um cliente layer-shell não se intercala no empilhamento do KWin, então a
  borda fica acima de janelas que se sobreponham à ativa, por exemplo uma flutuante por cima. Só um efeito
  C++ do KWin resolveria, e isso foge da arquitetura de ponte burra. Fica registrado.
- **Validação manual pendente.** O ajuste de atalhos via `gdbus`, o `sendClientToScreen` e o
  `frameGeometryChanged` dependem de uma sessão Plasma 6 real e não são cobertos pelo CI.

## Consequências

- O KDE passa a ter o mesmo comportamento e os mesmos atalhos que o GNOME.
- O CI cobre:
  - as funções puras, nos testes do kwin-script;
  - o anel da borda e o parse de cor, nos testes do helper.

## Emenda (2026-10-26) — grab do usuário invalida a recusa

A heurística de recusa compara o frame atual com o último slot committado. Depois de um resize ou
arraste manual, o frame menor é ação do usuário, não recusa do cliente — e, se o slot seguinte for
o mesmo, a janela só era centralizada e nunca voltava a preencher o slot. Ao fim de todo grab
(`grab-op-end` no GNOME, `interactiveMoveResizeFinished` no KDE) a ponte esquece o slot committado
da janela agarrada (no GNOME também invalida o dedup). A recusa volta a ser detectada se o cliente
recusar um pedido novo.
