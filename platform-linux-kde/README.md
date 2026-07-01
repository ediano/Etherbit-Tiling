# platform-linux-kde

Camada nativa do **Etherbit Tiling** para **KDE Plasma 6**, exclusivamente sob **Wayland**.

No KDE/Wayland, o compositor e gerenciador de janelas é o **KWin**. Ele não aceita "extensions"
no estilo GNOME Shell — o ponto de extensão equivalente é um **KWin Script** (JavaScript executado
dentro do próprio KWin). Por isso esta camada entrega **apenas o KWin Script** (`kwin-script/`):
o daemon Rust (`etherbit-tiling-daemon`) é **reaproveitado** da camada `etherbit-tiling-daemon`, pois
já é agnóstico de ambiente de desktop (config TOML + serviço D-Bus `dev.ediano.etherbit.Tiling` + autostart).

> Ver ADR [0013](../rules/0013-camada-kde-kwin-script.md) (camada KDE) e
> [0014](../rules/0014-daemon-linux-compartilhado.md) (daemon compartilhado GNOME/KDE).

## Requisitos (linha de corte)

Suporte **exclusivo** às versões modernas da stack KDE — **sem retrocompatibilidade**:

- **KDE Plasma ≥ 6**
- **KDE Frameworks ≥ 6**
- **Qt ≥ 6**

Sessão **Wayland** (sem X11). Os instaladores exigem `kpackagetool6`, `kwriteconfig6` e
`qdbus6`/`qdbus-qt6` — o `qdbus` puro (que pode ser o do Qt 5) **não** é usado.

## Estrutura

```
platform-linux-kde/
└── kwin-script/                 # análogo KDE da extension GNOME (TypeScript + Vite → IIFE)
    ├── metadata.json            # KPackageStructure "KWin/Script"; Id = etherbit-tiling
    ├── package.json             # scripts: build/typecheck/test/install:script (pnpm)
    ├── vite.config.ts           # bundle único IIFE → contents/code/main.js
    ├── vitest.config.ts         # testes dos módulos puros (Node)
    ├── tsconfig.json
    ├── kwin-globals.d.ts        # tipos ambientes da API de scripting do KWin
    ├── scripts/install.sh       # instala/atualiza via kpackagetool6 + habilita + reconfigure
    └── contents/
        ├── code/
        │   ├── main.ts          # ponte: lê kwinrc, propaga ao daemon, escuta janelas, aplica geometria
        │   ├── config.ts        # PURO: contrato/parse da config (espelho do daemon)
        │   └── tiling.ts        # PURO: filtro shouldTile + layout placeholder (tileColumns)
        ├── config/main.xml      # KConfigXT: innerGap, outerGap, activeBorder, …
        └── ui/config.ui         # UI nativa (objectName = kcfg_<chave>)
```

## Desenvolvimento

```bash
cd platform-linux-kde/kwin-script
corepack enable
pnpm install
pnpm typecheck        # checagem de tipos
pnpm test             # vitest (módulos puros)
pnpm build            # gera contents/code/main.js (IIFE)
pnpm run install:script   # build + kpackagetool6 -i/-u + habilita + reconfigure
```

> O KWin Script é só a **ponte/cliente** — ele fala com o daemon Rust via D-Bus. Em desenvolvimento,
> rode o daemon à parte (senão o tiling fica inerte):
>
> ```bash
> RUST_LOG=debug cargo run --manifest-path etherbit-tiling-daemon/Cargo.toml
> ```

Logs do script em runtime: `journalctl -f QT_CATEGORY=kwin_scripting`
(ou `QT_LOGGING_RULES="kwin_*.debug=true"`). Ligue a chave **`debug`** (kwinrc) para o detalhamento
por evento (nº de janelas/retângulos). Diagnóstico de IPC: ver
[docs/DIAGNOSTICO-IPC.md](../docs/DIAGNOSTICO-IPC.md).

A configuração (gaps, borda, autostart) fica em **Configurações do Sistema → KWin Scripts →
Etherbit Tiling (⚙)**; os valores são gravados no `~/.config/kwinrc` e propagados ao daemon.

## Instalação (usuário final)

Via pacote de release `etherbit-tiling-kde.tar.gz` (daemon + KWin Script + installer):

```bash
curl -sSL https://github.com/ediano/etherbit-tiling-releases/releases/latest/download/install-kde.sh | bash
```
