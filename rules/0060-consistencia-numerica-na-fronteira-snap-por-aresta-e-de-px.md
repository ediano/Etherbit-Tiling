# 0060 — Consistência numérica na fronteira: snap por aresta no core + `de_px` tolerante no daemon

**Status:** ✅ Aceita
(emenda [0031](0031-cascata-sempre-spawn-unmaximize-e-preview-translucido.md)/[0040](0040-esmagamento-impositivo-e-menu-de-contexto-kde.md)
— o arredondamento final do core passa a ser por ARESTA, preservando a intenção do `Rectf` de "só
arredondar nas folhas"; reafirma [0002](0002-arquitetura-core-agnostico.md)/[0016](0016-extensao-ponte-burra-render-no-daemon.md)
— as duas correções são AGNÓSTICAS, na base compartilhada, sem regra cruzada de ambiente; mesma classe
de blindagem do `de_index` do daemon)

## Contexto

Sessões limpas em hardware real (Wayland) expuseram duas anomalias de **precisão numérica** na
fronteira Core (Rust) ↔ ambientes, provadas pelos logs em `docs/logs/`:

1. **GNOME — invasão de eixo / gaps assimétricos (alta densidade).** A ponte GNOME é burra e envia
   coordenadas **inteiras**; todo o arredondamento vive no core. O core computa a geometria em `f64`
   (`track_bounds`/`solve_tracks`/`cell_rect`) e, em cada folha, arredondava `x`, `y`, `w`, `h`
   **independentemente**. Como `round(x) + round(w) ≠ round(x + w)` em geral, dois ladrilhos vizinhos
   derivavam sua fronteira compartilhada de expressões diferentes → em subdivisões densas (frações não
   inteiras, até 16 janelas) a costura entre eles divergia ±1px, produzindo **overlap** (uma janela
   "invadindo" o vizinho, tratando a lateral como bloco unificado) ou **gap irregular** (linhas não
   retilíneas, colunas desalinhadas).

2. **KDE — morte do `SyncWindows` inteiro por coordenada fracionária.** A ponte KDE lê
   `frameGeometry`/`clientArea` do KWin e, em saídas com **escala fracionária/HiDPI**, esses valores
   são **fracionários** (ex.: `2649.063230904885`). O `WindowDto`/`MonitorDto` do daemon os
   desserializava como `i32` → `invalid type: floating point ... expected i32` → o serde recusava o
   **array inteiro** de janelas → 0 rects → tiling inerte no monitor afetado (derrubando junto o
   multi-monitor e a reaplicação de geometria pós-arraste). É exatamente a fragilidade que o `de_index`
   ([0020](0020-relayout-resiliente-monitor-invalido.md)) já havia blindado para índices.

## Decisão

### A) Snap por ARESTA no core (agnóstico) — `snap`/`snap_rect`/`snap_preview`/`snap_stack_slot`

O arredondamento final deixa de ser por campo e passa a derivar largura/altura da **diferença de
bordas arredondadas**: `width = round(x + w) − round(x)` (idem eixo Y). Assim, dois ladrilhos que
compartilham a MESMA fronteira `f64` (o cursor de tracks) aterrissam no MESMO pixel inteiro, e — como o
`gap` é inteiro — a costura entre tracks vizinhas preserva **exatamente** `inner_gap` px. Aplicado em
TODOS os pontos de emissão de `WindowRect`/`PreviewRect` (`compute_layout_with`, `geometry_from_tree`,
`render_stack`/`render_stack_node` via `snap_stack_slot`, `zone_rect`, `sub_rect_of_target`). Em
coordenadas já inteiras o resultado é idêntico ao anterior (retrocompat total dos testes existentes).

### B) `de_px` tolerante no daemon (agnóstico) — coordenada fracionária nunca derruba o sync

Espelhando `de_index`, um desserializador `de_px` aceita inteiro **ou** float e arredonda para `i32`.
Aplicado aos campos de pixel de `WindowDto` (`x,y,width,height,min_width,min_height`), `MonitorDto`
(`x,y,width,height`) e `GeomDto` (`target_json` do drag). Uma coordenada fracionária isolada passa a
ser arredondada em vez de recusar o array inteiro. O core segue operando só com inteiros.

### C) Higiene na origem (KDE) — `roundPx` na serialização

Complementarmente (ver [0061](0061-blindagem-multimonitor-desagrupar-e-system-tray-kde.md), ambiente
KDE), a ponte KDE arredonda as coordenadas em `serializeWindows`/`serializeMonitors`/`resizeDeltaFrom`
(`roundPx`), enviando inteiros limpos. `de_px` é a rede de segurança; a ponte é a origem do conserto —
"a lógica do KDE no KDE".

### Rejeitado: coordenadas em int64 ou trafegadas como String

Um adendo consultivo sugeriu migrar coordenadas para int64 ou trafegá-las como String. **Rejeitado**:
a raiz é **precisão** (fracionário), não **capacidade** (overflow) — pixels nunca se aproximam do
limite de `i32` (~2,1 bi). String não resolve o fracionário (ainda exigiria parse+arredondamento no
receptor) e int64 só inflaria a matriz de números nos loops de render/mouse. O padrão de String **já**
é usado onde a magnitude de 64 bits importa — os **IDs de janela** (uint64 do KWin que o QJSEngine não
empacota) — mas isso é ortogonal a coordenadas.

## Consequências

- **Positivas:** grid perfeitamente retilíneo e gaps simétricos no GNOME em qualquer resolução/densidade
  (até 16 janelas); tiling multi-monitor e arraste voltam a funcionar no KDE sob escala fracionária;
  fronteira do daemon robusta a qualquer ponte (defesa em profundidade); zero mudança em resoluções
  que já dividiam exato.
- **Testes:** core — `edge_snap_keeps_seams_exactly_inner_gap_on_fractional_area` (área 1001×803, 2..16
  janelas, toda costura == `inner_gap`); daemon — `window_dto_tolerates_fractional_pixels`,
  `sync_tolerates_fractional_coords_in_array`, `monitor_dto_tolerates_fractional_pixels`; ponte KDE —
  arredondamento em `serializeWindows`/`serializeMonitors`/`resizeDeltaFrom`.
- **Escopo:** core/daemon (agnóstico); GNOME/KDE/D-Bus inalterados exceto a higiene KDE do (C).
