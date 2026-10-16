/**
 * 插件加载器：把 Candidate + 动态 import 组装为 `LoadedPlugin`。
 *
 * 形态收敛（docs/06 C1）：只接受 `definePlugin` 工厂；`instantiatePlugin` 的
 * 4 种猜测与 `LoadedPluginBuilder`（9 个 `withXxx`，docs/09 O24）一并删除。
 *
 * 权限透传（docs/06 C8）：`isolation: 'worker'` 的插件必须拿到**真实**的权限快照，
 * 旧实现硬编码 `{granted:[],denied:[]}`，导致 Worker 插件永远认为无权限。
 */

import type { Candidate } from '../discovery/candidate.js';
import type { PluginFactoryHooks } from '../contracts/plugin.js';
import type { PluginContext } from '../contracts/context.js';
import type { Container } from '../contracts/container.js';
import type { PermissionSet } from '../contracts/permission.js';
import type {
  LoadedPlugin,
  PluginLoaderOptions,
} from '../extensions/ports-types.js';
import { assertPluginFactory, inlineManifestId } from './plugin-factory.js';
import { resolveEntry } from './module-resolver.js';
import { KernelError, ManifestMismatchError } from '../errors.js';
import { WorkerPluginHost } from '../isolation/worker-host.js';
import { WorkerPluginProxy } from '../isolation/worker-plugin-proxy.js';
import type { WorkerHostFacilities } from '../isolation/worker-host.js';

/** 上下文构造回调（由 Kernel 提供）。 */
export type ContextFactory = (
  candidate: Candidate,
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
  /** 权限查询（Worker 隔离必须传真实权限集，见 C8）。 */
  permissionsOf?: (pluginId: string) => PermissionSet | undefined;
}

/** 单次加载选项。 */
export type LoadOptions = PluginLoaderOptions;

/** 已加载插件（导出给编排层使用）。 */
export type { LoadedPlugin };

export class PluginLoader {
  constructor(private readonly opts: LoaderOptions) {}

  /**
   * 加载一个候选：动态 import + 工厂调用 + 建容器/上下文，状态置为 `Loaded`。
   *
   * 加载期检查（失败即抛，由内核隔离为 Failed）：
   * 1. 入口禁逃逸：解析结果必须位于插件 rootDir 内。
   * 2. 清单漂移：工厂携带的内联 manifest.id 必须与 `plugin.json` 一致。
   */
  async load(
    candidate: Candidate,
    options: LoadOptions = {},
  ): Promise<LoadedPlugin> {
    const pluginId = candidate.manifest.id;
    const container = this.opts.createContainer(pluginId);
    const context = this.opts.createContext(candidate, container);

    let hooks: PluginFactoryHooks;
    try {
      if (candidate.manifest.isolation === 'worker') {
        if (!this.opts.workerFacilities) {
          throw new KernelError(
            'E_LOAD_FAILED',
            `插件 ${pluginId} 要求 worker 隔离，但内核未提供 Worker 宿主设施`,
          );
        }
        const permissions = this.opts.permissionsOf?.(pluginId);
        const host = new WorkerPluginHost(candidate, {
          ...this.opts.workerFacilities,
          ...(permissions
            ? {
                permissions: {
                  granted: [...permissions.granted],
                  denied: [...permissions.denied],
                },
              }
            : {}),
          onUnexpectedExit:
            this.opts.workerFacilities.onUnexpectedExit ?? (() => undefined),
        });
        // Worker 侧不 import 工厂，由引导脚本在 Worker 内自行装配；内核侧用 RPC 代理。
        hooks = new WorkerPluginProxy(host);
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
        const mod = (await import(importSpecifier)) as unknown;
        const factory = assertPluginFactory(mod, pluginId);

        // 清单漂移：id 不一致是致命的（内核以 plugin.json 为唯一事实来源）。
        const declaredId = inlineManifestId(factory);
        if (declaredId !== undefined && declaredId !== candidate.manifest.id) {
          throw new ManifestMismatchError(candidate.manifest.id, declaredId);
        }

        hooks = factory(context);
      }
    } catch (error) {
      throw new KernelError(
        'E_LOAD_FAILED',
        `插件 ${pluginId} 加载失败：${(error as Error).message}`,
        { pluginId, cause: (error as Error).message },
      );
    }

    return {
      manifest: candidate.manifest,
      hooks,
      context,
      container,
      state: 'Loaded',
      health: { status: 'healthy' },
      rootDir: candidate.rootDir,
      permissions:
        this.opts.permissionsOf?.(pluginId) ??
        ({
          pluginId,
          granted: [],
          denied: [],
          isGranted: () => false,
        } as PermissionSet),
    };
  }
}
