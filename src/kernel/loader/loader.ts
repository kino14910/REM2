import type { Candidate } from '../discovery/candidate.js'
import type { PluginFactoryHooks } from '../contracts/plugin.js'
import type { PluginContext } from '../contracts/context.js'
import type { Container } from '../contracts/container.js'
import type { PermissionSet } from '../contracts/permission.js'
import type {
  LoadedPlugin,
  PluginLoaderOptions,
} from '../extensions/ports-types.js'
import { assertPluginFactory, inlineManifestId } from './plugin-factory.js'
import { resolveEntry } from './module-resolver.js'
import { KernelError, ManifestMismatchError } from '../errors.js'
import { WorkerPluginHost } from '../isolation/worker-host.js'
import { WorkerPluginProxy } from '../isolation/worker-plugin-proxy.js'
import type { WorkerHostFacilities } from '../isolation/worker-host.js'

/** Context construction callback (provided by the Kernel). */
export type ContextFactory = (
  candidate: Candidate,
  container: Container,
) => PluginContext

/** Loader options. */
export interface LoaderOptions {
  /** Child container factory (provided by the Kernel; enforces scope naming). */
  createContainer: (pluginId: string) => Container
  /** Context factory. */
  createContext: ContextFactory
  /** Worker host facilities (required when isolation is 'worker'; injected by the Kernel). */
  workerFacilities?: Omit<WorkerHostFacilities, 'onUnexpectedExit'> & {
    onUnexpectedExit?: WorkerHostFacilities['onUnexpectedExit']
  }
  /** Permission lookup (worker isolation must receive the real permission set). */
  permissionsOf?: (pluginId: string) => PermissionSet | undefined
}

/** Per-load options. */
export type LoadOptions = PluginLoaderOptions

/** Loaded plugin (re-exported for the orchestration layer). */
export type { LoadedPlugin }

export class PluginLoader {
  constructor(private readonly opts: LoaderOptions) {}

  /**
   * Loads a candidate: dynamic import + factory invocation + container and
   * context creation; the resulting state is `Loaded`.
   *
   * Load-time checks (failures throw; the kernel isolates them as Failed):
   * 1. Entry escape guard: the resolved entry must stay inside the plugin rootDir.
   * 2. Manifest drift: the inline manifest.id carried by the factory must match `plugin.json`.
   */
  async load(
    candidate: Candidate,
    options: LoadOptions = {},
  ): Promise<LoadedPlugin> {
    const pluginId = candidate.manifest.id
    const container = this.opts.createContainer(pluginId)
    const context = this.opts.createContext(candidate, container)

    let hooks: PluginFactoryHooks
    try {
      if (candidate.manifest.isolation === 'worker') {
        if (!this.opts.workerFacilities) {
          throw new KernelError(
            'E_LOAD_FAILED',
            `plugin ${pluginId} requires worker isolation, but the kernel did not provide Worker host facilities`,
          )
        }
        const permissions = this.opts.permissionsOf?.(pluginId)
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
        })
        // The worker side never imports the factory; the bootstrap script assembles it inside the worker, and the kernel side uses an RPC proxy.
        hooks = new WorkerPluginProxy(host)
      } else {
        const { specifier } = resolveEntry(
          candidate.rootDir,
          candidate.manifest.entry,
          pluginId,
        )
        // Cache busting: append ?v=<token> on hot reload to bypass the Node ESM module cache.
        const importSpecifier =
          options.cacheBust && specifier.startsWith('file:')
            ? `${specifier}${specifier.includes('?') ? '&' : '?'}v=${encodeURIComponent(options.cacheBust)}`
            : specifier
        const mod = (await import(importSpecifier)) as unknown
        const factory = assertPluginFactory(mod, pluginId)

        // Manifest drift: an id mismatch is fatal (the kernel treats plugin.json as the single source of truth).
        const declaredId = inlineManifestId(factory)
        if (declaredId !== undefined && declaredId !== candidate.manifest.id) {
          throw new ManifestMismatchError(candidate.manifest.id, declaredId)
        }

        hooks = factory(context)
      }
    } catch (error) {
      throw new KernelError(
        'E_LOAD_FAILED',
        `failed to load plugin ${pluginId}: ${(error as Error).message}`,
        { pluginId, cause: (error as Error).message },
      )
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
    }
  }
}
