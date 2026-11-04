import type {
  LocalPluginManager,
  ProgressSink,
} from '@/host/plugins/local-plugin-manager.js'
import type {
  PluginDetailDto,
  PluginMarketEntryDto,
  PluginMarketListDto,
  PluginOperationResultDto,
} from '@/shared/ipc-contract.js'

import { PluginManagementError } from '@/host/plugins/errors.js'
import { isNewerVersion } from '@/host/plugins/update-compare.js'

import type { RegistryClient, RegistrySnapshot } from './client.js'
import type { RegistryPlugin, RegistryVersion } from './types.js'

import { evaluateRegistryVersionCompatibility } from './compatibility.js'
import { isRegistryNetworkFailure } from './errors.js'

export interface RegistryMarketServiceOptions {
  client: RegistryClient
  manager: LocalPluginManager
  kernelVersion: string
  contractVersion: string
}

export interface MarketListOptions {
  /** Refetch the registry index; the client may still fall back to its cache. */
  refresh?: boolean
}

/** Host-only install/update target; download fields never cross the IPC boundary. */
export interface ResolvedMarketRelease {
  pluginId: string
  name: string
  version: string
  downloadUrl: string
  sha256: string
  sizeBytes: number
  requires: string[]
  repository: string
  publishedAt?: string
}

/**
 * Join the official registry index with the host's actual install state.
 *
 * The renderer sees ids, versions, compatibility and permissions only. Install
 * and update requests are re-resolved here against a fresh registry fetch, so
 * a stale or tampered renderer request cannot choose a URL or digest.
 */
export class RegistryMarketService {
  private snapshot: RegistrySnapshot | undefined

  constructor(private readonly options: RegistryMarketServiceOptions) {}

  async list(options: MarketListOptions = {}): Promise<PluginMarketListDto> {
    const shouldFetch = options.refresh === true || this.snapshot === undefined
    if (shouldFetch) {
      try {
        this.snapshot = await this.options.client.fetch()
      } catch (error) {
        // A refresh can fail after the first successful load. Keep the
        // in-memory index rather than blanking the marketplace; only transport
        // failures qualify, because malformed remote data must stay visible.
        if (!isRegistryNetworkFailure(error) || this.snapshot === undefined) {
          throw error
        }
        this.snapshot = {
          ...this.snapshot,
          source: 'cache',
          stale: true,
          warnings: [
            ...this.snapshot.warnings,
            `registry refresh failed: ${error.message}`,
          ],
        }
      }
    }

    const snapshot = this.snapshot
    if (snapshot === undefined) {
      throw new PluginManagementError(
        'E_MARKET_UNAVAILABLE',
        'the plugin marketplace has no registry index',
      )
    }

    const local = await this.options.manager.list()
    const localById = new Map(local.plugins.map(plugin => [plugin.id, plugin]))
    const repository = snapshot.index.repository
    return {
      plugins: snapshot.index.plugins.map(plugin =>
        projectEntry(
          plugin,
          plugin.versions[0]!,
          localById.get(plugin.id),
          repository,
          this.options,
        ),
      ),
      repository,
      generatedAt: snapshot.index.generatedAt,
      fetchedAt: snapshot.fetchedAt,
      source: snapshot.source,
      stale: snapshot.stale,
      warnings: [...snapshot.warnings],
    }
  }

  /**
   * Re-resolve one id + version against a fresh registry fetch.
   *
   * Cache fallback is deliberately disabled here: the user is about to install
   * executable code, so the index must be confirmed online rather than served
   * from a possibly stale local cache.
   */
  async resolve(
    pluginId: string,
    version: string,
  ): Promise<ResolvedMarketRelease> {
    const snapshot = await this.options.client.fetch({ allowCache: false })
    this.snapshot = snapshot

    const plugin = snapshot.index.plugins.find(entry => entry.id === pluginId)
    if (!plugin) {
      throw new PluginManagementError(
        'E_MARKET_ENTRY_MISSING',
        `plugin is no longer available in the official marketplace: ${pluginId}`,
      )
    }
    const release = plugin.versions[0]
    if (release === undefined || release.version !== version) {
      throw new PluginManagementError(
        'E_MARKET_VERSION_MISSING',
        `plugin ${pluginId} no longer publishes ${version} as its current stable version`,
      )
    }

    const compatibility = evaluateRegistryVersionCompatibility(
      release,
      this.options,
    )
    if (!compatibility.compatible) {
      throw new PluginManagementError(
        'E_INCOMPATIBLE',
        `plugin ${pluginId} ${version} is not compatible with this kernel: ${compatibility.issues
          .map(issue => issue.detail)
          .join('; ')}`,
      )
    }

    return {
      pluginId: plugin.id,
      name: plugin.name,
      version: release.version,
      downloadUrl: release.downloadUrl,
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      requires: [...release.requires],
      repository: snapshot.index.repository,
      ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
    }
  }

  /** Install verified marketplace code without granting capabilities or enabling. */
  install(
    release: ResolvedMarketRelease,
    operationId: string,
    onProgress?: ProgressSink,
  ): Promise<PluginOperationResultDto> {
    return this.options.manager.installFromRemote(
      {
        url: release.downloadUrl,
        sha256: release.sha256,
        operationId,
        enable: false,
      },
      onProgress,
    )
  }

  /** Replace an installed copy with a host-verified registry release. */
  update(
    release: ResolvedMarketRelease,
    operationId: string,
    onProgress?: ProgressSink,
  ): Promise<PluginOperationResultDto> {
    return this.options.manager.applyUpdate(
      {
        pluginId: release.pluginId,
        operationId,
        expectedVersion: release.version,
        expectedSha256: release.sha256,
        sourceUrl: release.downloadUrl,
      },
      onProgress,
    )
  }
}

function projectEntry(
  plugin: RegistryPlugin,
  release: RegistryVersion,
  local: PluginDetailDto | undefined,
  repository: string,
  host: Pick<RegistryMarketServiceOptions, 'kernelVersion' | 'contractVersion'>,
): PluginMarketEntryDto {
  const compatibility = evaluateRegistryVersionCompatibility(release, host)
  const installedVersion =
    local !== undefined && local.state !== 'NotInstalled'
      ? local.version
      : undefined
  // Built-in plugins are protected from updates by the package manager.
  const canUpdate = local !== undefined && !local.builtin
  const hasUpdate =
    installedVersion !== undefined &&
    canUpdate &&
    isNewerVersion(installedVersion, release.version)
  const updateAvailable = compatibility.compatible && hasUpdate

  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    author: plugin.author,
    tags: [...plugin.tags],
    ...(plugin.homepage === undefined ? {} : { homepage: plugin.homepage }),
    repository,
    version: release.version,
    publishedAt: release.publishedAt,
    sizeBytes: release.sizeBytes,
    requires: [...release.requires],
    compatibility: {
      ...release.compatibility,
      compatible: compatibility.compatible,
      reasons: compatibility.issues.map(issue => issue.detail),
    },
    ...(installedVersion === undefined ? {} : { installedVersion }),
    updateAvailable,
    action: !compatibility.compatible
      ? 'incompatible'
      : installedVersion === undefined
        ? 'install'
        : updateAvailable
          ? 'update'
          : 'installed',
  }
}
