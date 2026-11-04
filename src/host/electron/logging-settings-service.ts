import type { LoggingSettingsRepository } from '@/host/settings/app-settings-repository.js'
import type {
  LoggingSettings,
  LoggingSettingsService,
  LogServiceLike,
} from '@/host/settings/logging-settings.js'

import { ConsoleLogSink, CONSOLE_SINK_NAME } from '@/host/console-log-sink.js'
import { normalizeLoggingSettings } from '@/host/settings/logging-settings.js'

/**
 * Electron implementation: persist first, then apply to the running kernel.
 * A failed write therefore leaves the live log level and sinks untouched.
 */
export class ElectronLoggingSettingsService implements LoggingSettingsService {
  constructor(
    private readonly store: LoggingSettingsRepository,
    private readonly log: LogServiceLike,
  ) {}

  get(): LoggingSettings {
    return this.store.getLogging()
  }

  async set(settings: LoggingSettings): Promise<LoggingSettings> {
    const next = normalizeLoggingSettings(settings)
    await this.store.setLogging(next)
    this.log.setLevel(next.level)
    if (next.enabled) {
      this.log.addSink(new ConsoleLogSink())
    } else {
      this.log.removeSink(CONSOLE_SINK_NAME)
    }
    return { ...next }
  }
}
