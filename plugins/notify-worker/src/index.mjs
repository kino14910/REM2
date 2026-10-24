/**
 * notify-worker plugin -- notifications are a plugin, and it runs in a
 * dedicated Worker thread (isolation: 'worker').
 *
 * It demonstrates:
 * 1. Worker isolation: this module runs in a separate Node Worker thread, so
 *    a crash or infinite loop does not affect the kernel.
 * 2. Context proxying: ctx.log / ctx.events / ctx.metrics / ctx.config reach
 *    the kernel cross-thread via RPC.
 * 3. Event-driven collaboration: subscribes to Topics.CommandResult (emitted by
 *    hello-command) and forwards it as a notification event.
 *
 * Shape: the only form is a default-exported factory function. There is no TS
 * compilation pipeline inside the Worker, so this file stays pure ESM (.mjs);
 * esbuild emits dist/index.js at build time.
 *
 * Note: Worker plugins have no ctx.services / ctx.api (they cannot be proxied
 * across threads); ctx.extensions only allows contributing log.sink /
 * metrics.sink / trace.exporter sinks.
 */

import { Topics } from 'rem2-kernel'

/** Notification event topics (subscribable by other plugins or the shell). */
const NotifyTopics = {
  Notified: 'notify:notified',
}

/** The only form: a factory function whose signature matches the kernel `PluginFactory`. */
export default function notifyWorkerPlugin(ctx) {
  const unsubs = []
  let notificationsSent = 0

  return {
    async onStart() {
      unsubs.push(
        ctx.events.on(Topics.CommandResult, async payload => {
          notificationsSent += 1
          const message = (payload && payload.output) || '(empty)'
          // Cross-thread event emission: routed through the Worker host RPC to the kernel bus.
          await ctx.events.emit(NotifyTopics.Notified, {
            message,
            at: Date.now(),
            seq: notificationsSent,
          })
          ctx.metrics
            .counter('notify.sent', { pluginId: 'com.rem2.notify-worker' })
            .add(1)
          ctx.log.info(`Notified: ${message}`)
        }),
      )
      ctx.log.info('notify-worker started in a dedicated Worker thread')
    },

    async onStop(_c, reason) {
      for (const u of unsubs) u()
      unsubs.length = 0
      ctx.log.info(`notify-worker stopped (${reason})`)
    },

    onHealthCheck() {
      return unsubs.length > 0 ? 'healthy' : 'degraded'
    },
  }
}
