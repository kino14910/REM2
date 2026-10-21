import type { PluginFactory } from '../contracts/plugin.js'
import type { PluginManifestInit } from '../contracts/manifest.js'

/** Inline manifest attached to the factory by `definePlugin`. */
export type PluginFactoryWithManifest = PluginFactory & {
  readonly manifest: PluginManifestInit
}

/** Asserts a dynamically imported module exports the one supported factory shape. */
export function assertPluginFactory(
  moduleExports: unknown,
  pluginId: string,
): PluginFactoryWithManifest {
  const mod = moduleExports as { default?: unknown } | null
  const candidate = mod?.default

  if (typeof candidate !== 'function') {
    throw new TypeError(
      `plugin ${pluginId} must export default definePlugin(manifest, setup) (default must be a function, received ${
        candidate === undefined ? 'undefined' : typeof candidate
      })`,
    )
  }

  return candidate as PluginFactoryWithManifest
}

/** Reads the inline manifest id carried by the factory (for drift detection against `plugin.json`). */
export function inlineManifestId(
  factory: PluginFactoryWithManifest,
): string | undefined {
  const manifest = factory.manifest
  return manifest && typeof manifest.id === 'string' ? manifest.id : undefined
}
