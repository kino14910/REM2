/**
 * 插件加载器（docs/02 §D.3）。
 *
 * 职责：把 Candidate + 动态 import 组装为 LoadedPlugin（含子容器、上下文）。
 * 通过 `buildContext` 注入的回调完成上下文构造，避免 loader 直接依赖编排层的细节。
 */

import type { Candidate } from '../discovery/candidate.js';
import type { Plugin } from '../contracts/lifecycle.js';
import type { PluginContext } from '../contracts/context.js';
import type { Container } from '../contracts/di-container.js';
import { instantiatePlugin } from './plugin-factory.js';
import { resolveEntry } from './module-resolver.js';
import {
  LoadedPluginBuilder,
  type LoadedPlugin,
  type PluginState,
} from '../types.js';
import { PluginState as PS } from '../types.js';
import { KernelError, ManifestMismatchError } from '../errors.js';
import { WorkerPluginHost } from '../isolation/worker-host.js';
import { WorkerPluginProxy } from '../isolation/worker-plugin-proxy.js';
import type { WorkerHostFacilities } from '../isolation/worker-host.js';

/** 上下文构造回调（由 Kernel 提供）。 */
export type ContextFactory = (
  candidate: Candidate,
  instance: Plugin,
  container: Container,
) => PluginContext;

/** 加载器选项。 */
export interface LoaderOptions {
  /** 子容器工厂（由 Kernel 提供，统一约束 scope 命名）。 */
  createContainer: (pluginId: string) => Container;
  /** 上下文工厂。 */
  createContext: ContextFactory;
  /** Worker 宿主设施（isolation: 'worker' 时必需，由 Kernel 注入）。 */
  workerFacilities?: Omit<WorkerHostFacilities, 'onUnexpectedExit'> & {
    onUnexpectedExit?: WorkerHostFacilities['onUnexpectedExit'];
  };
}

/** 单次加载选项。 */
export interface LoadOptions {
  /**
   * 热重载时的缓存击穿标记：非空时会作为 query 追加到 import 说明符，
   * 使 Node ESM 模块缓存认为这是一个新模块，从而真正加载磁盘上的新代码。
   */
  cacheBust?: string;
}

/** 已加载插件（导出给编排层使用）。 */
export type { LoadedPlugin };

/**
 * 插件加载器。
 */
export class PluginLoader {
  constructor(private readonly opts: LoaderOptions) {}

  /**
   * 加载一个候选：动态 import + 实例化 + 建容器/上下文，状态置为 Loaded。
   *
   * 加载期安全/一致性检查（均失败即抛，由内核隔离为 Failed）：
   * 1. 入口禁逃逸：解析出的入口文件必须位于插件 rootDir 内（裸包名除外）。
   * 2. 清单漂移：实例内联 manifest.id 必须与 plugin.json 的 id 一致。
   */
  async load(
    candidate: Candidate,
    options: LoadOptions = {},
  ): Promise<LoadedPlugin> {
    const pluginId = candidate.manifest.id;

    let instance: Plugin;
    try {
      if (candidate.manifest.isolation === 'worker') {
        // Worker 隔离：不直接 import，而是创建内核侧代理 + Worker 宿主。
        if (!this.opts.workerFacilities) {
          throw new KernelError(
            'E_LOAD_FAILED',
            `插件 ${pluginId} 要求 worker 隔离，但内核未提供 Worker 宿主设施`,
          );
        }
        const host = new WorkerPluginHost(candidate, {
          ...this.opts.workerFacilities,
          onUnexpectedExit:
            this.opts.workerFacilities.onUnexpectedExit ?? (() => undefined),
        });
        instance = new WorkerPluginProxy(candidate.manifest, host);
      } else {
        const { specifier } = resolveEntry(
          candidate.rootDir,
          candidate.manifest.entry,
          pluginId,
        );
        // 缓存击穿：热重载时追加 ?v=<token>，绕过 Node ESM 模块缓存。
        const importSpecifier =
          options.cacheBust && specifier.startsWith('file:')
            ? `${specifier}${specifier.includes('?') ? '&' : '?'}v=${encodeURIComponent(options.cacheBust)}`
            : specifier;
        // 动态 import：兼容 ESM/CJS（Node 自动处理）。
        const mod = (await import(importSpecifier)) as unknown;
        instance = instantiatePlugin(mod, pluginId);
      }
    } catch (error) {
      throw new KernelError(
        'E_LOAD_FAILED',
        `插件 ${pluginId} 加载失败：${(error as Error).message}`,
        {
          pluginId,
          cause: (error as Error).message,
        },
      );
    }

    // 清单漂移：id 不一致是致命的（内核以 plugin.json 为唯一事实来源）。
    if (instance.manifest.id !== candidate.manifest.id) {
      throw new ManifestMismatchError(
        candidate.manifest.id,
        instance.manifest.id,
      );
    }

    const container = this.opts.createContainer(pluginId);
    const context = this.opts.createContext(candidate, instance, container);

    const loaded = new LoadedPluginBuilder()
      .withManifest(candidate.manifest)
      .withInstance(instance)
      .withContext(context)
      .withContainer(container)
      .withState(PS.Loaded)
      .withRootDir(candidate.rootDir)
      .build();

    return loaded;
  }
}

/** 便于测试与外部构造 LoadedPlugin。 */
export { LoadedPluginBuilder } from '../types.js';
export type { PluginState };
