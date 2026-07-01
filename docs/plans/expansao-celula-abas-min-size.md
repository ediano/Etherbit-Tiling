# Plano — Bug fix: célula de abas não expande ao `min-size` do membro (agrupamento manual, GNOME/Wayland)

**Status:** ✅ Implementado (core 93 testes, vitest 83, typecheck/build limpos) — ⏳ pendente de verificação em sessão real GNOME/Wayland.
**Escopo travado:** só o bug fix da expansão. Cascata seletiva de absorção **fora de escopo** (ADR 0042 permanece inalterado).

## Contexto (por que)

O "Adendo Técnico" pedia **Expansão Dinâmica de Célula de Abas com Absorção de Vizinhos em
Cascata**. Investigando o código, quase toda a regra **já existe**: a expansão da célula ao
`min-size` (`build_min_sizes` + `solve_tracks`/esmagamento impositivo, ADR 0040), o empurrão dos
vizinhos (ADR 0040) e a absorção por colisão (ADR 0041/0042). O sintoma real relatado pelo usuário
— **"não expande nada"** ao agrupar manualmente um app de `min-size` grande (ex.: Firefox) numa
célula pequena — é um **bug pontual de valor degradado na ponte GNOME**, não uma lacuna de regra.

Decisão de escopo do usuário: **corrigir só o bug de expansão agora.** A cascata seletiva de
absorção (empurrar quem tem folga, absorver só o esmagado) fica **fora deste plano**; a absorção
atual do ADR 0042 (funde o grid inteiro) permanece **inalterada**.

## Causa-raiz (confirmada por leitura de código)

Ao soltar o arrastado (A) no **centro** do alvo (B), a ponte cria o stack
`{ members:[B, A], active: A }` (âncora = **alvo B**, ativo = **arrastado A**) — `bridge.ts addToStack`,
usado em [extension.ts:1243-1246](../../platform-linux-gnome/extension/src/extension.ts#L1243-L1246). No
relayout seguinte, as abas **inativas** (todo membro ≠ `active`) são **minimizadas** em
[extension.ts:814-822](../../platform-linux-gnome/extension/src/extension.ts#L814-L822) /
[extension.ts:938-952](../../platform-linux-gnome/extension/src/extension.ts#L938-L952). Ou seja, quando o
app grande é o **alvo B**, é justamente ele que fica minimizado.

A janela minimizada **continua** no snapshot (o daemon não filtra minimizada — `is_tileable` em
[layout.rs:320-332](../../core/src/layout.rs#L320-L332) só checa ignore/resizable/maximizable/normal; e
`group_ids` a inclui). O elo que quebra é o **VALOR**: `Meta.Window.get_min_size()` de uma janela
minimizada/não-mapeada no Wayland devolve `(0,0)`/stale. Em
[_minSize (extension.ts:1895-1906)](../../platform-linux-gnome/extension/src/extension.ts#L1895-L1906) esse
`(0,0)` vira o `min_width/min_height` do snapshot de B. No core,
[build_min_sizes (layout.rs:1215-1231)](../../core/src/layout.rs#L1215-L1231) agrega
`mw = max(A.min, 0) = A.min` (pequeno) → a célula **não cresce** ao mínimo do Firefox.

A lógica pura do core está **correta** — provado por `stack_min_agrega_max_dos_membros_mais_tab_bar`
([layout.rs:3281](../../core/src/layout.rs#L3281)) e `apos_agrupar_em_stack_nao_ha_mais_colisao`
([layout.rs:3238](../../core/src/layout.rs#L3238)): com o `min` real presente, o stack expande/agrega
certo. O bug é **exclusivamente** o valor degradado na ponte.

## Correção — memoizar o último `min-size` real por id, na ponte (opção mínima)

Vive só na ponte (o daemon segue stateless, ADR 0016), **contrato D-Bus inalterado** (o `WindowDto`
já carrega `min_width/min_height`). Descartadas: (i) reenviar o min dos inativos — mesma fonte
degradada; (iii) `StackDescriptor` carregar mínimos — mexe em core + DTO + `group_stacks`, maior
blast radius e toca o contrato do `state_json`.

**Mudanças:**

1. **Helper puro em `bridge.ts`** (padrão dos puros `addToStack`/`removeIdFromStacks`, testável em
   vitest):

   ```ts
   // Último min real conhecido: memoiza quando a janela está visível e reporta min > 0;
   // devolve o memoizado quando a fonte degrada (janela minimizada/não-mapeada → get_min_size (0,0)).
   export function effectiveMinSize(
     cache: Map<number, [number, number]>,
     id: number,
     raw: [number, number],
     minimized: boolean,
   ): [number, number] {
     if (!minimized && (raw[0] > 0 || raw[1] > 0)) {
       cache.set(id, raw);
       return raw;
     }
     return cache.get(id) ?? [0, 0];
   }
   ```

2. **Campo de cache** junto do estado leve da ponte, perto de
   [extension.ts:171-178](../../platform-linux-gnome/extension/src/extension.ts#L171-L178) (onde já vivem
   `_stacks`, `_stackHidden` etc.):
   `private _lastMinSizes = new Map<number, [number, number]>();`

3. **Usar em `_minSize`** ([extension.ts:1895-1906](../../platform-linux-gnome/extension/src/extension.ts#L1895-L1906)):
   após ler o `get_min_size()` cru, detectar minimizada por feature detection (padrão de
   `_isWindowLive`) e delegar ao helper:

   ```ts
   const minimized =
     (window as unknown as { is_minimized?: () => boolean }).is_minimized?.() ?? false;
   return effectiveMinSize(this._lastMinSizes, window.get_stable_sequence(), raw, minimized);
   ```

4. **Limpeza** do id em `_lastMinSizes` no fechamento da janela, junto do `removeIdFromStacks` já
   existente (mesmos pontos de [extension.ts:523](../../platform-linux-gnome/extension/src/extension.ts#L523)
   e/ou [extension.ts:1485](../../platform-linux-gnome/extension/src/extension.ts#L1485)), para não vazar
   entre sessões.

**Efeito:** enquanto B esteve visível (antes de virar aba inativa) seu min real foi capturado; ao
ser minimizada, `_minSize` devolve o memoizado → `build_min_sizes` agrega o `max` correto → a célula
de abas expande ao min do Firefox. Sem tocar core, daemon ou D-Bus.

## Arquivos a modificar

- [platform-linux-gnome/extension/src/bridge.ts](../../platform-linux-gnome/extension/src/bridge.ts) — helper puro `effectiveMinSize`.
- [platform-linux-gnome/extension/src/extension.ts](../../platform-linux-gnome/extension/src/extension.ts) — campo `_lastMinSizes` (~171-178); uso em `_minSize` (~1895) com feature detection de `is_minimized`; limpeza no fechamento (~523/1485).
- [core/src/layout.rs](../../core/src/layout.rs) — apenas **novo teste** (nenhuma mudança de lógica).

## Testes

**Vitest (`bridge.ts`, helper puro `effectiveMinSize`):**

- grava quando visível e `min > 0`;
- devolve memoizado quando minimizada (`raw=[0,0]`, cache `[700,0]` → `[700,0]`);
- fallback `[0,0]` sem histórico;
- **não** grava min zerado de janela visível (`raw=[0,0]`, `!minimized` → não polui o cache).

**Core (`core/src/layout.rs`, `#[cfg(test)]`) — guarda de regressão da lógica pura:**

- novo `stack_expande_ao_min_do_membro_ainda_que_inativo`: stack `[B, A]` `active=A`,
  `win_min(B,700,0)`, `win_min(A,100,0)` num grid de 1000px; `compute_constrained` → o slot da
  âncora B tem `width >= 700`. Espelha [layout.rs:3238](../../core/src/layout.rs#L3238)/[3281](../../core/src/layout.rs#L3281).
  (O core não conhece "minimizada"; o teste fixa o comportamento-alvo — o valor degradado é problema
  só da ponte.)

## Verificação end-to-end

1. `cargo test` no workspace `core` (novo teste passa) e `pnpm test` (vitest) na extension.
2. `cargo build` no daemon e `pnpm build` na extension (sem regressão de tipos/lint).
3. **Sessão real GNOME/Wayland** (Fedora): abrir um Firefox pequeno (alvo), arrastar outra janela
   pequena **para o centro** do Firefox (Firefox = alvo → vira aba inativa/minimizada) e confirmar
   que a **célula de abas cresce até o `min-size` do Firefox** (sem corte/sobreposição). Testar
   também alternar as abas (o membro grande minimizado deve manter a célula expandida).

## Fora de escopo (registrado)

- **Cascata seletiva de absorção** (empurrar quem tem folga, absorver só o vizinho esmagado) — a
  absorção do ADR 0042 (funde o grid inteiro) permanece inalterada. Se for retomada depois, exige um
  ADR 0044 novo com análise de convergência (a absorção é permanente/monotônica por ADR 0041, então
  a cascata é viável sem oscilação).
- **Nenhum ADR** é necessário para este bug fix: é valor degradado corrigido na ponte, sem mudança
  de convenção nem de contrato. As regras vigentes (min-size real ADR 0033; agregação/esmagamento
  ADR 0040/0041/0042) só passam a receber o valor correto.

## Riscos

- Retrocompat: **nula** — nada muda no D-Bus/DTO/StackDescriptor; só a ponte memoiza.
- `is_minimized` ausente em alguma versão de API → feature detection degrada para o valor cru (sem
  regressão).
- Min nunca capturado antes (janela nasceu já agrupada, nunca ficou visível) → fallback `[0,0]` até
  virar aba ativa; corrige no ciclo seguinte.
- Hipótese não confirmada em sessão real de que `get_min_size()` devolve `(0,0)` para minimizadas no
  Mutter atual — porém a correção é robusta a **qualquer** degradação (todo valor ausente/zerado de
  minimizada é substituído pelo último min real). O passo 3 de verificação fecha a lacuna.

## Estado de retomada (checklist)

- [x] Helper `effectiveMinSize` em `bridge.ts`
- [x] Campo `_lastMinSizes` + uso em `_minSize` (com `is_minimized`) + limpeza no fechamento em `extension.ts`
- [x] Vitest de `effectiveMinSize` (5 casos)
- [x] Teste core `stack_expande_ao_min_do_membro_ainda_que_inativo`
- [x] `cargo test`/`cargo build` + `pnpm test`/`pnpm build`
- [ ] Verificação em sessão real GNOME/Wayland
