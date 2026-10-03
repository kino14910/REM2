/**
 * 权限与能力契约（纯类型）。见 docs/02 §J。
 *
 * 三段式模型（动机 #7）：能力声明（manifest）→ 权限授予（PermissionManager）→ 调用拦截（CapabilityGuard）。
 */

/** 能力名（分级命名，如 'log.sink' / 'config.provider' / 'fs.read'）。 */
export type Capability = string;

/** 信任级别。 */
export type TrustLevel = 'trusted' | 'sandboxed';

/** 授权判定结果。 */
export interface PermissionDecision {
  granted: string[];
  denied: string[];
  warnings: Array<{ capability: string; reason: string }>;
}

/** 某插件的权限集。 */
export interface PermissionSet {
  readonly pluginId: string;
  readonly granted: readonly string[];
  readonly denied: readonly string[];
  /** 判断某个能力是否已授予。 */
  isGranted(capability: string): boolean;
}

/** 信任策略：定义各级别的默认授予与需告警的能力。 */
export interface TrustPolicy {
  /** 各信任级别默认授予的能力（支持前缀通配，如 'log.*'）。 */
  defaults: Record<TrustLevel, string[]>;
  /** 授予时需要向用户告警的能力前缀。 */
  warnOn: Record<TrustLevel, string[]>;
}
