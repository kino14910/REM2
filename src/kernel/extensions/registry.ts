/**
 * 扩展点注册表（P3 的唯一挂载面）。
 *
 * 职责：定义扩展点 / 宿主默认实现 / 插件贡献 / 枚举 / **按 pluginId 强制回收**。
 *
 * 三条不变式（docs/03 §7.3）：
 * 1. 未知 point id → `UnknownExtensionPointError`（不静默）。
 * 2. 能力未授予 → `CapabilityDeniedError`（C7：贡献扩展点也校验能力）。
 * 3. 单例槽冲突 → 按定义里的 `conflict` 显式裁决，并把被拒项记入 `issues`。
 */

import type {
  ExtensionPointDef,
  ExtensionPointId,
  ExtensionPointSummary,
  ExtensionContribution,
} from '../contracts/extension-point.js';
import type { PermissionManager } from '../security/permission-manager.js';
import {
  MultiContributionSlot,
  SingleContributionSlot,
  type SlotEntry,
} from './contrib-slot.js';
import {
  CapabilityDeniedError,
  ExtensionConflictError,
  UnknownExtensionPointError,
} from '../errors.js';

/** 宿主默认实现的 pluginId（约定值，非真实插件）。 */
export const HOST_PLUGIN_ID = 'kernel';

/** 被拒绝的贡献记录（不抛错的裁决结果，供健康/CLI 观测）。 */
export interface ExtensionIssue {
  point: ExtensionPointId;
  contributionId: string;
  pluginId: string;
  reason: string;
}

/** 注册表构造选项。 */
export interface ExtensionPointRegistryOptions {
  /** 能力判定（贡献时校验扩展点所需能力）。 */
  permissions?: PermissionManager;
}

export class ExtensionPointRegistry {
  private readonly defs = new Map<ExtensionPointId, ExtensionPointDef<unknown>>();
  private readonly multiSlots = new Map<ExtensionPointId, MultiContributionSlot<unknown>>();
  private readonly singleSlots = new Map<ExtensionPointId, SingleContributionSlot<unknown>>();
  /** pluginId → 该插件占用的扩展点 id 集合（P6 回收索引）。 */
  private readonly byPlugin = new Map<string, Set<ExtensionPointId>>();
  private readonly issues: ExtensionIssue[] = [];
  private readonly permissions: PermissionManager | null;

  constructor(opts: ExtensionPointRegistryOptions = {}) {
    this.permissions = opts.permissions ?? null;
  }

  /** 注册一个扩展点定义（启动期一次性调用）。 */
  define<T>(def: ExtensionPointDef<T>): void {
    if (this.defs.has(def.id)) {
      throw new ExtensionConflictError(def.id, '(define)', HOST_PLUGIN_ID);
    }
    this.defs.set(def.id, def as ExtensionPointDef<unknown>);
    if (def.multi) {
      this.multiSlots.set(def.id, new MultiContributionSlot<unknown>());
    } else {
      this.singleSlots.set(def.id, new SingleContributionSlot<unknown>());
    }
  }

  /** 批量定义（`definitions.ts` 的入口）。 */
  defineAll(defs: readonly ExtensionPointDef<unknown>[]): void {
    for (const def of defs) this.define(def);
  }

  /** 扩展点是否已定义。 */
  has(point: ExtensionPointId): boolean {
    return this.defs.has(point);
  }

  /** 宿主贡献默认实现（启动期调用，pluginId 固定为 'kernel'）。 */
  registerHostDefault<T>(
    point: ExtensionPointId,
    contribution: ExtensionContribution<T>,
  ): void {
    this.contribute(HOST_PLUGIN_ID, point, contribution);
  }

  /**
   * 插件贡献。
   *
   * 流程：① point 已定义？② capability 已授予？③ 槽位冲突裁决？
   * 任一不满足 → 抛 `UnknownExtensionPointError` / `CapabilityDeniedError` /
   * `ExtensionConflictError`；`keep-first` 的拒绝不抛错，改为记 issue（该贡献被丢弃）。
   */
  contribute<T>(
    pluginId: string,
    point: ExtensionPointId,
    contribution: ExtensionContribution<T>,
  ): void {
    const def = this.defs.get(point);
    if (!def) throw new UnknownExtensionPointError(point);

    if (def.capability) {
      const set = this.permissions?.get(pluginId);
      const granted = set
        ? set.isGranted(def.capability)
        : pluginId === HOST_PLUGIN_ID;
      if (!granted) {
        // 复用内核的拒绝语义：抛 CapabilityDeniedError 而非静默丢弃（docs/06 C7）。
        throw new CapabilityDeniedError(def.capability, pluginId);
      }
    }

    const entry: SlotEntry<unknown> = {
      contributionId: contribution.contributionId,
      pluginId,
      impl: contribution.impl,
    };

    if (def.multi) {
      const slot = this.multiSlots.get(point);
      if (!slot) throw new UnknownExtensionPointError(point);
      if (slot.has(contribution.contributionId)) {
        const holder = slot.list().find((e) => e.contributionId === contribution.contributionId);
        throw new ExtensionConflictError(point, contribution.contributionId, holder?.pluginId);
      }
      slot.add(entry);
    } else {
      const slot = this.singleSlots.get(point);
      if (!slot) throw new UnknownExtensionPointError(point);
      if (!slot.isEmpty) {
        const holderPluginId = slot.activePluginId;
        switch (def.conflict) {
          case 'keep-first':
            this.issues.push({
              point,
              contributionId: contribution.contributionId,
              pluginId,
              reason: `扩展点 ${point} 为单例槽且策略为 keep-first，本次贡献被拒（当前生效：${slot.activeId ?? '(unknown)'}）`,
            });
            return;
          case 'reject-new':
            throw new ExtensionConflictError(
              point,
              contribution.contributionId,
              holderPluginId,
            );
          case 'replace-old':
            slot.replace(entry);
            break;
          default:
            throw new UnknownExtensionPointError(point);
        }
      } else {
        slot.replace(entry);
      }
    }

    const set = this.byPlugin.get(pluginId) ?? new Set<ExtensionPointId>();
    set.add(point);
    this.byPlugin.set(pluginId, set);
  }

  /** 撤回本插件的某项贡献。 */
  retract(point: ExtensionPointId, contributionId: string): void {
    const def = this.defs.get(point);
    if (!def) throw new UnknownExtensionPointError(point);
    if (def.multi) {
      this.multiSlots.get(point)?.remove(contributionId);
    } else {
      this.singleSlots.get(point)?.remove(contributionId);
    }
  }

  /**
   * 取出：单例 → 生效的那一个；多贡献 → 只读实现数组。
   * 未定义或空槽返回 undefined / 空数组（不抛错：调用方多在可选路径上）。
   */
  resolve<T>(point: ExtensionPointId): T | readonly T[] | undefined {
    const def = this.defs.get(point);
    if (!def) throw new UnknownExtensionPointError(point);
    if (def.multi) {
      return (this.multiSlots.get(point)?.impls().slice() ?? []) as T[];
    }
    return this.singleSlots.get(point)?.active as T | undefined;
  }

  /** 多贡献槽的实现列表（单例槽返回含 0/1 项的数组，便于统一遍历）。 */
  listAll<T>(point: ExtensionPointId): T[] {
    const def = this.defs.get(point);
    if (!def) throw new UnknownExtensionPointError(point);
    if (def.multi) {
      return (this.multiSlots.get(point)?.impls().slice() ?? []) as T[];
    }
    const active = this.singleSlots.get(point)?.active;
    return active === undefined ? [] : [active as T];
  }

  /** 单例槽的生效实现（多贡献槽无「生效」概念 → undefined）。 */
  resolveSingle<T>(point: ExtensionPointId): T | undefined {
    const def = this.defs.get(point);
    if (!def || def.multi) return undefined;
    return this.singleSlots.get(point)?.active as T | undefined;
  }

  /**
   * 带归属信息的贡献列表（`contributionId` + `pluginId` + `impl`）。
   *
   * `health.check` 这类需要按插件 id 反查自检函数的消费方必须用它，
   * 否则只能从 `impl` 上猜属性（脆弱且不可类型安全）。
   */
  entries<T>(point: ExtensionPointId): Array<{
    contributionId: string;
    pluginId: string;
    impl: T;
  }> {
    const def = this.defs.get(point);
    if (!def) throw new UnknownExtensionPointError(point);
    if (def.multi) {
      return (this.multiSlots.get(point)?.list() ?? []).map(
        (e) => ({ ...e }) as { contributionId: string; pluginId: string; impl: T },
      );
    }
    const slot = this.singleSlots.get(point);
    if (!slot || !slot.activeId || !slot.activePluginId) return [];
    return [
      {
        contributionId: slot.activeId,
        pluginId: slot.activePluginId,
        impl: slot.active as T,
      },
    ];
  }

  /** 枚举（给 health / CLI / 前端用）。 */
  list(): ExtensionPointSummary[] {
    const out: ExtensionPointSummary[] = [];
    for (const [point, def] of this.defs) {
      const contributions = def.multi
        ? (this.multiSlots.get(point)?.list() ?? []).map((e) => e.contributionId)
        : this.singleSlots.get(point)?.activeId
          ? [this.singleSlots.get(point)!.activeId as string]
          : [];
      out.push({ point, multi: def.multi, contributions });
    }
    return out;
  }

  /** 被拒绝的贡献记录。 */
  listIssues(): readonly ExtensionIssue[] {
    return this.issues;
  }

  /**
   * P6 强制回收：卸载/重载插件时撤回其**全部**贡献。
   *
   * 插件即使漏调 `retract` 也不会泄漏 —— 这正是 P6「回收由内核强制，不依赖插件自觉」。
   */
  retractAll(pluginId: string): void {
    const points = this.byPlugin.get(pluginId);
    if (!points) return;
    for (const point of points) {
      const def = this.defs.get(point);
      if (!def) continue;
      if (def.multi) {
        this.multiSlots.get(point)?.retractPlugin(pluginId);
      } else {
        this.singleSlots.get(point)?.retractPlugin(pluginId);
      }
    }
    this.byPlugin.delete(pluginId);
  }
}
