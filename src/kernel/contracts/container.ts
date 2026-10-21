/**
 * Container contract.
 *
 * The implementation lives in `src/kernel/di/container.ts`; this file only
 * declares the interface, keeping the contract layer decoupled from the
 * implementation layer.
 */

import type { ServiceRegistry } from './service.js'

/**
 * DI container contract.
 *
 * Hard rules:
 * 1. A plugin container's `parent` is invisible to the plugin (the
 *    implementation keeps it private).
 * 2. Services registered by a plugin do not leak into the parent container
 *    by default; they must be exported explicitly.
 */
export interface Container extends ServiceRegistry {
  /** Scope name, e.g. 'root' / 'plugin:com.rem2.hello-command'. */
  readonly scope: string
  /** Whether a parent container exists (the parent reference itself is not exposed). */
  readonly hasParent: boolean

  createChild(scope: string): Container
  dispose(): void
}
