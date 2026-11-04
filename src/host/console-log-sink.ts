/**
 * Host-owned console sink.
 *
 * Console logging used to be a sample plugin; it is now a host default because
 * every host needs it and the settings page must be able to turn it off. Where
 * logs land remains replaceable: plugins can still contribute their own
 * `log.sink`.
 */

import type { LogEntry, LogSink } from '@/kernel/contracts/logging.js'

export const CONSOLE_SINK_NAME = 'console'

export class ConsoleLogSink implements LogSink {
  readonly name = CONSOLE_SINK_NAME

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
