/**
 * Invariants enforced by this registry:
 * 1. Unknown point id -> `UnknownExtensionPointError` (never silent).
 * 2. Capability not granted -> `CapabilityDeniedError` (contribution points also check capabilities).
 * 3. Single-slot conflict -> adjudicated explicitly per the definition's `conflict` policy;
 *    rejected entries are recorded in `issues`.
 */

import type {
  ExtensionPointDef,
  ExtensionPointId,
  ExtensionPointSummary,
  ExtensionContribution,
} from '../contracts/extension-point.js'
import type { PermissionManager } from '../security/permission-manager.js'
import {
  MultiContributionSlot,
  SingleContributionSlot,
  type SlotEntry,
} from './contrib-slot.js'
import {
  CapabilityDeniedError,
  ExtensionConflictError,
  UnknownExtensionPointError,
} from '../errors.js'

/** pluginId used for host default implementations (a convention value, not a real plugin). */
export const HOST_PLUGIN_ID = 'kernel'

/** Record of a rejected contribution (non-throwing adjudication result, for health/CLI observability). */
export interface ExtensionIssue {
  point: ExtensionPointId
  contributionId: string
  pluginId: string
  reason: string
}

export interface ExtensionPointRegistryOptions {
  /** Capability check used when contributing (validates the point's required capability). */
  permissions?: PermissionManager
}

export class ExtensionPointRegistry {
  private readonly defs = new Map<
    ExtensionPointId,
    ExtensionPointDef<unknown>
  >()
  private readonly multiSlots = new Map<
    ExtensionPointId,
    MultiContributionSlot<unknown>
  >()
  private readonly singleSlots = new Map<
    ExtensionPointId,
    SingleContributionSlot<unknown>
  >()
  /** pluginId -> set of extension point ids occupied by that plugin (index for forced reclamation). */
  private readonly byPlugin = new Map<string, Set<ExtensionPointId>>()
  private readonly issues: ExtensionIssue[] = []
  private readonly permissions: PermissionManager | null

  constructor(opts: ExtensionPointRegistryOptions = {}) {
    this.permissions = opts.permissions ?? null
  }

  /** Register an extension point definition (called once during startup). */
  define<T>(def: ExtensionPointDef<T>): void {
    if (this.defs.has(def.id)) {
      throw new ExtensionConflictError(def.id, '(define)', HOST_PLUGIN_ID)
    }
    this.defs.set(def.id, def as ExtensionPointDef<unknown>)
    if (def.multi) {
      this.multiSlots.set(def.id, new MultiContributionSlot<unknown>())
    } else {
      this.singleSlots.set(def.id, new SingleContributionSlot<unknown>())
    }
  }

  /** Bulk definition (entry point used by `definitions.ts`). */
  defineAll(defs: readonly ExtensionPointDef<unknown>[]): void {
    for (const def of defs) this.define(def)
  }

  has(point: ExtensionPointId): boolean {
    return this.defs.has(point)
  }

  /** Host contributes a default implementation (startup-time; pluginId is always 'kernel'). */
  registerHostDefault<T>(
    point: ExtensionPointId,
    contribution: ExtensionContribution<T>,
  ): void {
    this.contribute(HOST_PLUGIN_ID, point, contribution)
  }

  /**
   * Plugin contribution.
   *
   * Flow: (1) is the point defined? (2) is the capability granted? (3) slot conflict adjudication?
   * Any failure throws `UnknownExtensionPointError` / `CapabilityDeniedError` /
   * `ExtensionConflictError`; a `keep-first` rejection does not throw - it records an issue
   * instead (the contribution is dropped).
   */
  contribute<T>(
    pluginId: string,
    point: ExtensionPointId,
    contribution: ExtensionContribution<T>,
  ): void {
    const def = this.defs.get(point)
    if (!def) throw new UnknownExtensionPointError(point)

    if (def.capability) {
      const set = this.permissions?.get(pluginId)
      const granted = set
        ? set.isGranted(def.capability)
        : pluginId === HOST_PLUGIN_ID
      if (!granted) {
        // Reuse the kernel's rejection semantics: throw CapabilityDeniedError instead of silently dropping.
        throw new CapabilityDeniedError(def.capability, pluginId)
      }
    }

    const entry: SlotEntry<unknown> = {
      contributionId: contribution.contributionId,
      pluginId,
      impl: contribution.impl,
    }

    if (def.multi) {
      const slot = this.multiSlots.get(point)
      if (!slot) throw new UnknownExtensionPointError(point)
      if (slot.has(contribution.contributionId)) {
        const holder = slot
          .list()
          .find(e => e.contributionId === contribution.contributionId)
        throw new ExtensionConflictError(
          point,
          contribution.contributionId,
          holder?.pluginId,
        )
      }
      slot.add(entry)
    } else {
      const slot = this.singleSlots.get(point)
      if (!slot) throw new UnknownExtensionPointError(point)
      if (!slot.isEmpty) {
        const holderPluginId = slot.activePluginId
        switch (def.conflict) {
          case 'keep-first':
            this.issues.push({
              point,
              contributionId: contribution.contributionId,
              pluginId,
              reason: `extension point ${point} is a singleton slot with the keep-first policy this contribution was rejected (currently active: ${slot.activeId ?? '(unknown)'})`,
            })
            return
          case 'reject-new':
            throw new ExtensionConflictError(
              point,
              contribution.contributionId,
              holderPluginId,
            )
          case 'replace-old':
            slot.replace(entry)
            break
          default:
            throw new UnknownExtensionPointError(point)
        }
      } else {
        slot.replace(entry)
      }
    }

    const set = this.byPlugin.get(pluginId) ?? new Set<ExtensionPointId>()
    set.add(point)
    this.byPlugin.set(pluginId, set)
  }

  retract(point: ExtensionPointId, contributionId: string): void {
    const def = this.defs.get(point)
    if (!def) throw new UnknownExtensionPointError(point)
    if (def.multi) {
      this.multiSlots.get(point)?.remove(contributionId)
    } else {
      this.singleSlots.get(point)?.remove(contributionId)
    }
  }

  /**
   * Fetch: single -> the active entry; multi -> read-only array of implementations.
   * Empty slots return undefined / an empty array (no throw: callers typically sit on optional paths).
   */
  resolve<T>(point: ExtensionPointId): T | readonly T[] | undefined {
    const def = this.defs.get(point)
    if (!def) throw new UnknownExtensionPointError(point)
    if (def.multi) {
      return (this.multiSlots.get(point)?.impls().slice() ?? []) as T[]
    }
    return this.singleSlots.get(point)?.active as T | undefined
  }

  /** Implementation list for multi slots (single slots return a 0/1-item array for uniform iteration). */
  listAll<T>(point: ExtensionPointId): T[] {
    const def = this.defs.get(point)
    if (!def) throw new UnknownExtensionPointError(point)
    if (def.multi) {
      return (this.multiSlots.get(point)?.impls().slice() ?? []) as T[]
    }
    const active = this.singleSlots.get(point)?.active
    return active === undefined ? [] : [active as T]
  }

  /** Active implementation for single slots (multi slots have no "active" concept -> undefined). */
  resolveSingle<T>(point: ExtensionPointId): T | undefined {
    const def = this.defs.get(point)
    if (!def || def.multi) return undefined
    return this.singleSlots.get(point)?.active as T | undefined
  }

  /**
   * Consumers such as `health.check` that need to look up self-check functions by plugin id
   * must use this; otherwise they would have to guess properties off `impl` (fragile and
   * not type-safe).
   */
  entries<T>(point: ExtensionPointId): Array<{
    contributionId: string
    pluginId: string
    impl: T
  }> {
    const def = this.defs.get(point)
    if (!def) throw new UnknownExtensionPointError(point)
    if (def.multi) {
      return (this.multiSlots.get(point)?.list() ?? []).map(
        e =>
          ({ ...e }) as { contributionId: string; pluginId: string; impl: T },
      )
    }
    const slot = this.singleSlots.get(point)
    if (!slot || !slot.activeId || !slot.activePluginId) return []
    return [
      {
        contributionId: slot.activeId,
        pluginId: slot.activePluginId,
        impl: slot.active as T,
      },
    ]
  }

  /** Enumerate (for health / CLI / frontend consumers). */
  list(): ExtensionPointSummary[] {
    const out: ExtensionPointSummary[] = []
    for (const [point, def] of this.defs) {
      const contributions = def.multi
        ? (this.multiSlots.get(point)?.list() ?? []).map(e => e.contributionId)
        : this.singleSlots.get(point)?.activeId
          ? [this.singleSlots.get(point)!.activeId as string]
          : []
      out.push({ point, multi: def.multi, contributions })
    }
    return out
  }

  listIssues(): readonly ExtensionIssue[] {
    return this.issues
  }

  /**
   * Forced reclamation: retract ALL of a plugin's contributions on unload/reload.
   *
   * A plugin that forgets to call `retract` still cannot leak - reclamation is enforced by
   * the kernel, not reliant on plugin diligence.
   */
  retractAll(pluginId: string): void {
    const points = this.byPlugin.get(pluginId)
    if (!points) return
    for (const point of points) {
      const def = this.defs.get(point)
      if (!def) continue
      if (def.multi) {
        this.multiSlots.get(point)?.retractPlugin(pluginId)
      } else {
        this.singleSlots.get(point)?.retractPlugin(pluginId)
      }
    }
    this.byPlugin.delete(pluginId)
  }
}
