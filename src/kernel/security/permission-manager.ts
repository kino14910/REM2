/**
 * 权限管理器（见 docs/01）。
 *
 * 流程：manifest.requires → PermissionManager.check(manifest, trustLevel) → PermissionSet。
 * `check` 依据 TrustPolicy 决定授予/拒绝/告警；`grant/revoke` 支持运行期调整。
 */

import type {
  PermissionDecision,
  PermissionSet,
  TrustLevel,
  TrustPolicy,
} from '../contracts/permission.js';
import type { PluginManifest } from '../contracts/manifest.js';
import { DEFAULT_TRUST_POLICY, matchesAny } from './trust-policy.js';
import type { CapabilityGuard } from './capability-guard.js';

/** PermissionSet 实现。 */
export class MutablePermissionSet implements PermissionSet {
  constructor(
    readonly pluginId: string,
    private grantedSet: Set<string>,
    private deniedSet: Set<string>,
  ) {}

  get granted(): readonly string[] {
    return Array.from(this.grantedSet).sort();
  }

  get denied(): readonly string[] {
    return Array.from(this.deniedSet).sort();
  }

  isGranted(capability: string): boolean {
    return this.grantedSet.has(capability);
  }

  /** 运行期追加授予。 */
  grant(capability: string): void {
    this.grantedSet.add(capability);
    this.deniedSet.delete(capability);
  }

  /** 运行期撤销。 */
  revoke(capability: string): void {
    this.grantedSet.delete(capability);
    this.deniedSet.add(capability);
  }
}

/**
 * 权限管理器。
 */
export class PermissionManager {
  private readonly grants = new Map<string, MutablePermissionSet>();
  private readonly guard: CapabilityGuard | null;

  constructor(
    guard?: CapabilityGuard,
    private readonly policy: TrustPolicy = DEFAULT_TRUST_POLICY,
  ) {
    this.guard = guard ?? null;
  }

  /** 已登记的权限集。 */
  get(pluginId: string): MutablePermissionSet | undefined {
    return this.grants.get(pluginId);
  }

  all(): MutablePermissionSet[] {
    return Array.from(this.grants.values());
  }

  /**
   * 依据策略为插件计算授权结果。
   *
   * 规则：
   * - 能力落在策略的 `warnOn` → 进入 warnings（沙箱级别下同时默认拒绝）。
   * - 能力落在 `defaults` → 授予。
   * - 其余能力 → 视为"需显式授予"，默认拒绝。
   */
  check(manifest: PluginManifest, trustLevel: TrustLevel): PermissionDecision {
    const declared = manifest.requires ?? [];
    const defaults = this.policy.defaults[trustLevel] ?? [];
    const warnOn = this.policy.warnOn[trustLevel] ?? [];

    const granted: string[] = [];
    const denied: string[] = [];
    const warnings: Array<{ capability: string; reason: string }> = [];

    for (const cap of declared) {
      const isDefault = matchesAny(cap, defaults);
      const isSensitive = matchesAny(cap, warnOn);

      if (isDefault && !isSensitive) {
        granted.push(cap);
      } else if (isDefault && isSensitive) {
        // 敏感能力：可信级别授予但告警；沙箱级别拒绝并告警。
        if (trustLevel === 'trusted') {
          granted.push(cap);
          warnings.push({
            capability: cap,
            reason: '敏感能力，已在可信级别下授予',
          });
        } else {
          denied.push(cap);
          warnings.push({
            capability: cap,
            reason: '敏感能力在沙箱级别需显式授予',
          });
        }
      } else if (isSensitive) {
        denied.push(cap);
        warnings.push({ capability: cap, reason: '敏感能力需显式授予' });
      } else {
        // 未知能力：沙箱默认拒绝；可信默认授予（宽松）。
        if (trustLevel === 'trusted') {
          granted.push(cap);
        } else {
          denied.push(cap);
        }
      }
    }

    // 登记权限集与 guard
    const set = new MutablePermissionSet(
      manifest.id,
      new Set(granted),
      new Set(denied),
    );
    this.grants.set(manifest.id, set);
    this.guard?.registerPermissions(set);

    return {
      granted: set.granted.slice(),
      denied: set.denied.slice(),
      warnings,
    };
  }

  /** 运行期授予。 */
  grant(pluginId: string, capability: string): void {
    const set = this.grants.get(pluginId);
    if (set) {
      set.grant(capability);
    } else {
      this.grants.set(
        pluginId,
        new MutablePermissionSet(pluginId, new Set([capability]), new Set()),
      );
    }
    const updated = this.grants.get(pluginId)!;
    this.guard?.registerPermissions(updated);
  }

  /** 运行期撤销。 */
  revoke(pluginId: string, capability: string): void {
    const set = this.grants.get(pluginId);
    set?.revoke(capability);
  }

  /** 注销插件的全部权限登记（卸载/重载时调用，避免泄漏到 CapabilityGuard）。 */
  unregister(pluginId: string): void {
    this.grants.delete(pluginId);
    this.guard?.unregisterPermissions(pluginId);
  }

  /** 安装 guard（对外的幂等入口，见类图 installGuard）。 */
  installGuard(): void {
    // guard 在构造时注入；此方法保留以便显式表达"已安装"。
  }
}
