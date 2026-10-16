/**
 * 贡献槽：单例槽与多贡献槽的容器语义。
 *
 * 单独抽出是因为「按 pluginId 反查」是多贡献槽的**硬需求**（否则 `retractAll` 无法实现），
 * 而这一点极易在实现 `registry.ts` 时漏掉（docs/03 §7.3 明确点名）。
 */

/** 一项贡献的内部记录。 */
export interface SlotEntry<T> {
  readonly contributionId: string;
  readonly pluginId: string;
  readonly impl: T;
}

/** 多贡献槽。 */
export class MultiContributionSlot<T> {
  private readonly entries: SlotEntry<T>[] = [];
  /** pluginId → 该插件在此槽内的 contributionId 集合（P6 回收索引）。 */
  private readonly byPlugin = new Map<string, Set<string>>();

  /** 追加一项；同 contributionId 视为覆盖（幂等）。 */
  add(entry: SlotEntry<T>): void {
    this.remove(entry.contributionId);
    this.entries.push(entry);
    const set = this.byPlugin.get(entry.pluginId) ?? new Set<string>();
    set.add(entry.contributionId);
    this.byPlugin.set(entry.pluginId, set);
  }

  /** 按 contributionId 移除。 */
  remove(contributionId: string): boolean {
    const idx = this.entries.findIndex((e) => e.contributionId === contributionId);
    if (idx < 0) return false;
    const [removed] = this.entries.splice(idx, 1);
    if (removed) {
      const set = this.byPlugin.get(removed.pluginId);
      set?.delete(contributionId);
      if (set && set.size === 0) this.byPlugin.delete(removed.pluginId);
    }
    return true;
  }

  /** 撤回某插件的全部贡献（内核强制回收的落点）。 */
  retractPlugin(pluginId: string): string[] {
    const ids = Array.from(this.byPlugin.get(pluginId) ?? []);
    for (const id of ids) this.remove(id);
    return ids;
  }

  /** 只读快照（按插入序）。 */
  list(): readonly SlotEntry<T>[] {
    return this.entries.slice();
  }

  /** 只读实现列表。 */
  impls(): T[] {
    return this.entries.map((e) => e.impl);
  }

  /** 是否存在指定 contributionId。 */
  has(contributionId: string): boolean {
    return this.entries.some((e) => e.contributionId === contributionId);
  }

  get size(): number {
    return this.entries.length;
  }
}

/** 单例槽：只保留「生效的那一个」。 */
export class SingleContributionSlot<T> {
  private entry: SlotEntry<T> | null = null;

  /** 当前生效项（无则 undefined）。 */
  get active(): T | undefined {
    return this.entry?.impl;
  }

  /** 当前生效项的 contributionId。 */
  get activeId(): string | undefined {
    return this.entry?.contributionId;
  }

  /** 当前生效项的归属插件。 */
  get activePluginId(): string | undefined {
    return this.entry?.pluginId;
  }

  /**
   * 尝试置入一项。
   *
   * 返回 `false` 表示按 `keep-first` 拒绝了新贡献（调用方据此记 issue，不抛错）。
   * `replace-old` / `reject-new` 的裁决在 `registry.ts` 内完成（后者需抛
   * `ExtensionConflictError`），本方法只处理 `keep-first`。
   */
  trySet(entry: SlotEntry<T>): boolean {
    if (this.entry) return false;
    this.entry = entry;
    return true;
  }

  /** 无条件覆盖（`replace-old`）。 */
  replace(entry: SlotEntry<T>): SlotEntry<T> | null {
    const previous = this.entry;
    this.entry = entry;
    return previous;
  }

  /** 移除指定 contributionId（不匹配时无操作）。 */
  remove(contributionId: string): boolean {
    if (!this.entry || this.entry.contributionId !== contributionId) return false;
    this.entry = null;
    return true;
  }

  /** 撤回某插件的贡献；该插件并非当前持有者时无操作。 */
  retractPlugin(pluginId: string): boolean {
    if (!this.entry || this.entry.pluginId !== pluginId) return false;
    this.entry = null;
    return true;
  }

  get isEmpty(): boolean {
    return this.entry === null;
  }
}
