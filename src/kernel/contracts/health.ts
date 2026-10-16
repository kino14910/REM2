/**
 * 健康检查契约（纯类型）。见 docs/01
 */

/** 健康状态。 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/** 单个插件的健康信息。 */
export interface PluginHealthInfo {
  id: string;
  state: string;
  status: HealthStatus;
  message?: string;
}

/** 整体健康报告。 */
export interface HealthReport {
  status: HealthStatus;
  kernel: { version: string; uptimeMs: number };
  plugins: PluginHealthInfo[];
}

/** 健康自检函数。 */
export type HealthCheckFn = () => Promise<HealthStatus> | HealthStatus;
