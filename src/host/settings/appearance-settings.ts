import type {
  AppearanceSettingsDto,
  ColorModeDto,
} from '@/shared/ipc-contract.js'

/** Persisted appearance settings (same shape as the renderer DTO). */
export type AppearanceSettings = AppearanceSettingsDto

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  colorMode: 'system',
}

const COLOR_MODES: readonly ColorModeDto[] = ['light', 'dark', 'system']

function isColorMode(value: unknown): value is ColorModeDto {
  return (
    typeof value === 'string' &&
    (COLOR_MODES as readonly string[]).includes(value)
  )
}

/** Normalize untrusted settings (persisted file or IPC args) into the stored shape. */
export function normalizeAppearanceSettings(
  value: unknown,
): AppearanceSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('appearance settings must be an object')
  }
  const colorMode = (value as Record<string, unknown>).colorMode
  if (!isColorMode(colorMode)) {
    throw new Error('appearance colorMode must be "light", "dark" or "system"')
  }
  return { colorMode }
}

/** Host-side appearance service consumed by the IPC method table (electron-free). */
export interface AppearanceSettingsService {
  get(): AppearanceSettings
  set(settings: AppearanceSettings): Promise<AppearanceSettings>
}
