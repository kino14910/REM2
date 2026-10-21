/**
 * hello-command plugin -- business features are plugins.
 *
 * - Provides a command handler via the `command.provide` extension point.
 * - Soft dependency on config-json: when it is missing, a default greeting is
 *   used and the plugin still starts normally (degraded, not failed).
 */

import { Topics } from 'rem2-kernel'
import { definePlugin, defineToken } from 'rem2-kernel'
import type {
  EventBus,
  HealthStatus,
  PluginContext,
  Unsubscribe,
} from 'rem2-kernel'

export interface Greeter {
  greet(name: string): string
}

export const GreeterToken = defineToken<Greeter>({
  id: 'plugin.hello.greeter',
  capability: 'command.provide',
  describe: 'Greeting service',
})

class GreeterImpl implements Greeter {
  constructor(private greeting: string) {}

  setGreeting(greeting: string): void {
    this.greeting = greeting
  }

  greet(name: string): string {
    return `${this.greeting}, ${name}!`
  }
}

export default definePlugin(
  { id: 'com.rem2.hello-command', name: 'Hello Command', version: '1.0.0' },
  (ctx: PluginContext) => {
    let greeter: GreeterImpl | null = null
    const unsubs: Unsubscribe[] = []
    let startedFlag = false
    /** Whether the soft dependency config-json is present (used for health status). */
    let configPluginPresent = false

    return {
      async onConfigure(): Promise<void> {
        configPluginPresent = ctx.plugins.has('com.rem2.config-json')
        greeter = new GreeterImpl(
          ctx.config.get<string>('app.greeting', 'Hello'),
        )
      },

      async onStart(): Promise<void> {
        if (!greeter) {
          greeter = new GreeterImpl('Hello')
        }

        // Register the service (by default it does not leak to the parent container; explicit api.export is required).
        ctx.services.registerInstance<Greeter>(GreeterToken, greeter)
        ctx.api.export(GreeterToken, { capability: 'command.provide' })

        const bus = ctx.events
        // Subscribe to command-execute events (for emit broadcasts).
        unsubs.push(
          bus.on<{ command: string; args?: unknown }>(
            Topics.CommandExecute,
            async p => {
              if (!p || p.command !== 'hello') return
              const g = ctx.services.resolve(GreeterToken)
              await bus.emit(Topics.CommandResult, {
                ok: true,
                output: g.greet('rem2'),
              })
            },
          ),
        )
        // Register an RPC responder (for IPC bridge requests).
        unsubs.push(
          bus.respond<
            { command: string; args?: unknown },
            { ok: boolean; output?: string; error?: string }
          >(Topics.CommandExecute, p => {
            if (!p || p.command !== 'hello') {
              return {
                ok: false,
                error: `Unknown command: ${p?.command ?? '(empty)'}`,
              }
            }
            const g = ctx.services.resolve(GreeterToken)
            return { ok: true, output: g.greet('rem2') }
          }),
        )

        // The single contribution entry point: the extension registry.
        ctx.extensions.contribute('command.provide', {
          contributionId: 'hello',
          impl: async (args: unknown) => {
            const g = ctx.services.resolve(GreeterToken)
            return {
              ok: true,
              output: g.greet(
                String((args as { name?: string })?.name ?? 'rem2'),
              ),
            }
          },
        })

        startedFlag = true
        ctx.log.info(
          `hello-command started (softdep config-json=${configPluginPresent})`,
        )
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        for (const u of unsubs) u()
        unsubs.length = 0
        startedFlag = false
        hookCtx.log.info(`hello-command stopped (${reason})`)
      },

      onUnload(hookCtx: PluginContext): void {
        hookCtx.api.unexport(GreeterToken)
      },

      onHealthCheck(): HealthStatus {
        if (!startedFlag || unsubs.length === 0) return 'degraded'
        return configPluginPresent ? 'healthy' : 'degraded'
      },
    }
  },
)

/** Token export for other plugins to resolve (same id as the kernel KernelTokens.EventBus). */
export type { EventBus }
