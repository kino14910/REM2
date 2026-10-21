/**
 * Single source of truth for which extension points exist.
 *
 * Mirrors the full table in docs/01 §4.1 id-for-id, enforced by
 * tests/contract/extension-points.test.ts.
 *
 * Field semantics:
 * - `multi`: multiple contribution slots (false = singleton slot; conflicts resolved by `conflict`).
 * - `hasHostDefault`: whether the host registers a default implementation before startup (pluginId = 'kernel').
 * - `conflict`: only meaningful for singleton slots; no implicit default is allowed.
 * - `capability`: capability a plugin must already hold to contribute to this extension point.
 */

import type { ExtensionPointDef } from '../contracts/extension-point.js'
import type {
  LogSink,
  MetricSink,
  TraceExporter,
  ConfigProvider,
  HealthCheckFn,
  ThemeDefinition,
  PanelContribution,
  RouteContribution,
} from '../contracts/index.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import type {
  CommandHandler,
  DependencyResolverPort,
  PluginLoaderPort,
} from './ports.js'

/** Extension point definitions (ordered; order is the output order of registry.list()). */
export const EXTENSION_POINT_DEFS = [
  {
    id: 'log.sink',
    describe: 'Log output destination (console / file / remote)',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
  },
  {
    id: 'metrics.sink',
    describe: 'Metrics export destination',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
  },
  {
    id: 'trace.exporter',
    describe: 'Span exporter (otlp / console)',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
  },
  {
    id: 'config.provider',
    describe: 'Config layer (json / env / remote)',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
    capability: 'config.provide',
  },
  {
    id: 'command.provide',
    describe: 'Business command handler (deduplicated by command name)',
    multi: true,
    hasHostDefault: false,
    conflict: 'reject-new',
    capability: 'command.provide',
  },
  {
    id: 'health.check',
    describe: 'Plugin health self-check function',
    multi: true,
    hasHostDefault: false,
    conflict: 'keep-first',
  },
  {
    id: 'ui.theme',
    describe:
      'Theme token definitions (catalog: all resident themes; the host picks the active one)',
    multi: true,
    hasHostDefault: true,
    conflict: 'reject-new',
    capability: 'ui.theme',
  },
  {
    id: 'ui.panel',
    describe: 'Declarative UI panel description (chrome rendered by the host)',
    multi: true,
    hasHostDefault: true,
    conflict: 'reject-new',
    capability: 'ui.panel',
  },
  {
    id: 'ui.route',
    describe: 'Declarative UI route',
    multi: true,
    hasHostDefault: false,
    conflict: 'replace-old',
    capability: 'ui.route',
  },
  {
    id: 'scheduler.replace',
    describe: 'Replace the kernel scheduler (parallel / per-queue)',
    multi: false,
    hasHostDefault: true,
    conflict: 'replace-old',
    capability: 'kernel.internals',
  },
  {
    id: 'resolver.replace',
    describe: 'Replace the dependency resolution strategy',
    multi: false,
    hasHostDefault: true,
    conflict: 'replace-old',
    capability: 'kernel.internals',
  },
  {
    id: 'loader.replace',
    describe: 'Replace the loading mechanism (e.g. pulling from a registry)',
    multi: false,
    hasHostDefault: true,
    conflict: 'replace-old',
    capability: 'kernel.internals',
  },
] as const satisfies readonly ExtensionPointDef<unknown>[]

export const EXTENSION_POINT_IDS = EXTENSION_POINT_DEFS.map(
  d => d.id,
) as readonly ExtensionPointDef<unknown>['id'][]

/**
 * Maps extension point ids to their contribution implementation types.
 *
 * A separate table instead of putting `__type` on each `def`: the def array needs
 * `as const satisfies` to preserve literal ids, and after generic erasure each
 * entry cannot carry its own `T`.
 */
export interface ExtensionPointImplMap {
  'log.sink': LogSink
  'metrics.sink': MetricSink
  'trace.exporter': TraceExporter
  'config.provider': ConfigProvider
  'command.provide': CommandHandler
  'health.check': HealthCheckFn
  'ui.theme': ThemeDefinition
  'ui.panel': PanelContribution
  'ui.route': RouteContribution
  'scheduler.replace': Scheduler
  'resolver.replace': DependencyResolverPort
  'loader.replace': PluginLoaderPort
}

/** Looks up a definition by id (used at startup by defineAll). */
export function findExtensionPointDef(
  id: string,
): ExtensionPointDef<unknown> | undefined {
  return EXTENSION_POINT_DEFS.find(d => d.id === id)
}
