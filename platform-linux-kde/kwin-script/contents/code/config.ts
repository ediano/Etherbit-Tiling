// config.ts — contrato de configuração, espelho 1:1 da struct `Config` do daemon
// (etherbit-tiling-daemon). Módulo PURO (sem globais do KWin) para ser testável em Node.
//
// O daemon é a fonte de verdade do schema (serde); aqui só fazemos parse defensivo do JSON
// que trafega pelo D-Bus (ver ADR de nomenclatura D-Bus).

export interface TilingConfig {
  gap: number;
  active_border: boolean;
  border_color: string;
  border_width: number;
  ignore_list: string[];
  autostart: boolean;
  rounded_corners: boolean;
  corner_radius: number;
}

/// Deve casar 1:1 com `impl Default for Config` em daemon/src/config.rs.
export const DEFAULT_CONFIG: TilingConfig = {
  gap: 8,
  active_border: true,
  border_color: '#5e81ac',
  border_width: 2,
  ignore_list: [],
  autostart: false,
  rounded_corners: true,
  corner_radius: 12,
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
