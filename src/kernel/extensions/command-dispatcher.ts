/**
 * Command dispatcher: the single dispatch path for `command.execute`.
 *
 * The host IPC bridge requests `Topics.CommandExecute` on the kernel event
 * bus; this dispatcher is the only responder for that topic and reads the
 * `command.provide` extension slot directly. Because it never re-requests
 * the same topic, the self-recursion trap (a responder forwarding a request
 * to itself, once a real RangeError defect) is structurally impossible.
 */

import type { ExtensionPointRegistry } from './registry.js'
import type { CommandHandler } from './ports.js'

/**
 * Result of a command dispatch.
 *
 * The shape is owned by the command handler itself (see docs 02 §8): the
 * dispatcher passes the handler's return value through untouched instead of
 * wrapping it, so `{ok:true, output}` never becomes `{ok:true, output:{...}}`.
 */
export interface CommandDispatchResult {
  ok: boolean
  output?: unknown
  error?: string
}

export class CommandDispatcher {
  constructor(private readonly extensions: ExtensionPointRegistry) {}

  async dispatch(payload: unknown): Promise<CommandDispatchResult> {
    if (typeof payload !== 'object' || payload === null) {
      return {
        ok: false,
        error: 'invalid command payload: expected an object',
      }
    }
    const command = (payload as { command?: unknown }).command
    if (typeof command !== 'string' || command.length === 0) {
      return {
        ok: false,
        error:
          'invalid command payload: expected { command: non-empty string }',
      }
    }

    // Direct slot read: no bus.request, so dispatch cannot re-enter itself.
    const entries = this.extensions.entries<CommandHandler>('command.provide')
    const entry = entries.find(e => e.contributionId === command)
    if (!entry) {
      return { ok: false, error: `unknown command: ${command}` }
    }

    try {
      const args = (payload as { args?: unknown }).args
      // Boundary trust: the handler owns its result shape, pass it through as-is.
      return (await entry.impl(args)) as CommandDispatchResult
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }
}
