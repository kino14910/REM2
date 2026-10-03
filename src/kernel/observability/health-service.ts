/**
 * 健康服务（docs/02 §I.4，动机 #8）。
 *
 * 聚合各插件健康自检 + 内核自身状态。插件通过 `ctx.plugins` 或注册检查函数参与。
 */

import type {
  HealthCheckFn,
  HealthReport,
  HealthStatus,
  PluginHealthInfo,
} from '../contracts/health.js';
import type { PluginsRegistry } from '../registry/plugins-registry.js';

/** 聚合健康状态：任一 unhealthy → unhealthy；任一 degraded → degraded；否则 healthy。 */
function aggregate(statuses: HealthStatus[]): HealthStatus {
  if (statuses.length === 0) return 'healthy';
  if (statuses.includes('unhealthy')) return 'unhealthy';
  if (statuses.includes('degraded')) return 'degraded';
  return 'healthy';
}

/**
 * 健康服务。
 */
export class HealthService {
  private readonly checks = new Map<string, HealthCheckFn>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly kernelVersion: string,
    private readonly registry: PluginsRegistry,
  ) {}

  /** 注册某插件的健康自检。 */
  registerCheck(pluginId: string, fn: HealthCheckFn): void {
    this.checks.set(pluginId, fn);
  }

  /** 注销。 */
  unregisterCheck(pluginId: string): void {
    this.checks.delete(pluginId);
  }

  /**
   * 生成健康报告。
   *
   * - 对每个已加载插件：若有自检函数则调用（错误/超时 → unhealthy），否则回落到状态映射。
   * - 汇总内核状态。
   */
  async report(): Promise<HealthReport> {
    const plugins: PluginHealthInfo[] = [];

    for (const loaded of this.registry.allLoaded()) {
      const id = loaded.manifest.id;
      let status: HealthStatus;
      let message: string | undefined;

      const check = this.checks.get(id);
      if (check) {
        try {
          status = await check();
        } catch (e) {
          status = 'unhealthy';
          message = (e as Error).message;
        }
      } else {
        status = mapStateToHealth(loaded.state);
        message = loaded.health.message;
      }

      plugins.push({
        id,
        state: loaded.state,
        status,
        ...(message ? { message } : {}),
      });
    }

    const overall = aggregate(plugins.map((p) => p.status));

    return {
      status: overall,
      kernel: {
        version: this.kernelVersion,
        uptimeMs: Date.now() - this.startedAt,
      },
      plugins,
    };
  }
}

/** 插件状态 → 健康状态映射。 */
function mapStateToHealth(state: string): HealthStatus {
  switch (state) {
    case 'Started':
      return 'healthy';
    case 'Degraded':
      return 'degraded';
    case 'Failed':
      return 'unhealthy';
    case 'Configured':
    case 'Loaded':
    case 'Discovered':
      return 'degraded';
    case 'Stopped':
    case 'Unloaded':
    case 'Disposed':
      return 'degraded';
    default:
      return 'degraded';
  }
}
