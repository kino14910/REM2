/**
 * Plugin state and registry view contracts.
 *
 * `PLUGIN_STATES` + `PluginStateT` are the single source of truth for
 * plugin states: a real enum is a runtime object (it would pull runtime
 * values into the bundle) and would duplicate the state definitions.
 */

import type { PluginManifest } from './manifest.js'

/** All states of the logical state machine (ordered; the index roughly follows the transition order). */
export const PLUGIN_STATES = [
  'Registered',
  'Resolved',
  'Dropped',
  'Loaded',
  'Initialized',
  'Configured',
  'Active',
  'Degraded',
  'Failed',
  'Stopped',
  'Unloaded',
  'Disposed',
] as const

/** Plugin state (the single-source string union). */
export type PluginStateT = (typeof PLUGIN_STATES)[number]

/** Terminal states: no outgoing transitions. */
export const TERMINAL_STATES: readonly PluginStateT[] = ['Dropped', 'Disposed']

/** Publicly visible plugin summary. */
export interface PluginInfo {
  id: string
  name: string
  version: string
  state: PluginStateT
  manifest: PluginManifest
}

/** Plugins view: lets a plugin probe other plugins and read read-only information at runtime. */
export interface PluginsRegistryView {
  /** Whether a plugin exists (the main entry point for soft-dependency probing). */
  has(pluginId: string): boolean
  /** Whether a plugin has reached the Active state. */
  isStarted(pluginId: string): boolean
  get(pluginId: string): PluginInfo | undefined
  all(): PluginInfo[]
  byState(state: PluginStateT): PluginInfo[]
}
