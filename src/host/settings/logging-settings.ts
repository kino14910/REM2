import type { LogLevel, LogSink } from '@/kernel/contracts/logging.js'
import type { LoggingSettingsDto } from '@/shared/ipc-contract.js'

import { LOG_LEVELS } from '@/shared/ipc-contract.js'

/** Persisted logging settings (same shape as the renderer DTO). */
export type LoggingSettings = LoggingSettingsDto

export const DEFAULT_LOGGING_SETTINGS: LoggingSettings = {
  enabled: true,
  level: 'info',
}

function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === 'string' &&
    (LOG_LEVELS as readonly string[]).includes(value)
  )
}

/** Normalize untrusted settings (persisted file or IPC args) into the stored shape. */
export function normalizeLoggingSettings(value: unknown): LoggingSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('logging settings must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean') {
    throw new Error('logging enabled must be a boolean')
  }
  if (!isLogLevel(record.level)) {
    throw new Error(`logging level must be one of: ${LOG_LEVELS.join(', ')}`)
  }
  return { enabled: record.enabled, level: record.level }
}

/**
 * Structural subset of the kernel `LogService` the settings service needs.
 * Kept here (electron-free) so the Electron implementation and tests share one
 * contract without importing concrete kernel classes.
 */
export interface LogServiceLike {
  setLevel(level: LogLevel): void
  addSink(sink: LogSink): void
  removeSink(name: string): void
}

/** Host-side logging service consumed by the IPC method table (electron-free). */
export interface LoggingSettingsService {
  get(): LoggingSettings
  /** Persist first, then apply to the running kernel. */
  set(settings: LoggingSettings): Promise<LoggingSettings>
}
