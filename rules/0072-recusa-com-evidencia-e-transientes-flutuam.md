# 0072 — Recusa de tamanho só com evidência (1º quadro + sonda) e janelas transientes flutuam

**Status:** ✅ Aceita
(emenda [0068](0068-paridade-cosmic-no-gnome.md) e [0070](0070-paridade-cosmic-no-kde.md): a recusa de
tamanho passa a exigir confirmação; emenda [0043](0043-trava-de-spawn-por-janela-de-graca.md): a graça
de spawn conta a partir do 1º quadro; emenda [0067](0067-auditoria-gnome-timeout-dbus-adocao-e-cantos-csd.md):
as janelas adotadas também ganham o `first-frame`. Reafirma [0038](0038-realizacao-gated-dedup-e-boot-settle.md).
Contrato D-Bus **estendido de forma retrocompatível**: só o campo `transient`, com `serde(default)`.)

## Contexto

Dois sintomas em hardware real, no GNOME e no KDE:

1. **Depois de reiniciar, a 1ª janela não encaixa.** O tiling aparece ativo, mas a janela fica no
   tamanho natural, centralizada. Ao abrir a 2ª, o grid "acorda", com comportamentos estranhos.
2. **O seletor de pasta do VS Code é tilado.** Ele abre reduzido, com proporções que mudam a cada vez
   (1:1, 4:7…).

### Causa 1 — a heurística de recusa lia como recusa um frame que não respondia ao nosso pedido

A [0068](0068-paridade-cosmic-no-gnome.md) passou a tratar a janela **menor e contida** no slot como
"convergida" (terminal com _size increments_, tamanho máximo). Ela assumiu que um apply descartado no
boot deixaria a janela **fora** do slot. Para a 1ª janela de um monitor isso é falso:

- no boot frio o relayout de spawn (80 ms) roda antes de o app desenhar o 1º quadro, e o Mutter
  descarta o `move_resize_frame` (fato já registrado na [0038](0038-realizacao-gated-dedup-e-boot-settle.md));
- o Mutter então posiciona a janela no tamanho natural, centralizada na área útil;
- o slot da 1ª janela é a área útil inteira, então o frame natural fica sempre "menor e contido";
- o dedup só centralizava e o apply só fazia `move_frame`. A janela nunca era redimensionada enquanto o
  slot não mudasse. A 2ª janela mudava o slot, por isso o grid "acordava";
- a janela mais nova sofria o mesmo: o apply nem checava se ela estava contida no slot.

Agravantes no GNOME:

- a graça de spawn-unmaximize ([0043](0043-trava-de-spawn-por-janela-de-graca.md), 1,5 s) contava do
  `window-created`; no boot frio o 1º quadro chega depois, e um app que restaura "maximizado" era tratado
  como maximização manual;
- o `import()` assíncrono do loader ([0071](0071-update-sem-logout-hot-reload.md)) pode adotar janelas que
  ainda não desenharam. As adotadas não tinham `first-frame` ([0067](0067-auditoria-gnome-timeout-dbus-adocao-e-cantos-csd.md)).

No KDE o `windowAdded` só chega com a janela mapeada, mas o `frameGeometryChanged`
([0070](0070-paridade-cosmic-no-kde.md)) centralizava qualquer mudança de frame do cliente que ficasse
menor e contida — inclusive o app restaurando o próprio tamanho logo depois do apply. Centralizar
re-pedia o tamanho **menor** e substituía o pedido do slot, e os retiles seguintes caíam na recusa.

### Causa 2 — diálogo com pai e não modal entrava no grid

O `is_tileable` só filtrava `ignore_list`, `resizable`/`maximizable` e `normal`. No Wayland, um diálogo
com pai mas **sem modal** continua `NORMAL` no Mutter e `normalWindow` no KWin — caso do seletor GTK do
Electron, parentado via xdg-foreign. Ele era tilado, e a inserção pela focada rachava o slot do VS Code.
O COSMIC (`is_dialog`: toplevel com `parent()`) e o pop-shell (`is_transient()`) deixam essas janelas
flutuarem.

## Decisão

1. **GNOME — recusa só vale para pedidos feitos depois do 1º quadro.**
   - O `first-frame` do ator é conectado em toda janela rastreada, **inclusive as adotadas**. O sinal é
     de disparo único por ator: numa janela que já renderizou nunca dispara, então o hot-reload não muda.
   - Sem ator no `window-created`, o `shown` do `Meta.Window` faz o papel (com feature detection,
     [0023](0023-compat-api-mutter-feature-detection.md)).
   - No 1º quadro (`_onRealized`): esquece o slot committado e a sonda da janela, invalida o dedup (o
     mesmo padrão do fim de grab), reinicia a graça de spawn, roda o spawn-unmaximize e agenda o relayout.
   - `notify::window-type` re-tila: um diálogo que vira modal depois sai do grid na hora.
2. **Recusa confirmada por sonda (GNOME e KDE).** Recusa passa a ser "o mesmo slot foi re-pedido e o
   cliente continuou menor". A função pura `refusalAction(want, prev, cur, probe, epsilon)`, nas duas
   pontes, decide entre:
   - `resize`: 1º pedido, slot novo ou cliente não está menor;
   - `probe`: o mesmo slot já foi pedido e o cliente ficou menor — reaplica o slot **uma** vez e
     registra a sonda;
   - `center`: o slot já foi sondado e o cliente segue menor — só centraliza.

   No GNOME:
   - `geometryConverged` ganha o parâmetro `probes`: a cláusula de recusa só vale com sonda do mesmo
     slot (estrita por padrão);
   - `_centerRefusedWindows` só centraliza recusas confirmadas e esquece a sonda de quem aceitou o slot;
   - depois de uma sonda, um relayout de acompanhamento lê o resultado (um cliente que recusa de novo não
     emite `size-changed`).

   No KDE, o `frameGeometryChanged` faz a sonda antes de centralizar. Sem timer no sandbox, o próximo
   `frameGeometryChanged` lê o resultado.

3. **Janelas transientes flutuam.**
   - `transient: bool` em `WindowInfo` (core) e `WindowDto` (daemon, `serde(default)`);
   - `is_tileable` ganha a regra 4: janela com pai não entra no grid; o motivo no `dropped` é `transient`;
   - GNOME envia `window.get_transient_for() !== null`; KDE envia `win.transient`.
4. **Diagnóstico** (sem título de janela: o repositório é público e os logs vão para `docs/logs/`):
   - GNOME: `[etherbit] enable: adotadas=N`; uma linha `[etherbit] janela: …` por janela normal ou
     diálogo no 1º quadro (`via`, `Δ` desde o nascimento, `adotada`, `classe`, `wtype`, `transiente`,
     `cliente`, `frame`); `[etherbit] recusa: sonda=[…] confirmada=[…]` quando houver; `drop-detail`
     ganha `transient=`.
   - KDE: `[etherbit] janela: …` no `windowAdded` (`classe`, `normal`, `dialog`, `transiente`, `modal`,
     `frame`) e `recusa: sonda <id>`; a confirmação vai para o `debug` (sem dedup no KDE, todo retile
     passaria por ela).

## Não adotado

- **Barrar a janela do snapshot até o 1º quadro.** Resolveria o boot, mas não o app que se redimensiona
  depois do apply, e atrasaria a inserção de toda janela nova.
- **`Meta.Window::configure` / `WindowConfig`** (Mutter 48+): a API certa para nascer já no slot, no
  configure inicial. Não existe do GNOME 45 ao 47 e exigiria D-Bus síncrono dentro de um sinal do
  compositor. Fica para quando o piso de versão subir.
- **Exceção por título para o seletor.** O título vem do app que pediu o diálogo e é traduzido.

## Consequências

- A 1ª janela pós-boot, e toda janela cujo apply foi descartado, volta a preencher o slot.
- Um terminal com _size increments_ recebe um pedido a mais antes de centralizar
  (`resize → sonda → centraliza`), cerca de 130 ms depois. Não há flicker contínuo.
- Uma maximização manual até 1,5 s depois do 1º quadro é desfeita — o mesmo trade-off da
  [0043](0043-trava-de-spawn-por-janela-de-graca.md), agora contado do 1º quadro.
- Janelas com pai não podem ser forçadas ao grid. Uma janela que ganha pai depois de tilada sai do grid
  com a geometria do slot.
- Um seletor sem pai (portal que não conseguiu parentar) continua `NORMAL` e tilável. O log
  `transiente=-` identifica o caso; a saída é uma regra de exceção por classe numa ADR de acompanhamento.
- Ponte nova com daemon antigo: o campo é ignorado e o diálogo segue tilado até o daemon ser atualizado.
