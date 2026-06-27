# Etherbit Tiling — Manifesto & Decisão de Nome

> **O gerenciador automático de janelas para macOS, inspirado no ambiente COSMIC.**

O **Etherbit Tiling** nasceu de uma frustração que quase todo desenvolvedor sente no Mac: a falta de
um gerenciador de janelas que seja realmente automático, fluido e resistente a atualizações. Enquanto
as opções do mercado exigem que você fique arrastando janelas ou quebram a cada versão nova do macOS,
nós fomos buscar inspiração na física, na computação e no comportamento do aclamado ambiente
**COSMIC do Pop!_OS**.

O nome **Etherbit** é a fusão cirúrgica de dois conceitos que definem a alma do nosso algoritmo:

```
   [ E T H E R ]                 [ B I T ]
(Preenchimento do Vazio)     (O final de Ór'bit'a / Computação)
          \                         /
           \                       /
         [ E T H E R B I T   T I L I N G ]
```

## 🌌 A Filosofia por trás do Nome

1. **Ether (Éter):** Na física clássica, o *Éter* era a substância invisível que preenchia todo o
   espaço vazio do universo. No nosso software, o **Ether** representa a eliminação do espaço
   desperdiçado na tela. O aplicativo funciona como esse tecido invisível, organizando as janelas
   automaticamente em blocos (*tiles*) para garantir que cada pixel da sua tela seja aproveitado de
   ponta a ponta, sem buracos e sem sobreposições.

2. **Bit (Órbita e Tecnologia):** O sufixo **Bit** cumpre um papel duplo. Ele herda a mecânica de
   **Orbit** (Órbita), representando o equilíbrio perfeito onde as janelas encontram suas posições
   ideais sozinhas, guiadas pela gravidade do sistema. Ao mesmo tempo, ele celebra o **Bit** como a
   unidade básica da computação, reforçando que este é um utilitário focado em performance pura,
   construído nativamente em Swift.

## 🛠️ O que o Etherbit Tiling entrega de verdade

O Etherbit resolve o problema do ecossistema Mac trazendo a inteligência do Pop!_OS para dentro do macOS:

- **Organização Automática (Tiling Dinâmico):** Esqueça o mouse. No momento em que você abre um
  terminal, um editor de código ou o navegador, o app calcula o espaço e joga a janela para a
  "órbita" correta instantaneamente.
- **Preenchimento Inteligente (Ether Flow):** Uma divisão matemática de tela que elimina espaços
  mortos e se adapta em tempo real conforme você abre ou fecha seus apps.
- **Arquitetura Swift Nativa e Resiliente:** Construído do zero focando nas APIs mais profundas e
  estáveis da Apple. Isso garante um app ultra leve, incrivelmente rápido e que não vai quebrar
  quando o macOS atualizar.

> **Etherbit Tiling:** O tecido invisível que coloca suas janelas em órbita perfeita.

---

### Glossário de marca (referência rápida)

| Termo | Significado no projeto |
|-------|------------------------|
| **Ether** | Tecido invisível que preenche o vazio da tela (zero espaço desperdiçado). |
| **Bit** | Órbita (equilíbrio automático) + unidade de computação (performance pura). |
| **Ether Flow** | Algoritmo agnóstico de divisão de tela (crate `core/`). |
| **Tiling Dinâmico** | Organização automática de janelas ao abrir/fechar apps. |
