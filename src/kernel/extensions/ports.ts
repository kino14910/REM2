/**
 * Replaceable ports (contract side of the `*.replace` extension points).
 *
 * Ports are abstracted instead of referencing implementation classes so definitions.ts
 * can declare scheduler.replace / resolver.replace / loader.replace without importing
 * the implementation layer.
 */

import type { Candidate } from '../discovery/candidate.js'
import type { PluginLoaderOptions, LoadedPlugin } from './ports-types.js'

/** Command handler (contribution type for the `command.provide` extension point). */
export type CommandHandler = (args: unknown) => Promise<unknown> | unknown

/** Dependency resolver port (contribution type for `resolver.replace`). */
export interface DependencyResolverPort {
  resolve(
    candidates: Candidate[],
    opts: {
      kernelVersion: string
      contractVersion: string
      onError?: 'strict' | 'graceful'
    },
  ): {
    loadOrder: string[]
    steps: Array<{ candidate: Candidate; missingOptional: string[] }>
    issues: Array<{
      code: string
      level: 'error' | 'warn'
      pluginId: string
      detail: string
    }>
    dropped: string[]
  }
}

/** Plugin loader port (contribution type for `loader.replace`). */
export interface PluginLoaderPort {
  load(
    candidate: Candidate,
    options?: PluginLoaderOptions,
  ): Promise<LoadedPlugin>
}
