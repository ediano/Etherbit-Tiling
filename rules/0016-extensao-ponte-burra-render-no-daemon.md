# 0016 — Extensão "ponte burra", layout no core e renderização no daemon

**Status:** ✅ Aceita

## Contexto
Sob **Wayland em VMs sem aceleração 3D** (GNOME Boxes / LLVMpipe) o ecossistema travava ou não
inicializava. A causa raiz era carga de renderização e lógica acoplada dentro do **GNOME Shell (JS)**:
qualquer desenho customizado (ex.: a "Borda Ativa") e animação no processo do compositor sob
rasterização por software congela a UI.

Surgiu também a tentação de mover a renderização da borda para o daemon Rust com `wgpu`. Porém, sob
Wayland, **um processo separado não desenha overlay ao redor das janelas de outros apps** — só o
compositor pode (o COSMIC contorna isso *sendo* o compositor; o Etherbit roda *sobre* GNOME/KWin). O
ADR [0002](0002-arquitetura-core-agnostico.md) já separa **decisão de layout** (core) de **aplicação**
(camadas nativas), mas faltava firmar onde mora a renderização e o quanto a camada nativa pode conter.

## Decisão
- **A extensão GNOME e o KWin Script são "pontes burras":** não desenham nada e não decidem layout.
  Atuam como ponte IPC de via dupla — coletam metadados brutos das janelas e áreas úteis, chamam
  `SyncWindows` no daemon e **aplicam** os retângulos-alvo devolvidos (`move_resize_frame` no GNOME,
  `frameGeometry` no KWin), de forma **instantânea e geométrica** (sem animação em JS).
- **A decisão de layout vive no core (`etherbit-tiling-core`):** `compute_layout` e `is_tileable`
  (filtro cirúrgico) são únicos e agnósticos, sem dependências nem GL. Elimina a duplicação que existia
  no `_shouldIgnore` (GNOME) e no `tileColumns`/`shouldTile` (KDE).
- **Contrato D-Bus `SyncWindows(windows_json, monitors_json) -> layout_json`** (request/response): serve
  GNOME e KDE igualmente. O KWin Script **não assina sinais**, então usa o RETORNO (modelo *pull*); o
  daemon permanece **sem estado de janelas** (a verdade vive no compositor).
- **A "Borda Ativa" é removida do produto.** Não é desenhável por um cliente Wayland; só pelo
  compositor. Os campos `active_border`/`border_color`/`border_width` e o método `SetActiveBorder`
  ficam no schema como **inertes/reservados** (evita churn no contrato espelhado), mas o controle some
  do indicador e nada os renderiza.
- **A renderização das janelas PRÓPRIAS do daemon usa `wgpu`** (ex.: futuro painel de configurações
  rápidas), atrás da feature `wgpu-ui` (desligada por padrão). O `wgpu` pede adapter de hardware e recai
  automática e transparentemente para software (`force_fallback_adapter` → lavapipe/LLVMpipe), garantindo
  que nunca congele por falta de GPU. **Não** se usa `wgpu` para overlay sobre janelas alheias.
- **Autostart blindado:** os instaladores injetam o UUID em `org.gnome.shell enabled-extensions`
  (via `gnome-extensions enable` ou `gsettings`) e garantem `disable-user-extensions=false`, para o
  Shell carregar a extensão automaticamente no próximo login Wayland — sem passo manual. O daemon
  mantém o serviço `systemd --user` + `.desktop`.

## Consequências
- **Resiliência estrutural:** como a extensão não renderiza e aplica geometria instantânea, o
  congelamento em LLVMpipe deixa de ocorrer — sem precisar detectar render por software no compositor.
  A flag/runtime de "degradação suave" no lado JS torna-se desnecessária.
- **Core agnóstico de fato:** `etherbit-tiling-core` deixa de ser stub e passa a conter o Ether Flow
  (hoje, layout em colunas como placeholder), testável isoladamente. Reafirma o ADR 0002.
- **Paridade GNOME/KDE:** o mesmo método `SyncWindows` e o módulo puro espelhado `bridge.ts` (como
  `config.ts` já é espelhado) cobrem as duas camadas. No KDE o `id` da janela é um handle opaco válido
  por chamada; no GNOME usa-se `get_stable_sequence()`.
- **Limitação registrada:** desenhar bordas/efeitos sobre janelas de terceiros exigiria o Etherbit ser
  o compositor (modelo COSMIC), fora do escopo de extensão/KWin Script.
- **wgpu opcional:** mantém o daemon leve e o CI sem GPU (feature desligada); habilita-se localmente com
  `cargo run --features wgpu-ui`.
