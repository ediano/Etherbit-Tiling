// config.ts — contrato de configuração (lógica pura, sem dependências de GJS).
//
// Isolado de dbus.ts para ser testável em Node/vitest: aqui não há `import 'gi://…'`.
// O schema evolui no daemon (serde); a extensão só faz JSON.parse defensivo.

/// Espelha 1:1 a struct Config do daemon (etherbit-tiling-daemon).
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
  /// Smart gaps (COSMIC): sem gaps com uma janela só no workspace (ADR 0068).
  smart_gaps: boolean;
  /// Inserção de janela nova: `focus` (COSMIC) ou `cyclic` (ADR 0030).
  insert_mode: string;
}

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
  smart_gaps: false,
  insert_mode: 'focus',
};

/// Faz parse defensivo do JSON do daemon, completando campos ausentes com o padrão.
export function parseConfig(json: string): TilingConfig {
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(json) as Partial<TilingConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
