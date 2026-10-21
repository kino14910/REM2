import type {
  HealthCheckFn,
  HealthReport,
  HealthStatus,
  PluginHealthInfo,
} from '../contracts/health.js'
import type { PluginsRegistry } from '../registry/plugins-registry.js'
import type { ExtensionPointRegistry } from '../extensions/registry.js'

function aggregate(statuses: HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'healthy'
  if (statuses.includes('unhealthy')) return 'unhealthy'
  if (statuses.includes('degraded')) return 'degraded'
  return 'healthy'
}

export class HealthService {
  private readonly checks = new Map<string, HealthCheckFn>()
  private readonly startedAt = Date.now()

  constructor(
    private readonly kernelVersion: string,
    private readonly registry: PluginsRegistry,
    private readonly extensions: ExtensionPointRegistry,
  ) {}

  /**
   * The only read path for health checks is the `health.check` extension
   * point: contributions arrive via `ctx.extensions.contribute(...)` and
   * this class only reads them.
   */
  private checksOf(): Map<string, HealthCheckFn> {
    const out = new Map<string, HealthCheckFn>()
    if (!this.extensions.has('health.check')) return out
    for (const e of this.extensions.entries<HealthCheckFn>('health.check')) {
      out.set(e.pluginId, e.impl)
    }
    return out
  }

  /** Unregister (kept as an idempotent no-op; reclamation is handled by `extensions.retractAll`). */
  unregisterCheck(pluginId: string): void {
    this.checks.delete(pluginId)
  }

  async report(): Promise<HealthReport> {
    const plugins: PluginHealthInfo[] = []
    const checks = this.checksOf()

    for (const loaded of this.registry.allLoaded()) {
      const id = loaded.manifest.id
      let status: HealthStatus
      let message: string | undefined

      const check = checks.get(id)
      if (check) {
        try {
          status = await check()
        } catch (e) {
          status = 'unhealthy'
          message = (e as Error).message
        }
      } else {
        status = mapStateToHealth(loaded.state)
        message = loaded.health.message
      }

      plugins.push({
        id,
        state: loaded.state,
        status,
        ...(message ? { message } : {}),
      })
    }

    const overall = aggregate(plugins.map(p => p.status))

    return {
      status: overall,
      kernel: {
        version: this.kernelVersion,
        uptimeMs: Date.now() - this.startedAt,
      },
      plugins,
    }
  }
}

function mapStateToHealth(state: string): HealthStatus {
  switch (state) {
    case 'Active':
      return 'healthy'
    case 'Failed':
      return 'unhealthy'
    case 'Degraded':
      return 'degraded'
    default:
      return 'degraded'
  }
}
