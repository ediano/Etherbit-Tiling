# Testes — macOS (Swift)

> Placeholder. A camada macOS ainda não tem código (sem `Package.swift`); o build/teste
> acontece no **host macOS**, não no Dev Container Linux. Ver [ADR 0012](../rules/0012-testes-isolados-por-plataforma.md).

## Estratégia (quando existir `Package.swift`)

- **Runner:** `swift test` (XCTest ou Swift Testing), exclusivamente em `macos-latest`.
- **Escopo:** seguir a mesma filosofia das demais plataformas (ADR 0012) — testar **lógica pura**
  (decisões de geometria/filtragem da ponte com o core) sem depender da Accessibility API/AppKit,
  que exigem um ambiente gráfico real.
- **CI:** ativar o job `test-macos` (hoje **comentado**) em
  [`.github/workflows/test.yml`](../.github/workflows/test.yml), espelhando o `release-macos`
  comentado em [`release.yml`](../.github/workflows/release.yml). Como o `test.yml` é o gate do
  release (`needs: tests`), o job macOS passará a barrar o release automaticamente quando habilitado.

## Como rodar localmente (futuro)

```sh
cd platform-macos
swift test
```
