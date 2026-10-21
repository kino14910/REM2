/**
 * `definePlugin()`: the single entry point for the plugin shape.
 *
 * A factory function is the only shape that is at once tree-shaking
 * friendly (setup is a closure), needs only a tiny loader assertion, and
 * aligns with esbuild ESM. Classes, pre-instantiated singletons and named
 * exports each have their own drawbacks.
 */

import type { PluginManifestInit } from './contracts/manifest.js'
import type { PluginContext } from './contracts/context.js'
import type { PluginFactory, PluginFactoryHooks } from './contracts/plugin.js'
import { ManifestError } from './errors.js'

/**
 * Declares a plugin.
 *
 * @param manifest Inline plugin manifest (the authoritative source for
 *                 `entry` is `plugin.json`; it may be omitted).
 * @param setup    Hook factory: the kernel calls it after import and
 *                 passes the `PluginContext`.
 */
export function definePlugin(
  manifest: PluginManifestInit,
  setup: (ctx: PluginContext) => PluginFactoryHooks,
): PluginFactory {
  if (
    !manifest ||
    typeof manifest.id !== 'string' ||
    manifest.id.trim() === ''
  ) {
    throw new ManifestError([
      'definePlugin requires manifest.id to be a non-empty string',
    ])
  }
  if (typeof setup !== 'function') {
    throw new TypeError(`setup of plugin ${manifest.id} must be a function`)
  }

  const factory = function rem2Plugin(ctx: PluginContext): PluginFactoryHooks {
    return setup(ctx)
  } as PluginFactory

  // The inline manifest is attached to the factory so the loader can check
  // it for drift against plugin.json, without forcing plugins to export a
  // named member just to expose the id.
  //
  // Order matters: defineProperty must run before freeze. Reversing them
  // throws "Cannot define property manifest, object is not extensible" —
  // an error that only surfaces when the kernel actually loads a plugin,
  // never while authoring it.
  Object.defineProperty(factory, 'manifest', {
    value: Object.freeze({ ...manifest }),
    enumerable: true,
  })

  return Object.freeze(factory) as PluginFactory
}
