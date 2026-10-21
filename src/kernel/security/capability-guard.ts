/**
 * Capability proxy: the third stage of the three-stage model (manifest declaration -> authorization -> interception).
 *
 * CapabilityGuard wraps service resolution: when a service declares a required capability,
 * it verifies that the calling plugin has been granted that capability; unauthorized
 * callers get a CapabilityDeniedError (deny rather than silently degrade).
 */

import type { PermissionSet } from '../contracts/permission.js'
import { CapabilityDeniedError } from '../errors.js'

export class CapabilityGuard {
  /** Service id -> required capability. Registered by the kernel during the authorization phase. */
  private readonly serviceCapabilities = new Map<string, string>()
  private readonly permissionLookup = new Map<string, PermissionSet>()
  /** Denial count (exposed for metrics and tests). */
  private deniedCount = 0

  declareServiceCapability(serviceId: string, capability: string): void {
    this.serviceCapabilities.set(serviceId, capability)
  }

  retractServiceCapability(serviceId: string): void {
    this.serviceCapabilities.delete(serviceId)
  }

  registerPermissions(set: PermissionSet): void {
    this.permissionLookup.set(set.pluginId, set)
  }

  unregisterPermissions(pluginId: string): void {
    this.permissionLookup.delete(pluginId)
  }

  /**
   * Assert that the caller is authorized to access a service.
   *
   * @param serviceId Service token id
   * @param callerPluginId Calling plugin id (pass 'kernel' for kernel-internal calls)
   * @throws CapabilityDeniedError if and only if the service declares a capability the caller has not been granted
   */
  assert(serviceId: string, callerPluginId: string): void {
    const capability = this.serviceCapabilities.get(serviceId)
    if (!capability) return // Services without a declared capability are public

    // The kernel itself is always allowed.
    if (callerPluginId === 'kernel') return

    const perms = this.permissionLookup.get(callerPluginId)
    if (!perms || !perms.isGranted(capability)) {
      this.deniedCount += 1
      throw new CapabilityDeniedError(capability, callerPluginId)
    }
  }

  /** Assert a capability directly (for imperative capability checks, e.g. net.listen). */
  assertCapability(capability: string, callerPluginId: string): void {
    if (callerPluginId === 'kernel') return
    const perms = this.permissionLookup.get(callerPluginId)
    if (!perms || !perms.isGranted(capability)) {
      this.deniedCount += 1
      throw new CapabilityDeniedError(capability, callerPluginId)
    }
  }

  get deniedTotal(): number {
    return this.deniedCount
  }
}
