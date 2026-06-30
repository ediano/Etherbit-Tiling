# Arquitetura de Alto Nível

O princípio central do Etherbit Tiling é a **separação entre decisão e aplicação**:

- **Decisão** — _onde cada janela deve ficar_ — é responsabilidade do **core agnóstico** (Ether Flow),
  escrito uma única vez em Rust.
- **Aplicação** — _capturar eventos e mover janelas de verdade_ — é responsabilidade de uma **camada
  fina e nativa por plataforma**.

Assim, a lógica difícil (geometria, regras de filtragem, fluxo) não é reescrita por SO, e cada
plataforma só implementa o mínimo que depende de APIs nativas.

```
                       ┌───────────────────────────────────┐
                       │            core (Rust)            │
                       │         Algoritmo Ether Flow      │
                       │  geometria · regras · fluxo de    │
                       │      preenchimento (agnóstico)    │
                       └───────────────┬───────────────────┘
                                       │  decisões de layout
            ┌──────────────────────────┴──────────────────────────┐
            │                                                      │
   ┌────────▼─────────┐                              ┌─────────────▼────────────────┐
   │   macOS (Swift)  │                              │     Linux / GNOME 45+         │
   │ AppKit +         │                              │  ┌──────────────┐  D-Bus      │
   │ Accessibility API│                              │  │   daemon     │◄──────────► │
   │                  │                              │  │  (Rust, bin) │             │
   │ observa janelas, │                              │  └──────┬───────┘             │
   │ aplica o layout  │                              │         │ D-Bus               │
   │                  │                              │  ┌──────▼───────┐             │
   │                  │                              │  │  extension   │ (Vite/TS)   │
   │                  │                              │  │  GNOME Shell │             │
   └──────────────────┘                              │  └──────────────┘             │
                                                     └───────────────────────────────┘
```

## Componentes

### `core` — Ether Flow (Rust, agnóstico)

Biblioteca pura, sem dependência de SO. Recebe o estado das janelas (geometria, monitores, foco) e
devolve o layout-alvo. Aqui vivem a matemática da divisão de tela, as regras de filtragem (quais
janelas entram no tiling) e a adaptação em tempo real ao abrir/fechar apps.

### macOS — camada nativa (Swift)

Usa **AppKit** e a **Accessibility API** para observar a criação/movimentação/fechamento de janelas e
para reposicioná-las conforme as decisões do core. É a plataforma-alvo principal. Construída sobre as
APIs estáveis da Apple para resistir a atualizações do macOS. **Compilada no host macOS** (o SDK da
Apple não roda no container Linux).

### Linux / GNOME — daemon + extension

No Wayland/GNOME, um processo não pode mover janelas de outro diretamente; a manipulação acontece
**dentro do GNOME Shell**. Por isso há dois componentes:

- **`daemon` (Rust, bin)** — roteador de eventos **D-Bus**. Faz a ponte entre o sistema e o core,
  traduzindo eventos e decisões. Depende de `libdbus-1` (daí `libdbus-1-dev` + `pkg-config` na imagem
  de dev).
- **`extension` (TypeScript + Vite, ESM)** — extensão do **GNOME Shell** que executa no processo do
  Shell, recebe ordens do daemon via D-Bus e aplica o layout às janelas reais.

## Por que essa divisão?

- **Reuso máximo:** o algoritmo difícil é escrito uma vez (core) e compartilhado.
- **Resiliência:** cada camada nativa é fina e encostada em APIs estáveis, reduzindo quebras.
- **Performance:** core e daemon em Rust; camada macOS em Swift nativo — utilitário leve e rápido.
- **Testabilidade:** o core é testável isoladamente, sem precisar de um ambiente gráfico.

> Veja também: [ESTRUTURA.md](ESTRUTURA.md) · [DESENVOLVIMENTO.md](DESENVOLVIMENTO.md) · [NOMENCLATURA.md](NOMENCLATURA.md)
