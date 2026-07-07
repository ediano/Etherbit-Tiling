// config.ts — contrato de configuração, espelho 1:1 da struct `Config` do daemon
// (etherbit-tiling-daemon). Módulo PURO (sem globais do KWin) para ser testável em Node.
//
// O daemon é a fonte de verdade do schema (serde); aqui só fazemos parse defensivo do JSON
// que trafega pelo D-Bus (ver ADR de nomenclatura D-Bus).

export interface TilingConfig {
  /// Chave geral do tiling: `false` libera as janelas (a ponte pausa o laço); `true` re-tila.
  enabled: boolean;
  gap: number;
  active_border: boolean;
  border_color: string;
  border_width: number;
  ignore_list: string[];
  autostart: boolean;
  rounded_corners: boolean;
  corner_radius: number;
  /// Grupos `(monitor, workspace)` com o tiling desligado, persistidos pelo daemon (ADR 0057). O
  /// `monitor` é o NOME estável do output (ADR 0056). Só trafega do daemon → ponte (hidratação na carga);
  /// a ponte reescreve via `SetDisabledGroups`. Não é uma chave do kwinrc.
  disabled_groups: Array<{ monitor: string; workspace: number }>;
}

/// Deve casar 1:1 com `impl Default for Config` em daemon/src/config.rs.
export const DEFAULT_CONFIG: TilingConfig = {
  enabled: true,
  gap: 8,
  active_border: true,
  border_color: '#5e81ac',
  border_width: 2,
  ignore_list: [],
  autostart: false,
  rounded_corners: true,
  corner_radius: 12,
  disabled_groups: [],
};

/// Faz parse defensivo do JSON do daemon, completando campos ausentes com o padrão.
export function parseConfig(json: string): TilingConfig {
  try {
    const parsed = JSON.parse(json) as Partial<TilingConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
