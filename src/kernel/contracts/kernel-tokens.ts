/**
 * Kernel service tokens: the shared language between kernel and plugins.
 *
 * They describe service identity only, not implementations. `Scheduler`
 * points at the implementation layer's `Scheduler` interface — the only
 * place where this contract layer references an implementation type,
 * because the scheduler is a replaceable port whose shape is itself the
 * contract.
 */

import { defineToken } from './service-token.js'
import type { Scheduler } from '../scheduler/scheduler.js'

export const KernelTokens = {
  EventBus: defineToken<import('./event-bus.js').EventBus>({
    id: 'kernel.event-bus',
    describe: 'global event bus',
  }),
  Config: defineToken<import('./config.js').ConfigAccess>({
    id: 'kernel.config',
    describe: 'read-only config access',
  }),
  ConfigService: defineToken<import('./config.js').ConfigAccess>({
    id: 'kernel.config-service',
    describe: 'config service (including provider management)',
  }),
  Log: defineToken<unknown>({
    id: 'kernel.log',
    describe: 'log service',
  }),
  Metrics: defineToken<import('./metrics.js').MetricsApi>({
    id: 'kernel.metrics',
    describe: 'metrics service',
  }),
  Tracer: defineToken<import('./tracing.js').Tracer>({
    id: 'kernel.tracer',
    describe: 'tracing service (span collection and export)',
  }),
  Health: defineToken<unknown>({
    id: 'kernel.health',
    describe: 'health service',
  }),
  Permissions: defineToken<unknown>({
    id: 'kernel.permissions',
    describe: 'permission manager',
  }),
  Plugins: defineToken<import('./plugins.js').PluginsRegistryView>({
    id: 'kernel.plugins',
    describe: 'plugin registry view',
  }),
  Scheduler: defineToken<Scheduler>({
    id: 'kernel.scheduler',
    describe:
      'scheduler (replaceable via the scheduler.replace extension point)',
  }),
  Resolver: defineToken<unknown>({
    id: 'kernel.resolver',
    describe:
      'dependency resolver (replaceable via the resolver.replace extension point)',
  }),
  Discovery: defineToken<unknown>({
    id: 'kernel.discovery',
    describe: 'plugin discovery',
  }),
  Loader: defineToken<unknown>({
    id: 'kernel.loader',
    describe:
      'plugin loader (replaceable via the loader.replace extension point)',
  }),
  CapabilityGuard: defineToken<unknown>({
    id: 'kernel.capability-guard',
    describe: 'capability guard',
  }),
  Extensions: defineToken<unknown>({
    id: 'kernel.extensions',
    describe: 'extension point registry',
  }),
  /**
   * Host-provided UI service: theme registry (catalog + active selection, behind the
   * host default implementation of the `ui.theme` slot).
   */
  UiThemeRegistry: defineToken<import('./ui.js').ThemeRegistry>({
    id: 'host.ui.theme-registry',
    describe: 'host theme registry',
    capability: 'ui.theme',
  }),
} as const

export type KernelToken = (typeof KernelTokens)[keyof typeof KernelTokens]
