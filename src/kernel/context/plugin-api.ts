/**
 * Plugin API implementation: service export and resolution (constrained by the capability guard).
 *
 * Security invariant: plugins must never obtain a reference to the parent container,
 * so "mount back onto the root container after export" is performed by the kernel
 * through the injected `hooks`; the plugin API itself neither holds nor reads the
 * parent container.
 */

import type { PluginApi, ExportOptions } from '../contracts/context.js'
import type { ServiceToken } from '../contracts/service-token.js'
import type { Container } from '../di/container.js'
import type { CapabilityGuard } from '../security/capability-guard.js'

/** Mounting hooks injected by the kernel (the kernel owns the root container and performs the mounting). */
export interface PluginApiHooks {
  /** Mounts the plugin child container onto the parent container so other plugins can resolve its exports. */
  mountExported(child: Container): void
  /** Unmounts the plugin child container (when it no longer exports any service). */
  unmountExported(child: Container): void
}

export class PluginApiImpl implements PluginApi {
  constructor(
    private readonly pluginId: string,
    private readonly container: Container,
    private readonly guard: CapabilityGuard,
    private readonly hooks: PluginApiHooks,
  ) {}

  export<T>(token: ServiceToken<T>, opts?: ExportOptions): void {
    // 1) Mark this service as exported (parent-container resolution can descend into the child container).
    this.container.markExported(token)
    // 2) Reverse mount: the kernel mounts this child container onto the parent container so sibling plugins can resolve it too.
    this.hooks.mountExported(this.container)
    // 3) Register the capability this service requires (consumers are proxy-checked at resolution time).
    if (opts?.capability) {
      this.guard.declareServiceCapability(token.id, opts.capability)
    }
  }

  unexport<T>(token: ServiceToken<T>): void {
    this.container.markUnexported(token)
    this.guard.retractServiceCapability(token.id)
    // Only unmount once this container has no exported services left, to avoid affecting other exported services in the same container.
    if (!this.container.hasExports()) {
      this.hooks.unmountExported(this.container)
    }
  }

  useCapability<T>(token: ServiceToken<T>): T {
    // Check the capability guard first (unauthorized -> CapabilityDeniedError; never silently allowed).
    this.guard.assert(token.id, this.pluginId)
    // Resolution order: own container, then delegate up to the parent container (which holds mounted sibling-plugin exports).
    return this.container.resolve(token)
  }
}
