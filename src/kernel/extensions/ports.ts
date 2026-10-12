/**
 * 可替换端口（`*.replace` 扩展点的契约侧）。
 *
 * 抽象出端口而非直接引用实现类，是为了让 `definitions.ts` 能在**不 import 实现层**
 * 的前提下声明 `scheduler.replace` / `resolver.replace` / `loader.replace` 三个扩展点
 * （docs/13 §3.3 D7 的例外仅限 `kernel.ts` 与 `composition.ts`）。
 */

import type { Candidate } from '../discovery/candidate.js';
import type { PluginLoaderOptions, LoadedPlugin } from './ports-types.js';

/** 命令处理器（`command.provide` 扩展点的贡献类型）。 */
export type CommandHandler = (
  args: unknown,
) => Promise<unknown> | unknown;

/** 依赖解析端口（`resolver.replace` 的贡献类型）。 */
export interface DependencyResolverPort {
  resolve(
    candidates: Candidate[],
    opts: {
      kernelVersion: string;
      contractVersion: string;
      onError?: 'strict' | 'graceful';
    },
  ): {
    loadOrder: string[];
    steps: Array<{ candidate: Candidate; missingOptional: string[] }>;
    issues: Array<{ code: string; level: 'error' | 'warn'; pluginId: string; detail: string }>;
    dropped: string[];
  };
}

/** 插件装载端口（`loader.replace` 的贡献类型）。 */
export interface PluginLoaderPort {
  load(
    candidate: Candidate,
    options?: PluginLoaderOptions,
  ): Promise<LoadedPlugin>;
}
