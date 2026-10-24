/**
 * plugin-inspector -- the runtime inspector is itself a plugin (dogfooding).
 *
 * - Contributes a panel + a route into the `ui.panel` / `ui.route` slots;
 *   the shell renders the chrome, this plugin only supplies data.
 * - Serves the panel's data over a private topic: a table of every loaded
 *   plugin with its state and health, which exercises the panel data path
 *   end to end without any host-side hardcoding.
 * - On an interaction event (`kind: 'refresh'`) it re-snapshots and pushes
 *   the new table via `Topics.PanelDataChanged`, demonstrating the push path.
 */

import { definePlugin, defineToken, KernelTokens, Topics } from 'rem2-kernel'
import type {
  HealthReport,
  PanelContribution,
  PluginContext,
  RouteContribution,
  Unsubscribe,
} from 'rem2-kernel'

/** Private data topic (reverse-DNS prefix: no collision with kernel topics). */
const DATA_TOPIC = 'com.rem2.plugin-inspector.data'

const PANEL_ID = 'plugin-inspector'
const ROUTE_PATH = '/plugins'

const COLUMNS = ['id', 'name', 'version', 'state', 'health', 'message'] as const

/** Minimal structured panel-data contract (the only shape PanelShell renders as a table). */
interface PluginTable {
  kind: 'table'
  columns: string[]
  rows: Array<Array<string | number>>
}

/** Minimal structural type for the kernel HealthService (same id as KernelTokens.Health). */
interface HealthServiceLike {
  report(): Promise<HealthReport>
}

const HealthServiceToken = defineToken<HealthServiceLike>({
  id: KernelTokens.Health.id,
  describe: 'Kernel health service',
})

export default definePlugin(
  {
    id: 'com.rem2.plugin-inspector',
    name: 'Plugin Inspector',
    version: '1.0.0',
  },
  (ctx: PluginContext) => {
    let unsub: Unsubscribe | null = null
    let health: HealthServiceLike | null = null
    let contributed = 0

    /**
     * Snapshot every loaded plugin with its health column.
     *
     * Health is best-effort: an unavailable or failing HealthService must not
     * fail the panel data request (the framework's error path covers real
     * failures), so the column degrades to 'unknown' instead. The report is
     * fetched once per snapshot and indexed by id — one report() call runs
     * every plugin's onHealthCheck, so calling it per row would be O(n²).
     */
    async function buildTable(): Promise<PluginTable> {
      const healthById = new Map<string, { status: string; message: string }>()
      if (health) {
        try {
          const report = await health.report()
          for (const h of report.plugins) {
            healthById.set(h.id, { status: h.status, message: h.message ?? '' })
          }
        } catch {
          // Degrade the whole column to 'unknown'; never fail the panel.
        }
      }
      const rows = ctx.plugins.all().map(p => {
        const h = healthById.get(p.id)
        return [
          p.id,
          p.name,
          p.version,
          p.state,
          h?.status ?? 'unknown',
          h?.message ?? '',
        ]
      })
      return { kind: 'table', columns: [...COLUMNS], rows }
    }

    /** Data + interaction responder for this panel's private topic. */
    async function handler(payload: unknown): Promise<unknown> {
      const kind = (payload as { kind?: unknown } | null)?.kind
      if (typeof kind === 'string') {
        // Interaction event (e.g. the shell's refresh button).
        if (kind === 'refresh') {
          await ctx.events.emit(Topics.PanelDataChanged, {
            panelId: PANEL_ID,
            data: await buildTable(),
          })
        }
        return { ok: true }
      }
      // Data request (payload shape: { panelId }).
      return await buildTable()
    }

    return {
      async onStart(): Promise<void> {
        // Optional facility: without it the health column degrades to 'unknown'.
        health = ctx.services.tryResolve(HealthServiceToken) ?? null

        ctx.extensions.contribute<PanelContribution>('ui.panel', {
          contributionId: PANEL_ID,
          impl: {
            panelId: PANEL_ID,
            title: 'Plugin Inspector',
            icon: '🔍',
            region: 'main',
            order: 10,
            command: DATA_TOPIC,
          },
        })
        ctx.extensions.contribute<RouteContribution>('ui.route', {
          contributionId: ROUTE_PATH,
          impl: {
            path: ROUTE_PATH,
            title: 'Plugins',
            panelId: PANEL_ID,
            commandPrefix: '',
            order: 10,
          },
        })
        unsub = ctx.events.respond(DATA_TOPIC, handler)
        contributed = 2
        ctx.log.info('plugin-inspector started (panel + route contributed)')
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        unsub?.()
        unsub = null
        contributed = 0
        hookCtx.log.info(`plugin-inspector stopped (${reason})`)
      },

      onHealthCheck(): 'healthy' | 'degraded' {
        return contributed === 2 ? 'healthy' : 'degraded'
      },
    }
  },
)
