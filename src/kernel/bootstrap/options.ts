/**
 * 内核引导选项（docs/02 §B.4 / 类图 KernelOptions）。
 */

import type { LogLevel } from '../contracts/logging.js';

/** 引导插件声明：内核允许在自身启动前预加载的"引导例外"插件（如 logger-console）。 */
export interface PluginBootstrap {
  /** 插件 id 或目录名。 */
  id: string;
  /** 是否必需（缺失则内核启动失败）。 */
  required: boolean;
}

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
  trustLevel?: import('../contracts/permission.js').TrustLevel;
  /** 启动超时（单插件 Start 阶段）。 */
  startTimeoutMs: number;
  /** 停止超时（单插件 Stop/Unload/Dispose 阶段）。 */
  stopTimeoutMs: number;
  /** 是否启用旧式 manifest.json 兼容。 */
  legacyFallback: boolean;
  /** 初始日志级别。 */
  logLevel: LogLevel;
  /** 引导插件列表。 */
  bootstrap: PluginBootstrap[];
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
    bootstrap: partial.bootstrap ?? [
      { id: 'com.rem2.logger-console', required: false },
    ],
    onResolveError: partial.onResolveError ?? 'graceful',
    ...(partial.initialConfig !== undefined
      ? { initialConfig: partial.initialConfig }
      : {}),
  };
}
