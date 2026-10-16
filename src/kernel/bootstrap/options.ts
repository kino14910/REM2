/**
 * 内核引导选项。
 *
 * 变更（docs/06 D6）：删除 `bootstrap` 死配置 —— `Kernel` 从不消费它，
 * 「引导插件」这一概念已由 `*.replace` 扩展点取代（启动期由引导插件替换实现）。
 */

import type { LogLevel } from '../contracts/logging.js';
import type { TrustLevel } from '../contracts/permission.js';

/** 内核选项。 */
export interface KernelOptions {
  /** 内核实例 id。 */
  id: string;
  /** 用户插件根目录列表。 */
  roots: string[];
  /** 内建插件根目录（source=builtin → trusted）。 */
  builtinRoot?: string;
  /** 工作区插件根目录。 */
  workspaceRoot?: string;
  /** 配置文件路径（透传给 config provider，内核自身不解析）。 */
  configPath?: string;
  /** 全局信任级别覆盖（缺省按 source 判定）。 */
  trustLevel?: TrustLevel;
  /** 启动超时（单插件 Start 阶段）。 */
  startTimeoutMs: number;
  /** 停止超时（单插件 Stop/Unload/Dispose 阶段）。 */
  stopTimeoutMs: number;
  /** 是否启用旧式 manifest.json 兼容。 */
  legacyFallback: boolean;
  /** 初始日志级别。 */
  logLevel: LogLevel;
  /** 解析错误处理策略。 */
  onResolveError: 'strict' | 'graceful';
  /** 初始配置（注入内核默认内存 provider）。 */
  initialConfig?: Record<string, unknown>;
}

/** 默认内核选项。 */
export function defaultKernelOptions(
  partial: Partial<KernelOptions> = {},
): KernelOptions {
  return {
    id: partial.id ?? 'rem2-kernel',
    roots: partial.roots ?? [],
    ...(partial.builtinRoot !== undefined
      ? { builtinRoot: partial.builtinRoot }
      : {}),
    ...(partial.workspaceRoot !== undefined
      ? { workspaceRoot: partial.workspaceRoot }
      : {}),
    ...(partial.configPath !== undefined
      ? { configPath: partial.configPath }
      : {}),
    ...(partial.trustLevel !== undefined
      ? { trustLevel: partial.trustLevel }
      : {}),
    startTimeoutMs: partial.startTimeoutMs ?? 5000,
    stopTimeoutMs: partial.stopTimeoutMs ?? 5000,
    legacyFallback: partial.legacyFallback ?? false,
    logLevel: partial.logLevel ?? 'info',
    onResolveError: partial.onResolveError ?? 'graceful',
    ...(partial.initialConfig !== undefined
      ? { initialConfig: partial.initialConfig }
      : {}),
  };
}
