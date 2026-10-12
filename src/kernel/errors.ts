/**
 * 内核错误分类（动机 #6：错误必须显式、可分类、可审计，绝不静默降级）。
 *
 * 约定：所有内核错误都继承 `KernelError`，携带稳定的 `code`，便于测试断言与日志检索。
 */

/** 错误码枚举（字符串联合，稳定且可序列化）。 */
export type KernelErrorCode =
  | 'E_INVALID_MANIFEST'
  | 'E_DUPLICATE_ID'
  | 'E_MISSING_DEPENDENCY'
  | 'E_VERSION_MISMATCH'
  | 'E_CYCLE'
  | 'E_INCOMPATIBLE'
  | 'E_NO_PROVIDER'
  | 'E_CIRCULAR_DEPENDENCY'
  | 'E_CAPABILITY_DENIED'
  | 'E_SCOPED_ACCESS'
  | 'E_TIMEOUT'
  | 'E_LOAD_FAILED'
  | 'E_LIFECYCLE'
  | 'E_ILLEGAL_TRANSITION'
  | 'E_NO_RESPONDER'
  | 'E_NOT_WRITABLE'
  | 'E_ALREADY_STARTED'
  | 'E_MANIFEST_MISMATCH'
  | 'E_ENTRY_ESCAPE'
  | 'E_UNKNOWN_EXTENSION_POINT'
  | 'E_EXTENSION_CONFLICT'
  | 'E_GENERIC';

/** 所有内核错误的基类。 */
export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: KernelErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
    // 修正原型链（TS 编译到 ES2022 target 时 Error 子类原型需手动修复的场景）。
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 插件相关错误基类。 */
export class PluginError extends KernelError {
  readonly pluginId: string;

  constructor(
    code: KernelErrorCode,
    pluginId: string,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(code, `[${pluginId}] ${message}`, detail);
    this.name = 'PluginError';
    this.pluginId = pluginId;
  }
}

/** 阶段/操作超时（生命周期、RPC 等）。 */
export class TimeoutError extends KernelError {
  readonly timeoutMs: number;

  constructor(
    operation: string,
    timeoutMs: number,
    detail?: Record<string, unknown>,
  ) {
    super('E_TIMEOUT', `操作超时：${operation}（${timeoutMs}ms）`, detail);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** 依赖解析错误（缺失/版本不符/不兼容/重复）。 */
export class ResolveError extends KernelError {
  constructor(
    code: KernelErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(code, message, detail);
    this.name = 'ResolveError';
  }
}

/** 循环依赖错误（插件级或 DI 级）。 */
export class CircularDependencyError extends KernelError {
  readonly cycle: string[];

  constructor(kind: 'plugin' | 'service', cycle: string[]) {
    super(
      kind === 'plugin' ? 'E_CYCLE' : 'E_CIRCULAR_DEPENDENCY',
      `${kind === 'plugin' ? '插件' : '服务'}循环依赖：${cycle.join(' -> ')}`,
      { cycle },
    );
    this.name = 'CircularDependencyError';
    this.cycle = cycle;
  }
}

/** 服务无提供者。 */
export class NoProviderError extends KernelError {
  constructor(tokenId: string) {
    super('E_NO_PROVIDER', `无服务提供者：${tokenId}`, { tokenId });
    this.name = 'NoProviderError';
  }
}

/** 能力被拒绝（安全审计）。 */
export class CapabilityDeniedError extends KernelError {
  readonly capability: string;
  readonly pluginId: string;

  constructor(capability: string, pluginId: string) {
    super(
      'E_CAPABILITY_DENIED',
      `插件 ${pluginId} 未获授权的能力：${capability}`,
      { capability, pluginId },
    );
    this.name = 'CapabilityDeniedError';
    this.capability = capability;
    this.pluginId = pluginId;
  }
}

/** 越界访问（插件子容器试图访问父容器）。 */
export class ScopedAccessError extends KernelError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('E_SCOPED_ACCESS', message, detail);
    this.name = 'ScopedAccessError';
  }
}

/** 非法生命周期跃迁。 */
export class IllegalTransitionError extends KernelError {
  constructor(from: string, to: string) {
    super('E_ILLEGAL_TRANSITION', `非法生命周期跃迁：${from} -> ${to}`, {
      from,
      to,
    });
    this.name = 'IllegalTransitionError';
  }
}

/** Manifest 校验失败。 */
export class ManifestError extends KernelError {
  readonly issues: string[];

  constructor(issues: string[], filePath?: string) {
    super(
      'E_INVALID_MANIFEST',
      `插件清单非法${filePath ? `（${filePath}）` : ''}：${issues.join('; ')}`,
      { issues, filePath },
    );
    this.name = 'ManifestError';
    this.issues = issues;
  }
}

/** 插件实例内联清单与 plugin.json 漂移（id 不一致）。 */
export class ManifestMismatchError extends KernelError {
  constructor(pluginId: string, instanceId: string) {
    super(
      'E_MANIFEST_MISMATCH',
      `插件实例清单漂移：plugin.json id=${pluginId}，实例 manifest.id=${instanceId}`,
      { pluginId, instanceId },
    );
    this.name = 'ManifestMismatchError';
  }
}

/** 插件入口逃逸出插件根目录（安全边界）。 */
export class EntryEscapeError extends KernelError {
  constructor(pluginId: string, entry: string) {
    super(
      'E_ENTRY_ESCAPE',
      `插件入口逃逸出根目录：${pluginId} entry=${entry}`,
      {
        pluginId,
        entry,
      },
    );
    this.name = 'EntryEscapeError';
  }
}

/** RPC 无响应者。 */
export class NoResponderError extends KernelError {
  constructor(topic: string) {
    super('E_NO_RESPONDER', `事件主题无响应者：${topic}`, { topic });
    this.name = 'NoResponderError';
  }
}

/** provider 不可写。 */
export class NotWritableError extends KernelError {
  constructor(name: string) {
    super('E_NOT_WRITABLE', `配置 provider 不可写：${name}`, { name });
    this.name = 'NotWritableError';
  }
}

/** 向未声明的扩展点贡献（P3：不静默，直接拒绝）。 */
export class UnknownExtensionPointError extends KernelError {
  readonly point: string;

  constructor(point: string) {
    super(
      'E_UNKNOWN_EXTENSION_POINT',
      `未声明的扩展点：${point}（扩展点必须在 extensions/definitions.ts 中显式定义）`,
      { point },
    );
    this.name = 'UnknownExtensionPointError';
    this.point = point;
  }
}

/** 扩展点槽位冲突（单例槽 reject-new / 多贡献槽同 id）。 */
export class ExtensionConflictError extends KernelError {
  readonly point: string;
  readonly contributionId: string;
  readonly holderPluginId: string | undefined;

  constructor(
    point: string,
    contributionId: string,
    holderPluginId: string | undefined,
  ) {
    super(
      'E_EXTENSION_CONFLICT',
      `扩展点冲突：${point} 的槽位 "${contributionId}" 已被${
        holderPluginId ? `插件 ${holderPluginId}` : '宿主默认实现'
      }占用`,
      { point, contributionId, holderPluginId },
    );
    this.name = 'ExtensionConflictError';
    this.point = point;
    this.contributionId = contributionId;
    this.holderPluginId = holderPluginId;
  }
}
