# 0067 — Auditoria GNOME: teto de bloqueio D-Bus, adoção de janelas pré-existentes e cantos sem CSD

**Status:** ✅ Aceita
(estende [0064](0064-resize-min-aware-e-blindagem-de-descarte-drop-overlay.md) — a barreira síncrona de
descarte é **mantida**, mas ganha teto de bloqueio; estende [0023](0023-compat-api-mutter-feature-detection.md) — o
fallback do `unmaximize()` passa a verificar o efeito, não só a exceção; **contrato D-Bus e core
inalterados**)

## Contexto

Uma auditoria completa do stack GNOME, feita com o objetivo de paridade com o tiling do COSMIC,
levantou falhas de renderização. Este ADR cobre as correções **locais à ponte**. As que exigem mudança
de contrato ou de core ficam para ADRs seguintes: size increments e tamanho máximo, esmagamento
impositivo sem 0 px, D-Bus assíncrono com geração, keybindings direcionais, smart gaps, borda ativa e
chave de monitor por connector.

1. **Congelamento do compositor.** Todas as chamadas são `*Sync` na thread principal do gnome-shell, e
   o timeout default do GDBus é de cerca de 25 s. Com o daemon travado ou parado, a sessão inteira
   congela.
2. **Janelas abertas antes do `enable()`** nunca entravam em `_tracked`: sem `unmanaged`/`size-changed`,
   sem relayout por (des)maximizar, e o shader de cantos **vazava** após o `disable()`.
3. **`unmaximize()` 0-arg no Mutter 45:** o GJS só emite um warning de aridade (não lança), então o
   fallback `unmaximize(BOTH)` nunca rodava.
4. **Cantos arredondados:**
   - os uniforms eram lidos de `actor.get_size()` logo após o `move_resize_frame`, com a alocação ainda
     pendente, e ficavam com o tamanho anterior;
   - em janelas CSD (GTK4/libadwaita) o ator inclui a sombra, então o SDF recortava a sombra, não a
     borda.

## Decisão

1. `createTilingProxy` define `set_default_timeout(1000)`. O daemon é puro e responde em ms; 1 s é o
   teto de bloqueio. A falha cai no `_call`, que já reconecta e degrada.
2. O `enable()` adota as janelas existentes via `_onWindowCreated(window, adopted = true)`. Elas ganham
   os mesmos sinais, mas sem spawn-unmaximize, sem gating de `first-frame`, com `spawnAt = 0` e marcadas
   em `_everTiled`, o que preserva o estado atual do usuário. O `disable()` também zera `_lastMinSizes`,
   `_everTiled` e `_closingIds`.
3. Depois do `unmaximize()` 0-arg, se `_isMaximized` ainda for verdadeiro, tenta a assinatura legada.
4. `effects.ts` conecta `notify::size` no ator para manter `width`/`height` em dia (o handler é
   desconectado em `clearRoundedCorners`). `hasClientShadow(frame, buffer)` exclui do efeito as janelas
   CSD.

## Consequências

- Um daemon travado causa no máximo cerca de 1 s de travamento por chamada, em vez de cerca de 25 s.
- Ativar a extensão com janelas já abertas passa a ter o mesmo ciclo de vida das janelas novas.
- Janelas libadwaita ficam com os próprios cantos nativos. O raio configurado vale para janelas SSD.

## Pendências mapeadas (próximos ADRs)

> Atualização: tratadas na [0068](0068-paridade-cosmic-no-gnome.md), que registra também as não adotadas.

- Size increments, tamanho máximo e aspecto no `WindowInfo` e no core; convergência tolerante.
- Esmagamento impositivo sem rects de 0 px.
- D-Bus assíncrono com número de geração, preservando a barreira de descarte da ADR 0064.
- Paridade COSMIC:
  - inserção pela janela focada;
  - focus, swap e move direcionais;
  - toggle de orientação;
  - float por janela;
  - smart gaps;
  - borda de janela ativa (config já existe, sem render);
  - chave de monitor por connector, com migração no hotplug.
- Reutilizar as tab bars em vez de recriá-las a cada relayout.

## Emenda (2026-10-27) — adotadas também ganham o `first-frame` (ADR 0072)

O `import()` assíncrono do loader ([0071](0071-update-sem-logout-hot-reload.md)) pode adotar janelas
que ainda não desenharam. Pela [0072](0072-recusa-com-evidencia-e-transientes-flutuam.md), o
`first-frame` é conectado também nas adotadas: o sinal é de disparo único por ator e nunca dispara numa
janela que já renderizou, então o hot-reload continua preservando o estado do usuário.
