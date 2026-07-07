# 0061 — Blindagem multi-monitor, desagrupar por arraste e System Tray em hardware real (KDE)

**Status:** ✅ Aceita
(emenda [0056](0056-identidade-estavel-de-monitor-por-output-name-kde.md) — enumeração de outputs
completa via `workspace.screens`, incluindo monitores sem janelas; emenda
[0058](0058-blindagem-do-arraste-para-abas-em-hardware-real-kde.md) — unifica o desagrupar por arraste
num único `finishUngroup` com garantia de "nunca flutua"; emenda
[0059](0059-system-tray-applet-kde-via-kglobalaccel.md) — corrige a visibilidade do applet na bandeja;
depende de [0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md), que restaura o
`SyncWindows`; só ponte KDE — core/daemon/D-Bus inalterados)

## Contexto

Instalações limpas revelaram três falhas de ciclo de vida/UI no KDE, além da morte do `SyncWindows`
tratada no [0060](0060-consistencia-numerica-na-fronteira-snap-por-aresta-e-de-px.md):

1. **Isolamento multi-monitor incompleto.** `collectOutputs()` enumerava monitores **só a partir das
   janelas atuais** (`workspace.windowList()`). Um monitor **sem janelas** não existia para a ponte →
   `monitorAxisKeys`/`workspaceAxisKeys` e o alvo dos atalhos resolviam para o grupo errado, e o toggle
   por monitor "não fazia nada" na 2ª tela. O próprio [0059](0059-system-tray-applet-kde-via-kglobalaccel.md)
   admitia essa limitação herdada.
2. **Desagrupar por arraste ejetando para flutuante permanente.** Os dois gestos de desagrupar (aba do
   overlay e barra de título nativa) duplicavam a cascata de fallback `dropEjectedAt → ejectFromStack →
retile`, com um ramo que, sob condições de corrida (transporte ausente / alvo morto), deixava a
   janela flutuando em vez de reancorar.
3. **Applet ausente na System Tray.** O `metadata.json` declarava `X-Plasma-NotificationArea: true` mas
   **faltava `X-Plasma-NotificationAreaCategory`**, chave que o System Tray do Plasma 6 usa para listar
   a entrada — o applet não aparecia em "Config. da Bandeja do Sistema → Entradas" nem era encontrado
   pesquisando "Etherbit".

## Decisão

### A) Enumeração completa de outputs + alvo por monitor sob o cursor

`collectOutputs()` passa a **unir** as saídas descobertas por janelas (primeiro, preservando os índices
já em uso) com **todas** as saídas conectadas via `workspace.screens` (API real do KWin Plasma 6;
declarada defensivamente como opcional em `kwin-globals.d.ts`). Um monitor vazio ganha identidade
estável (`output.name`, ADR 0056) e entra no `monitorsFrom`/eixos de toggle. Quando não há janela ativa
viva, `activeMonitorName()`/`activeGroupKey()` miram o **monitor sob o cursor** (`monitorNameUnderCursor`),
não mais o primeiro conhecido — o atalho por monitor acerta a tela onde o usuário está.

### B) `finishUngroup`: uma única cascata, "nunca flutua"

Os dois gestos convergem num helper `finishUngroup(draggedStable, draggedT, x, y)` que garante o
reencaixe: (1) "cai onde foi solta" via `dropEjectedAt`; (2) senão, `ejectFromStack` (zona `eject`,
reancora no lugar, ADR 0045); (3) sem transporte conhecido, `retile` reencaixa pela distribuição
cíclica no próximo sync (viável agora que o `SyncWindows` não morre mais — ADR 0060). `dropEjectedAt`
ganha guarda **try/catch** ao ler a geometria do alvo: uma janela-alvo que morre entre o lookup e o uso
degrada para "sem alvo" (ramo global) em vez de abortar o handler e deixar a arrastada flutuando.

### C) `X-Plasma-NotificationAreaCategory` + `X-KDE-Keywords`

O `metadata.json` do plasmoid ganha `X-Plasma-NotificationAreaCategory: SystemServices` (o applet passa
a ser listado na bandeja) e `X-KDE-Keywords` (en + pt-BR) para a busca por "Etherbit"/"tiling" no
explorador de widgets. O `main.qml` já era um `PlasmoidItem` correto com `ActiveStatus` — nada de QML
muda.

## Consequências

- **Positivas:** tiling e atalhos permanecem ativos ao arrastar para o 2º monitor (inclusive
  recém-conectado/vazio); desagrupar/reordenar reancoram de forma determinística em hardware real; o
  ícone do Etherbit aparece e é pesquisável na System Tray.
- **DPI no drop:** a detecção de zona opera em coordenadas lógicas coerentes (cursor e `frameGeometry`
  no mesmo espaço) e o outline/preview já arredondava (`updateOutline`); a higiene de `roundPx` (ADR
  0060-C) fecha a mistura fracionária que chegava ao daemon.
- **Escopo:** estritamente ponte KDE (KWin Script + plasmoid); core/daemon/D-Bus/GNOME inalterados —
  sem código morto cruzado.
