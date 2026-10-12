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
import type { ExtensionPointRegistry } from '../extensions/registry.js';

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
    private readonly extensions: ExtensionPointRegistry,
  ) {}

  /**
   * 健康自检的**唯一读取口**是 `health.check` 扩展点。
   *
   * 旧实现有 `registerCheck` 这个旁路入口，等于绕过了 P3 的扩展点注册表。
   * 现在贡献只经 `ctx.extensions.contribute('health.check', …)`，本类只负责读。
   */
  private checksOf(): Map<string, HealthCheckFn> {
    const out = new Map<string, HealthCheckFn>();
    if (!this.extensions.has('health.check')) return out;
    for (const e of this.extensions.entries<HealthCheckFn>('health.check')) {
      out.set(e.pluginId, e.impl);
    }
    return out;
  }

  /** 注销（保留为幂等空操作：回收已由 `extensions.retractAll` 统一完成）。 */
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
    const checks = this.checksOf();

    for (const loaded of this.registry.allLoaded()) {
      const id = loaded.manifest.id;
      let status: HealthStatus;
      let message: string | undefined;

      const check = checks.get(id);
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

/** 插件状态 → 健康状态映射（新状态机）。 */
function mapStateToHealth(state: string): HealthStatus {
  switch (state) {
    case 'Active':
      return 'healthy';
    case 'Failed':
      return 'unhealthy';
    case 'Degraded':
      return 'degraded';
    default:
      return 'degraded';
  }
}
