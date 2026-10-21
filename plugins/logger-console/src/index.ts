/**
 * logger-console plugin -- observability (logging) is a plugin.
 *
 * Contributes a console sink to the kernel via the `log.sink` extension point.
 * The kernel has no idea where logs are written -- that is the point of
 * "everything is a plugin".
 *
 * Shape: the only form is `export default definePlugin(manifest, setup)`.
 */

import { definePlugin, defineToken, KernelTokens } from 'rem2-kernel'
import type { Logger, LogEntry, LogSink, PluginContext } from 'rem2-kernel'

class ConsoleLogSink implements LogSink {
  readonly name = 'console'

  write(entry: LogEntry): void {
    const ts = new Date(entry.ts).toISOString()
    const data = entry.data ? ` ${JSON.stringify(entry.data)}` : ''
    const line = `[${ts}] ${entry.level.toUpperCase().padEnd(5)} (${entry.scope}) ${entry.msg}${data}`
    if (entry.level === 'error' || entry.level === 'fatal') {
      process.stderr.write(`${line}\n`)
    } else {
      process.stdout.write(`${line}\n`)
    }
  }

  async flush(): Promise<void> {
    // The console is unbuffered, so flush is a no-op.
  }
}

/** Minimal structural type for the kernel LogService. */
export interface LogServiceLike {
  addSink(sink: LogSink): void
  removeSink(name: string): void
  child(scope: string, pluginId?: string): Logger
}

/** Token with the same id as the kernel KernelTokens.Log (declared plugin-side for resolution). */
export const LogServiceToken = defineToken<LogServiceLike>({
  id: KernelTokens.Log.id,
  describe: 'Kernel log service',
})

export default definePlugin(
  { id: 'com.rem2.logger-console', name: 'Console Logger', version: '1.0.0' },
  (ctx: PluginContext) => {
    return {
      async onStart(): Promise<void> {
        const log = ctx.services.tryResolve(LogServiceToken)
        if (!log) {
          ctx.log.warn(
            'Kernel LogService not found; logger-console entering degraded mode',
          )
          return
        }

        // The single contribution entry point: the extension registry.
        ctx.extensions.contribute<LogSink>('log.sink', {
          contributionId: 'console',
          impl: new ConsoleLogSink(),
        })
        ctx.log.info('Console log sink registered (log.sink extension point)')
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        // The kernel force-reclaims contributions at unload time by pluginId; no manual cleanup is needed.
        hookCtx.log.info(`Console log sink unregistered (${reason})`)
      },
    }
  },
)
