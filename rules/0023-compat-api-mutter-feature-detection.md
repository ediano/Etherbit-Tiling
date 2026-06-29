# 0023 — Compatibilidade da API do Mutter na ponte GNOME (feature-detection defensiva)

**Status:** ✅ Aceita

## Contexto

A extensão GNOME declara `shell-version: ["45", … "50"]` (ver `metadata.json`). A API do **Mutter**
(`Meta.Window`) **não é estável** nessa faixa: métodos somem, são renomeados ou trocam de assinatura
entre versões. Numa VM limpa (Ubuntu/GNOME), o `journalctl` capturou o sintoma:

```
JS ERROR: TypeError: window.get_maximized is not a function
```

A chamada vinha de `_isMaximized` (dentro de `_snapshot`, que monta o `WindowSnapshot` de **toda**
janela). Como o erro era lançado a cada relayout, **paralisava o tiling em loop** — o core ficava
inerte mesmo com o daemon no ar. A causa: `Meta.Window.get_maximized()` **não existe** no Mutter
daquela versão (foi substituído por `get_maximized_state()`).

Já havia precedente do problema e da solução no mesmo arquivo: `_minSize` lê `get_min_size()`
**defensivamente** (`typeof fn !== 'function'` → degrada para `[0,0]`), justamente porque o método
não existe em toda a faixa. Faltava firmar isso como **regra da camada**, não como remendo pontual.

## Decisão

- **Todo método volátil do `Meta.Window` é acessado por feature-detection em runtime**, nunca por
  chamada crua. O padrão é: testar `typeof obj.metodo === 'function'` para cada candidato, em ordem
  da API mais nova para a mais antiga, com **fallback** final por propriedade estável, tudo dentro de
  `try/catch` que degrada para um default seguro (espelha o `_minSize`).
- **`_isMaximized` passa a detectar em cadeia:**
  1. `get_maximized_state()` (Mutter recente);
  2. `get_maximized()` (Mutter antigo);
  3. fallback universal pelas **propriedades booleanas estáveis** `maximized_horizontally` **e**
     `maximized_vertically` (existem em toda a linha do `Meta.Window`).
- **Semântica preservada — AMBOS os eixos.** A comparação é `=== Meta.MaximizeFlags.BOTH` (ou as duas
  booleanas verdadeiras), **não** um `!== 0`. O contrato de `_isMaximized` (base do **Unmaximize
  Recovery**, ADR [0022](0022-stacknode-arvore-fechar-desagrupar-unmaximize.md)) é "maximizada em
  ambos os eixos"; um `!== 0` marcaria como maximizada uma janela maximizada **só** na horizontal ou
  vertical (ex.: tile lateral) e a tiraria do grid indevidamente.

## Consequências

- **Robustez por versão sem matriz de testes por shell:** a ponte não quebra ao rodar num GNOME
  cuja API divergiu; no pior caso cai no fallback booleano (sempre presente). Erro de API vira default
  seguro, nunca um loop de exceção que paralisa o relayout.
- **Contrato `maximized` intacto:** o campo do `WindowSnapshot`/`WindowDto` (ADR 0022) continua
  significando "ambos os eixos"; o core (`retain_tileable_when_maximized`) não muda.
- **Regra para código futuro:** ao consumir qualquer API nova/instável do Mutter na extensão, use o
  mesmo padrão defensivo (precedentes: `_isMaximized`, `_minSize`/`get_min_size`).
- **Tema irmão no KDE:** o endurecimento equivalente do **runtime do KWin (QJSEngine/Qt 6)** — alvo do
  Vite em `es2018` por causa do *optional catch binding* — está em
  [0013](0013-camada-kde-kwin-script.md) (emenda 2026-06). Juntos cobrem "a mesma classe de bug:
  pressuposto de runtime da camada nativa que falha numa versão real do ambiente gráfico".
