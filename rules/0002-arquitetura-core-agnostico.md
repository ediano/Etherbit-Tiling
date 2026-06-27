# 0002 — Core agnóstico em Rust + camadas nativas por plataforma

**Status:** ✅ Aceita

## Contexto
Um gerenciador de janelas precisa de lógica complexa (geometria, regras de filtragem, fluxo de
preenchimento) e, ao mesmo tempo, de integração profunda com APIs específicas de cada SO. Reescrever a
lógica por plataforma seria caro e propenso a divergências.

## Decisão
Separar **decisão** de **aplicação**:

- **`core/` (Rust, lib `etherbit-core`)** — algoritmo **Ether Flow**, agnóstico de SO. Recebe estado
  das janelas e devolve o layout-alvo. Sem dependências de plataforma.
- **Camadas nativas finas por plataforma** — apenas capturam eventos e aplicam o layout:
  - **macOS:** Swift (AppKit + Accessibility API) — plataforma-alvo principal.
  - **Linux/GNOME:** `daemon` (Rust, D-Bus) + `extension` (GNOME Shell, TS/Vite).

## Consequências
- A lógica difícil é escrita **uma vez** e reutilizada.
- O core é testável isoladamente, sem ambiente gráfico.
- Cada camada nativa é fina e encostada em APIs estáveis → maior resiliência a updates de SO.
- Detalhes em [docs/ARQUITETURA.md](../docs/ARQUITETURA.md).
