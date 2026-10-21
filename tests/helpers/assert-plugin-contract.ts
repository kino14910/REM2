/**
 * Test helper: assert a plugin's hook set conforms to the contract.
 *
 * In the single-shape form plugins no longer have `instance.manifest`, so the
 * inputs are "the manifest from plugin.json" + "the hook set produced by the
 * factory".
 */

import { expect } from 'vitest'
import type { PluginFactoryHooks, PluginManifest } from 'rem2-kernel'

/**
 * Asserts:
 * - manifest has id/name/version/entry/compatibility, and entry is a build artifact;
 * - at least one optional hook is implemented.
 */
export function assertPluginContract(
  hooks: PluginFactoryHooks,
  manifest: PluginManifest,
  expectedId?: string,
): void {
  expect(hooks).toBeDefined()
  expect(typeof hooks).toBe('object')
  expect(manifest.id.length).toBeGreaterThan(0)
  expect(typeof manifest.name).toBe('string')
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
  expect(typeof manifest.entry).toBe('string')
  // Single-shape form: entry must be a build artifact.
  expect(manifest.entry).toMatch(/\.(js|mjs)$/)
  expect(manifest.compatibility.contractVersion).toBe('string')
  expect(manifest.compatibility.minKernel).toBe('string')

  if (expectedId !== undefined) {
    expect(manifest.id).toBe(expectedId)
  }

  expect(implementedHooks(hooks).length).toBeGreaterThan(0)
}

const HOOK_NAMES = [
  'onDiscover',
  'onLoad',
  'onConfigure',
  'onStart',
  'onStop',
  'onUnload',
  'onDispose',
  'onHealthCheck',
] as const

/** List the hooks implemented by a plugin. */
export function implementedHooks(hooks: PluginFactoryHooks): string[] {
  return HOOK_NAMES.filter(
    h => typeof (hooks as unknown as Record<string, unknown>)[h] === 'function',
  )
}
