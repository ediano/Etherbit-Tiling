# 0073 — Janelas transientes flutuam centralizadas sobre o pai, com proporção adequada

**Status:** ✅ Aceita
(emenda [0072](0072-recusa-com-evidencia-e-transientes-flutuam.md): o transiente deixa de sair do grid
"com a geometria que tinha". Core e contrato D-Bus inalterados.)

## Contexto

Com a [0072](0072-recusa-com-evidencia-e-transientes-flutuam.md) o seletor de pasta do VS Code deixou
de ser tilado, mas passou a flutuar com a geometria herdada: na metade de um ultrawide ficou com a
largura do slot do VS Code e ~1/4 da altura (`docs/logs/chrome-vscode-open-folder.png`). Diálogos do
portal nascem com o tamanho que o app escolheu, e quem ganha pai depois de tilado sai com o slot. O
mesmo acontece com qualquer diálogo com pai (salvar, propriedades…).

## Decisão

Na **1ª vez** que a ponte vê uma janela `transient` (e não maximizada) no snapshot, ela a coloca com a
função pura `transientPlacement` (espelhada nas duas pontes):

- **mantém o tamanho** se a proporção L/A estiver em [1,2; 1,9] e a altura for ≥ 50% da referência;
- senão, **redimensiona**: altura = 70% da referência, largura = min(60% da referência, 1,5 × altura);
  com pai estreito, a altura cai até L/A = 1,2. Respeita `min`/`max` do cliente e a área útil; janela
  não redimensionável só é movida;
- **centraliza sobre o pai** (sem pai: sobre a área útil do monitor), com clamp na área útil.

A referência é o frame do pai (`get_transient_for()` no GNOME, `transientFor` no KDE, lido com
checagem). Depois disso a ponte não toca mais na janela: o conjunto `placedTransients` é limpo no
`unmanaged`/`windowRemoved`. Diagnóstico: `[etherbit] transiente: id=… pai=… LxA -> LxA` (sem título).

## Não adotado

- **Exceção por classe (Nautilus/portal).** O problema é de qualquer diálogo com pai; a regra
  geométrica cobre todos.
- **Recolocar a cada relayout.** Brigaria com o usuário que move ou redimensiona o diálogo.

## Consequências

- Seletores e diálogos abrem sobre o app que os invocou, com proporção próxima de 3:2.
- Um diálogo propositalmente pequeno e de proporção "estranha" (ex.: confirmação baixa e larga, mas
  redimensionável) é aumentado; os de tamanho fixo não mudam.
- Um seletor sem pai (portal que não conseguiu parentar) segue `NORMAL` e tilável, como na 0072.
