/**
 * Extracted as a separate module because reverse lookup by pluginId is a hard requirement of
 * the multi-contribution slot (without it `retractAll` cannot be implemented) - a point easily
 * overlooked when implementing `registry.ts`.
 */

export interface SlotEntry<T> {
  readonly contributionId: string
  readonly pluginId: string
  readonly impl: T
}

export class MultiContributionSlot<T> {
  private readonly entries: SlotEntry<T>[] = []
  /** pluginId -> set of contributionIds that plugin holds in this slot (index for forced reclamation). */
  private readonly byPlugin = new Map<string, Set<string>>()

  /** Append one entry; a duplicate contributionId is treated as an overwrite (idempotent). */
  add(entry: SlotEntry<T>): void {
    this.remove(entry.contributionId)
    this.entries.push(entry)
    const set = this.byPlugin.get(entry.pluginId) ?? new Set<string>()
    set.add(entry.contributionId)
    this.byPlugin.set(entry.pluginId, set)
  }

  remove(contributionId: string): boolean {
    const idx = this.entries.findIndex(e => e.contributionId === contributionId)
    if (idx < 0) return false
    const [removed] = this.entries.splice(idx, 1)
    if (removed) {
      const set = this.byPlugin.get(removed.pluginId)
      set?.delete(contributionId)
      if (set && set.size === 0) this.byPlugin.delete(removed.pluginId)
    }
    return true
  }

  /** Retract all contributions of a plugin (the landing point of kernel-enforced reclamation). */
  retractPlugin(pluginId: string): string[] {
    const ids = Array.from(this.byPlugin.get(pluginId) ?? [])
    for (const id of ids) this.remove(id)
    return ids
  }

  /** Read-only snapshot (in insertion order). */
  list(): readonly SlotEntry<T>[] {
    return this.entries.slice()
  }

  impls(): T[] {
    return this.entries.map(e => e.impl)
  }

  has(contributionId: string): boolean {
    return this.entries.some(e => e.contributionId === contributionId)
  }

  get size(): number {
    return this.entries.length
  }
}

export class SingleContributionSlot<T> {
  private entry: SlotEntry<T> | null = null

  get active(): T | undefined {
    return this.entry?.impl
  }

  get activeId(): string | undefined {
    return this.entry?.contributionId
  }

  get activePluginId(): string | undefined {
    return this.entry?.pluginId
  }

  /**
   * Returning `false` means the new contribution was rejected under `keep-first` (the caller
   * records an issue accordingly; no throw). `replace-old` / `reject-new` adjudication happens
   * inside `registry.ts` (the latter must throw `ExtensionConflictError`); this method only
   * handles `keep-first`.
   */
  trySet(entry: SlotEntry<T>): boolean {
    if (this.entry) return false
    this.entry = entry
    return true
  }

  /** Unconditional overwrite (the `replace-old` policy). */
  replace(entry: SlotEntry<T>): SlotEntry<T> | null {
    const previous = this.entry
    this.entry = entry
    return previous
  }

  remove(contributionId: string): boolean {
    if (!this.entry || this.entry.contributionId !== contributionId)
      return false
    this.entry = null
    return true
  }

  retractPlugin(pluginId: string): boolean {
    if (!this.entry || this.entry.pluginId !== pluginId) return false
    this.entry = null
    return true
  }

  get isEmpty(): boolean {
    return this.entry === null
  }
}
