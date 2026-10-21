import type {
  PermissionDecision,
  PermissionSet,
  TrustLevel,
  TrustPolicy,
} from '../contracts/permission.js'
import type { PluginManifest } from '../contracts/manifest.js'
import { DEFAULT_TRUST_POLICY, matchesAny } from './trust-policy.js'
import type { CapabilityGuard } from './capability-guard.js'

export class MutablePermissionSet implements PermissionSet {
  constructor(
    readonly pluginId: string,
    private grantedSet: Set<string>,
    private deniedSet: Set<string>,
  ) {}

  get granted(): readonly string[] {
    return Array.from(this.grantedSet).sort()
  }

  get denied(): readonly string[] {
    return Array.from(this.deniedSet).sort()
  }

  isGranted(capability: string): boolean {
    return this.grantedSet.has(capability)
  }

  grant(capability: string): void {
    this.grantedSet.add(capability)
    this.deniedSet.delete(capability)
  }

  revoke(capability: string): void {
    this.grantedSet.delete(capability)
    this.deniedSet.add(capability)
  }
}

export class PermissionManager {
  private readonly grants = new Map<string, MutablePermissionSet>()
  private readonly guard: CapabilityGuard | null

  constructor(
    guard?: CapabilityGuard,
    private readonly policy: TrustPolicy = DEFAULT_TRUST_POLICY,
  ) {
    this.guard = guard ?? null
  }

  get(pluginId: string): MutablePermissionSet | undefined {
    return this.grants.get(pluginId)
  }

  all(): MutablePermissionSet[] {
    return Array.from(this.grants.values())
  }

  /**
   * Compute the authorization decision for a plugin according to the trust policy.
   *
   * Rules:
   * - Capability matches `warnOn` -> recorded in warnings (denied by default under sandbox).
   * - Capability matches `defaults` -> granted.
   * - Anything else -> treated as requiring an explicit grant, denied by default.
   */
  check(manifest: PluginManifest, trustLevel: TrustLevel): PermissionDecision {
    const declared = manifest.requires ?? []
    const defaults = this.policy.defaults[trustLevel] ?? []
    const warnOn = this.policy.warnOn[trustLevel] ?? []

    const granted: string[] = []
    const denied: string[] = []
    const warnings: Array<{ capability: string; reason: string }> = []

    for (const cap of declared) {
      const isDefault = matchesAny(cap, defaults)
      const isSensitive = matchesAny(cap, warnOn)

      if (isDefault && !isSensitive) {
        granted.push(cap)
      } else if (isDefault && isSensitive) {
        // Sensitive capability: granted with a warning at the trusted level; denied with a warning at the sandbox level.
        if (trustLevel === 'trusted') {
          granted.push(cap)
          warnings.push({
            capability: cap,
            reason: 'sensitive capability granted at the trusted level',
          })
        } else {
          denied.push(cap)
          warnings.push({
            capability: cap,
            reason:
              'sensitive capability requires an explicit grant at the sandbox level',
          })
        }
      } else if (isSensitive) {
        denied.push(cap)
        warnings.push({
          capability: cap,
          reason: 'sensitive capability requires an explicit grant',
        })
      } else {
        // Unknown capability: denied by default under sandbox; granted at the trusted level (permissive).
        if (trustLevel === 'trusted') {
          granted.push(cap)
        } else {
          denied.push(cap)
        }
      }
    }

    const set = new MutablePermissionSet(
      manifest.id,
      new Set(granted),
      new Set(denied),
    )
    this.grants.set(manifest.id, set)
    this.guard?.registerPermissions(set)

    return {
      granted: set.granted.slice(),
      denied: set.denied.slice(),
      warnings,
    }
  }

  grant(pluginId: string, capability: string): void {
    const set = this.grants.get(pluginId)
    if (set) {
      set.grant(capability)
    } else {
      this.grants.set(
        pluginId,
        new MutablePermissionSet(pluginId, new Set([capability]), new Set()),
      )
    }
    const updated = this.grants.get(pluginId)!
    this.guard?.registerPermissions(updated)
  }

  revoke(pluginId: string, capability: string): void {
    const set = this.grants.get(pluginId)
    set?.revoke(capability)
  }

  /** Unregister all of a plugin's permission registrations (call on unload/reload to avoid leaking into CapabilityGuard). */
  unregister(pluginId: string): void {
    this.grants.delete(pluginId)
    this.guard?.unregisterPermissions(pluginId)
  }

  installGuard(): void {
    // The guard is injected at construction; this method is kept to explicitly express "already installed".
  }
}
