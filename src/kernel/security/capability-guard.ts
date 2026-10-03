/**
 * 能力代理（docs/02 §J.4，动机 #7 三段式第三段）。
 *
 * `CapabilityGuard` 包装服务解析：当某服务声明了所需能力时，校验调用方插件
 * 是否被授予该能力；未授权则抛 CapabilityDeniedError（拒绝而非静默降级）。
 */

import type { PermissionSet } from '../contracts/permission.js';
import { CapabilityDeniedError } from '../errors.js';

/** 能力代理。 */
export class CapabilityGuard {
  /** 服务 id -> 所需能力。由内核在授权阶段登记。 */
  private readonly serviceCapabilities = new Map<string, string>();
  /** 插件 id -> 权限集（运行期查询）。 */
  private readonly permissionLookup = new Map<string, PermissionSet>();
  /** 被拒绝次数（指标/测试）。 */
  private deniedCount = 0;

  /** 登记某服务所需能力。 */
  declareServiceCapability(serviceId: string, capability: string): void {
    this.serviceCapabilities.set(serviceId, capability);
  }

  /** 注销服务能力声明。 */
  retractServiceCapability(serviceId: string): void {
    this.serviceCapabilities.delete(serviceId);
  }

  /** 登记插件权限集。 */
  registerPermissions(set: PermissionSet): void {
    this.permissionLookup.set(set.pluginId, set);
  }

  /** 注销插件权限集。 */
  unregisterPermissions(pluginId: string): void {
    this.permissionLookup.delete(pluginId);
  }

  /**
   * 断言调用方有权访问某服务。
   *
   * @param serviceId 服务 token id
   * @param callerPluginId 调用方插件 id（内核自身调用可传 'kernel'）
   * @throws CapabilityDeniedError 当且仅当服务声明了能力且调用方未被授予
   */
  assert(serviceId: string, callerPluginId: string): void {
    const capability = this.serviceCapabilities.get(serviceId);
    if (!capability) return; // 未声明能力的服务是公共的

    // 内核自身总是允许。
    if (callerPluginId === 'kernel') return;

    const perms = this.permissionLookup.get(callerPluginId);
    if (!perms || !perms.isGranted(capability)) {
      this.deniedCount += 1;
      throw new CapabilityDeniedError(capability, callerPluginId);
    }
  }

  /** 主动断言一个能力（用于命令式能力检查，如 net.listen）。 */
  assertCapability(capability: string, callerPluginId: string): void {
    if (callerPluginId === 'kernel') return;
    const perms = this.permissionLookup.get(callerPluginId);
    if (!perms || !perms.isGranted(capability)) {
      this.deniedCount += 1;
      throw new CapabilityDeniedError(capability, callerPluginId);
    }
  }

  /** 被拒绝总次数。 */
  get deniedTotal(): number {
    return this.deniedCount;
  }
}
