export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface PluginHealthInfo {
  id: string
  state: string
  status: HealthStatus
  message?: string
}

export interface HealthReport {
  status: HealthStatus
  kernel: { version: string; uptimeMs: number }
  plugins: PluginHealthInfo[]
}

export type HealthCheckFn = () => Promise<HealthStatus> | HealthStatus
