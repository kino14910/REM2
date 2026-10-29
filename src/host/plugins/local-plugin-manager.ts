import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Kernel } from '../../kernel/kernel.js'
import { CONTRACT_VERSION } from '../../kernel/version.js'
import { PluginDiscovery } from '../../kernel/discovery/discovery.js'
import {
  validateManifest,
  isValidPluginId,
} from '../../kernel/discovery/manifest-validator.js'
import { DependencyResolver } from '../../kernel/dependency/resolver.js'
import { resolveEntry } from '../../kernel/loader/module-resolver.js'
import type {
  Candidate,
  CandidateSource,
} from '../../kernel/discovery/candidate.js'
import type {
  PluginDetailDto,
  PluginDownloadPhase,
  PluginListDto,
  PluginOperationResultDto,
  PluginRemoteInspectionDto,
  PluginUpdateCheckDto,
  PluginUpdateDto,
} from '../../shared/ipc-contract.js'
import { PluginManagementError } from './errors.js'
import { PluginStateStore } from './state-store.js'
import { isSha256, verifyFileDigest } from './integrity.js'
import { downloadPackage } from './remote-download.js'
import { extractZipSafe } from './zip-extract.js'
import { resolveRemoteRelease, type RemoteRelease } from './release-source.js'
import { PluginProvenanceStore } from './provenance-store.js'
import { isNewerVersion } from './update-compare.js'
import {
  assertInside,
  assertRealDirectoryInside,
  copyDirectorySafe,
  readJsonFile,
} from './safe-fs.js'

/** Downloaded packages stay reusable for this long; after that a source change is picked up. */
const PACKAGE_CACHE_TTL_MS = 10 * 60 * 1000

export interface RemoteProgress {
  phase: PluginDownloadPhase
  receivedBytes?: number
  totalBytes?: number
}

export type ProgressSink = (progress: RemoteProgress) => void

export interface LocalPluginManagerOptions {
  kernel: Kernel
  userRoot: string
  dataRoot: string
  state: PluginStateStore
  builtinRoot?: string
  copyDirectory?: typeof copyDirectorySafe
  /** Remote installs keep their source URL/digest here; absent = remote operations unavailable. */
  provenance?: PluginProvenanceStore
  /** Download cache directory; defaults to `<userData>/plugin-packages`. */
  packagesRoot?: string
  /** Injected for tests; production uses global fetch. */
  fetchImpl?: typeof fetch
}

export class LocalPluginManager {
  private readonly kernel: Kernel
  private readonly userRoot: string
  private readonly dataRoot: string
  private readonly state: PluginStateStore
  private readonly builtinRoot?: string
  private readonly copyDirectory: typeof copyDirectorySafe
  private readonly provenance?: PluginProvenanceStore
  private readonly packagesRoot: string
  private readonly fetchImpl?: typeof fetch
  private ready = false
  private queue: Promise<void> = Promise.resolve()
  /** Active download/update operations keyed by the renderer-generated id (cancellation handle). */
  private readonly operations = new Map<string, AbortController>()
  /** Plugins with an update in flight; guards against overlapping update/install of one id. */
  private readonly pendingByPlugin = new Set<string>()

  constructor(options: LocalPluginManagerOptions) {
    this.kernel = options.kernel
    this.userRoot = path.resolve(options.userRoot)
    this.dataRoot = path.resolve(options.dataRoot)
    this.state = options.state
    this.builtinRoot = options.builtinRoot
    this.copyDirectory = options.copyDirectory ?? copyDirectorySafe
    this.provenance = options.provenance
    this.packagesRoot = path.resolve(
      options.packagesRoot ??
        path.join(path.dirname(this.userRoot), 'plugin-packages'),
    )
    this.fetchImpl = options.fetchImpl
  }

  list(): Promise<PluginListDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const scan = await this.scan()
      const plugins = scan.candidates.map(c => this.toDetail(c, scan))
      return {
        plugins,
        issues: scan.issues,
        restartRequired: plugins.some(plugin => plugin.restartRequired),
      }
    })
  }

  detail(pluginId: string): Promise<PluginDetailDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      return await this.detailUnlocked(pluginId)
    })
  }

  installFromDirectory(sourcePath: string): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const source = path.resolve(sourcePath)
      await this.assertInstallSource(source)
      const candidate = await readCandidate(source, 'user')
      const pluginId = candidate.manifest.id
      const existing = await this.scan()
      if (existing.candidates.some(c => c.manifest.id === pluginId)) {
        throw new PluginManagementError(
          'E_DUPLICATE_ID',
          `plugin is already installed: ${pluginId}`,
        )
      }

      const plan = new DependencyResolver().resolve(
        [...existing.candidates, candidate],
        {
          kernelVersion: this.kernel.version,
          contractVersion: CONTRACT_VERSION,
          onError: 'graceful',
        },
      )
      if (plan.dropped.includes(pluginId)) {
        const issue = plan.issues.find(
          i => i.pluginId === pluginId && i.level === 'error',
        )
        throw new PluginManagementError(
          'E_DEPENDENCY',
          `plugin cannot be installed: ${issue?.detail ?? 'dependency resolution failed'}`,
        )
      }

      const target = path.join(this.userRoot, pluginId)
      assertInside(this.userRoot, target, 'plugin directory')
      const staging = path.join(
        this.userRoot,
        `.${pluginId}.install-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )
      let committed = false
      try {
        await this.copyDirectory(source, staging)
        const staged = await readCandidate(staging, 'user')
        if (
          staged.manifest.id !== candidate.manifest.id ||
          staged.manifest.version !== candidate.manifest.version ||
          staged.manifest.entry !== candidate.manifest.entry
        ) {
          throw new PluginManagementError(
            'E_MANIFEST_INVALID',
            'plugin files changed during installation',
          )
        }
        await rename(staging, target)
        committed = true
        await this.state.setDisabled(pluginId, true)
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(
          () => undefined,
        )
        if (committed)
          await rm(target, { recursive: true, force: true }).catch(
            () => undefined,
          )
        throw wrapError('E_INSTALL_FAILED', 'plugin installation failed', error)
      }

      return {
        ok: true,
        changed: true,
        restartRequired: false,
        plugin: await this.detailUnlocked(pluginId),
        message:
          'Installed from directory without executing plugin code. Enable it explicitly when ready.',
      }
    })
  }

  /**
   * Download + verify + read a remote package without installing anything.
   *
   * Writes only to the download cache and a temporary extraction directory;
   * never touches plugin roots, disabled intent, or executes plugin code.
   */
  inspectRemote(
    input: { url: string; operationId?: string; onProgress?: ProgressSink },
    signal?: AbortSignal,
  ): Promise<PluginRemoteInspectionDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const operationId = input.operationId ?? this.newOperationId()
      const controller = this.registerOperation(operationId)
      const detach = this.linkAbort(signal, controller)
      const sink: ProgressSink = progress => input.onProgress?.(progress)
      const workDir = this.temporaryPath('inspect', operationId)
      try {
        this.assertNotAborted(controller)
        const release = await this.resolveRelease(input.url)
        this.assertNotAborted(controller)
        const downloaded = await this.ensurePackage(
          release,
          sink,
          controller.signal,
        )
        const trusted = release.sha256
        if (trusted) {
          sink({ phase: 'verifying' })
          await this.verifyPackage(downloaded.zipPath, trusted)
        }
        this.assertNotAborted(controller)
        sink({ phase: 'extracting' })
        const extracted = await extractZipSafe(downloaded.zipPath, workDir)
        const candidate = await readCandidate(extracted.root, 'user')
        await this.assertDependencyPlan(candidate)
        const manifest = candidate.manifest
        return {
          url: input.url,
          downloadUrl: release.downloadUrl,
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          ...(manifest.description
            ? { description: manifest.description }
            : {}),
          requires: [...(manifest.requires ?? [])],
          dependencies: { ...manifest.dependencies },
          optionalDependencies: { ...manifest.optionalDependencies },
          compatibility: { ...manifest.compatibility },
          ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
          ...(release.notes ? { notes: release.notes } : {}),
          ...(trusted ? { sha256: trusted } : {}),
          size: downloaded.bytes,
        }
      } finally {
        detach()
        this.unregisterOperation(operationId, controller)
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        )
      }
    })
  }

  /**
   * Install a remote package. The digest must come from release metadata or the
   * caller; a digest computed from the download itself is never trusted.
   */
  installFromRemote(
    input: { url: string; sha256?: string; operationId: string },
    onProgress?: ProgressSink,
  ): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const provenance = this.requireProvenance()
      const controller = this.registerOperation(input.operationId)
      const sink: ProgressSink = progress => onProgress?.(progress)
      const workDir = this.temporaryPath('install', input.operationId)
      let cachePath: string | undefined
      let committedId: string | undefined
      try {
        if (input.sha256 !== undefined && !isSha256(input.sha256)) {
          throw new PluginManagementError(
            'E_DIGEST_INVALID',
            'expected SHA-256 digest must contain exactly 64 hexadecimal characters',
          )
        }
        this.assertNotAborted(controller)
        const release = await this.resolveRelease(input.url)
        const trusted = input.sha256 ?? release.sha256
        if (!trusted) {
          throw new PluginManagementError(
            'E_DIGEST_MISSING',
            'the release does not publish a SHA-256 digest; installation was blocked',
          )
        }
        const downloaded = await this.ensurePackage(
          release,
          sink,
          controller.signal,
        )
        cachePath = downloaded.zipPath
        sink({ phase: 'verifying' })
        await this.verifyPackage(cachePath, trusted)
        this.assertNotAborted(controller)
        sink({ phase: 'extracting' })
        const extracted = await extractZipSafe(cachePath, workDir)
        const candidate = await readCandidate(extracted.root, 'user')
        const pluginId = candidate.manifest.id
        const existing = await this.scan()
        if (existing.candidates.some(c => c.manifest.id === pluginId)) {
          throw new PluginManagementError(
            'E_DUPLICATE_ID',
            `plugin is already installed: ${pluginId}`,
          )
        }
        await this.assertDependencyPlan(candidate)
        if (this.pendingByPlugin.has(pluginId)) {
          throw new PluginManagementError(
            'E_OPERATION_IN_PROGRESS',
            `another operation is already running for plugin: ${pluginId}`,
          )
        }
        sink({ phase: 'installing' })
        const target = path.join(this.userRoot, pluginId)
        assertInside(this.userRoot, target, 'plugin directory')
        await rename(extracted.root, target)
        committedId = pluginId
        await this.state.setDisabled(pluginId, true)
        await provenance.set(pluginId, {
          kind: 'remote',
          url: input.url,
          sha256: trusted,
          ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
          installedAt: new Date().toISOString(),
        })
        return {
          ok: true,
          changed: true,
          restartRequired: false,
          plugin: await this.detailUnlocked(pluginId),
          message:
            'Installed from remote source without executing plugin code. Enable it explicitly when ready.',
        }
      } catch (error) {
        if (committedId) {
          await rm(path.join(this.userRoot, committedId), {
            recursive: true,
            force: true,
          }).catch(() => undefined)
          await this.state
            .setDisabled(committedId, false)
            .catch(() => undefined)
        }
        if (cachePath)
          await rm(cachePath, { force: true }).catch(() => undefined)
        throw wrapError(
          'E_INSTALL_FAILED',
          'remote plugin installation failed',
          error,
        )
      } finally {
        this.unregisterOperation(input.operationId, controller)
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        )
      }
    })
  }

  /** Cancel an in-flight download/update; repeated calls are no-ops returning false. */
  cancelDownload(operationId: string): boolean {
    const controller = this.operations.get(operationId)
    if (!controller) return false
    this.operations.delete(operationId)
    controller.abort(
      new PluginManagementError('E_CANCELLED', 'download was cancelled'),
    )
    return true
  }

  /** Compare installed remote plugins against their release source. */
  checkUpdates(pluginId?: string): Promise<PluginUpdateCheckDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const provenance = this.requireProvenance()
      const scan = await this.scan()
      const installed = scan.candidates.filter(c => c.source === 'user')
      if (pluginId !== undefined) {
        const candidate = installed.find(c => c.manifest.id === pluginId)
        if (!candidate) {
          throw new PluginManagementError(
            'E_NOT_FOUND',
            `plugin not found: ${pluginId}`,
          )
        }
        if (!provenance.get(pluginId)) {
          throw new PluginManagementError(
            'E_PROVENANCE_MISSING',
            `plugin has no remote provenance: ${pluginId}`,
          )
        }
      }
      const targets = installed.filter(
        candidate =>
          candidate.manifest.id === pluginId ||
          (pluginId === undefined && provenance.get(candidate.manifest.id)),
      )
      const updates: PluginUpdateDto[] = []
      for (const candidate of targets) {
        const entry = provenance.get(candidate.manifest.id)
        if (!entry) continue
        let release: RemoteRelease
        try {
          release = await this.resolveRelease(entry.url)
        } catch (error) {
          // Bulk checks tolerate one unreachable source; a targeted check reports it.
          if (pluginId !== undefined) throw error
          continue
        }
        const latestVersion = release.version || candidate.manifest.version
        updates.push({
          pluginId: candidate.manifest.id,
          currentVersion: candidate.manifest.version,
          latestVersion,
          hasUpdate: isNewerVersion(
            candidate.manifest.version,
            release.version,
          ),
          url: entry.url,
          ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
          ...(release.notes ? { notes: release.notes } : {}),
          ...(release.sha256 ? { sha256: release.sha256 } : {}),
        })
      }
      return { updates }
    })
  }

  /**
   * Replace an installed remote plugin with its newer release and roll back on
   * any failure after the old directory has been moved aside.
   */
  applyUpdate(
    input: { pluginId: string; operationId: string },
    onProgress?: ProgressSink,
  ): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const provenance = this.requireProvenance()
      if (this.pendingByPlugin.has(input.pluginId)) {
        throw new PluginManagementError(
          'E_OPERATION_IN_PROGRESS',
          `another operation is already running for plugin: ${input.pluginId}`,
        )
      }
      this.pendingByPlugin.add(input.pluginId)
      const controller = this.registerOperation(input.operationId)
      const sink: ProgressSink = progress => onProgress?.(progress)
      const workDir = this.temporaryPath('update', input.operationId)
      const target = path.join(this.userRoot, input.pluginId)
      const backup = path.join(
        this.userRoot,
        `.backup-${input.pluginId}-${Date.now()}-${randomBytes(3).toString('hex')}`,
      )
      let backedUp = false
      let installed = false
      let wasLive = false
      let cachePath: string | undefined
      try {
        const scan = await this.scan()
        const candidate = scan.candidates.find(
          c => c.manifest.id === input.pluginId,
        )
        if (!candidate) {
          throw new PluginManagementError(
            'E_NOT_FOUND',
            `plugin not found: ${input.pluginId}`,
          )
        }
        if (candidate.source !== 'user') {
          throw new PluginManagementError(
            'E_BUILTIN_PROTECTED',
            'built-in plugins cannot be updated',
          )
        }
        const entry = provenance.get(input.pluginId)
        if (!entry) {
          throw new PluginManagementError(
            'E_PROVENANCE_MISSING',
            `plugin has no remote provenance: ${input.pluginId}`,
          )
        }
        wasLive = this.isRuntimeLive(input.pluginId)

        const release = await this.resolveRelease(entry.url)
        if (!isNewerVersion(candidate.manifest.version, release.version)) {
          return {
            ok: true,
            changed: false,
            restartRequired: false,
            plugin: await this.detailUnlocked(input.pluginId),
            message: `Plugin is up to date (${candidate.manifest.version}).`,
          }
        }
        if (!release.sha256) {
          throw new PluginManagementError(
            'E_DIGEST_MISSING',
            'the release does not publish a SHA-256 digest; update was blocked',
          )
        }
        this.assertNotAborted(controller)
        const downloaded = await this.ensurePackage(
          release,
          sink,
          controller.signal,
        )
        cachePath = downloaded.zipPath
        sink({ phase: 'verifying' })
        await this.verifyPackage(downloaded.zipPath, release.sha256)
        this.assertNotAborted(controller)
        sink({ phase: 'extracting' })
        const extracted = await extractZipSafe(downloaded.zipPath, workDir)
        const next = await readCandidate(extracted.root, 'user')
        if (next.manifest.id !== input.pluginId) {
          throw new PluginManagementError(
            'E_MANIFEST_INVALID',
            'updated package changes the plugin id',
          )
        }
        await this.assertDependencyPlan(next)

        sink({ phase: 'installing' })
        assertInside(this.userRoot, target, 'plugin directory')
        assertInside(this.userRoot, backup, 'plugin backup directory')
        await rename(target, backup)
        backedUp = true
        await rename(extracted.root, target)
        installed = true
        await this.mergeUserData(backup, target)
        if (wasLive) {
          await this.kernel.restartPlugins(this.state.ids())
          const updated = await this.detailUnlocked(input.pluginId)
          if (updated.state !== 'Active' && updated.state !== 'Degraded') {
            throw new PluginManagementError(
              'E_UPDATE_FAILED',
              `updated plugin did not start: ${updated.state}`,
            )
          }
        }
        await provenance.set(input.pluginId, {
          kind: 'remote',
          url: entry.url,
          sha256: release.sha256,
          ...((release.publishedAt ?? entry.publishedAt)
            ? { publishedAt: release.publishedAt ?? entry.publishedAt }
            : {}),
          installedAt: new Date().toISOString(),
        })
        // The install is already committed; a locked backup must not trigger a
        // rollback that would leave provenance pointing at the removed version.
        await rm(backup, { recursive: true, force: true }).catch(
          () => undefined,
        )
        backedUp = false
        return {
          ok: true,
          changed: true,
          restartRequired: false,
          plugin: await this.detailUnlocked(input.pluginId),
          message: `Updated to ${release.version}${wasLive ? ' and restarted the plugin service.' : '.'}`,
        }
      } catch (error) {
        if (cachePath)
          await rm(cachePath, { force: true }).catch(() => undefined)
        const rollbackIssues: string[] = []
        if (installed) {
          try {
            await rm(target, { recursive: true, force: true })
          } catch (rollbackError) {
            rollbackIssues.push((rollbackError as Error).message)
          }
        }
        if (backedUp) {
          try {
            await rename(backup, target)
          } catch (rollbackError) {
            rollbackIssues.push((rollbackError as Error).message)
          }
        }
        if (wasLive && (backedUp || installed)) {
          try {
            await this.kernel.restartPlugins(this.state.ids())
          } catch (rollbackError) {
            rollbackIssues.push((rollbackError as Error).message)
          }
        }
        if (rollbackIssues.length > 0) {
          throw new PluginManagementError(
            'E_ROLLBACK_FAILED',
            `plugin update failed (${(error as Error).message}) and rollback failed: ${rollbackIssues.join('; ')}`,
            { cause: error },
          )
        }
        throw wrapError(
          'E_UPDATE_FAILED',
          'plugin update failed and the previous version was restored',
          error,
        )
      } finally {
        this.pendingByPlugin.delete(input.pluginId)
        this.unregisterOperation(input.operationId, controller)
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        )
      }
    })
  }

  enable(pluginId: string): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const before = await this.detailUnlocked(pluginId)
      if (
        (before.state === 'Active' || before.state === 'Degraded') &&
        before.enabled
      ) {
        return {
          ok: true,
          changed: false,
          restartRequired: false,
          plugin: before,
        }
      }
      // A prerequisite that is merely disabled is not a broken install: enable
      // the installed hard-dependency closure in the same operation. A truly
      // missing dependency is left to the resolver, which reports it.
      await this.enableDependencyClosure(pluginId)
      await this.kernel.enablePlugin(pluginId, this.state.ids())
      return {
        ok: true,
        changed: true,
        restartRequired: false,
        plugin: await this.detailUnlocked(pluginId),
      }
    })
  }

  disable(pluginId: string): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const before = await this.detailUnlocked(pluginId)
      if (!before.enabled && !this.hasEnabledDependent(pluginId)) {
        return {
          ok: true,
          changed: false,
          restartRequired: before.restartRequired,
          plugin: before,
        }
      }
      // Disabling a prerequisite without its dependents would leave them
      // pointing at a plugin that will not come back after a restart, so the
      // loaded dependent closure is disabled in the same operation.
      const targets = this.dependentClosure(pluginId)
      const changed: string[] = []
      try {
        for (const id of targets) {
          if (this.state.isDisabled(id)) continue
          await this.state.setDisabled(id, true)
          changed.push(id)
        }
      } catch (error) {
        for (const id of changed) {
          await this.state.setDisabled(id, false).catch(() => undefined)
        }
        throw error
      }
      const plugin = await this.detailUnlocked(pluginId)
      return {
        ok: true,
        changed: changed.length > 0,
        restartRequired: [...targets].some(id => this.isRuntimeLive(id)),
        plugin,
      }
    })
  }

  restart(): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      await this.kernel.restartPlugins(this.state.ids())
      return {
        ok: true,
        changed: true,
        restartRequired: false,
      }
    })
  }

  uninstall(pluginId: string): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const scan = await this.scan()
      const candidate = scan.candidates.find(c => c.manifest.id === pluginId)
      if (!candidate)
        throw new PluginManagementError(
          'E_NOT_FOUND',
          `plugin not found: ${pluginId}`,
        )
      if (candidate.source !== 'user') {
        throw new PluginManagementError(
          'E_BUILTIN_PROTECTED',
          'built-in plugins cannot be uninstalled',
        )
      }
      const dependents = scan.candidates.filter(
        c =>
          c.manifest.id !== pluginId &&
          c.manifest.dependencies?.[pluginId] !== undefined,
      )
      if (dependents.length > 0) {
        throw new PluginManagementError(
          'E_DEPENDENTS',
          `plugin is required by: ${dependents.map(c => c.manifest.id).join(', ')}`,
        )
      }

      await this.state.setDisabled(pluginId, true)
      await this.kernel.disablePlugin(pluginId)
      await this.preserveUserFiles(candidate)
      await assertRealDirectoryInside(this.userRoot, candidate.rootDir)
      await rm(candidate.rootDir, { recursive: true, force: false })
      // A stale remote origin would offer updates for a plugin that is gone.
      await this.provenance?.remove(pluginId).catch(() => undefined)
      return {
        ok: true,
        changed: true,
        restartRequired: false,
        message:
          'Plugin removed. Configuration and plugin data were preserved.',
      }
    })
  }

  private async detailUnlocked(pluginId: string): Promise<PluginDetailDto> {
    if (!isValidPluginId(pluginId)) {
      throw new PluginManagementError(
        'E_INVALID_ID',
        `invalid plugin id: ${pluginId}`,
      )
    }
    const scan = await this.scan()
    const candidate = scan.candidates.find(c => c.manifest.id === pluginId)
    if (!candidate)
      throw new PluginManagementError(
        'E_NOT_FOUND',
        `plugin not found: ${pluginId}`,
      )
    return this.toDetail(candidate, scan)
  }

  private async scan(): Promise<{
    candidates: Candidate[]
    issues: string[]
    dropped: string[]
    errors: Map<string, string>
  }> {
    const discovery = new PluginDiscovery()
    const result = await discovery.discoverDetailed({
      roots: [this.userRoot],
      ...(this.builtinRoot ? { builtinRoot: this.builtinRoot } : {}),
      legacyFallback: false,
    })
    const active = result.candidates.filter(
      candidate => !this.state.isDisabled(candidate.manifest.id),
    )
    const plan = new DependencyResolver().resolve(active, {
      kernelVersion: this.kernel.version,
      contractVersion: CONTRACT_VERSION,
      onError: 'graceful',
    })
    const selected = new Map<string, Candidate>()
    for (const step of plan.steps)
      selected.set(step.candidate.manifest.id, step.candidate)
    for (const candidate of result.candidates) {
      if (!selected.has(candidate.manifest.id)) {
        selected.set(candidate.manifest.id, candidate)
      }
    }
    const errors = new Map<string, string>()
    for (const issue of plan.issues) {
      if (issue.level === 'error' && !errors.has(issue.pluginId)) {
        errors.set(issue.pluginId, `${issue.code}: ${issue.detail}`)
      }
    }
    return {
      candidates: [...selected.values()].toSorted((a, b) =>
        a.manifest.id.localeCompare(b.manifest.id, 'en'),
      ),
      issues: result.issues.map(issue => issue.message),
      dropped: plan.dropped,
      errors,
    }
  }

  private toDetail(
    candidate: Candidate,
    scan: { dropped: string[]; errors: Map<string, string> },
  ): PluginDetailDto {
    const manifest = candidate.manifest
    const origin = this.provenance?.get(manifest.id)
    const loaded = this.kernel.pluginRegistry.getLoaded(manifest.id)
    const enabled = !this.state.isDisabled(manifest.id)
    const state = !enabled
      ? 'Disabled'
      : (loaded?.state ??
        (scan.dropped.includes(manifest.id)
          ? 'Dropped'
          : this.kernel.lastStartResult.failed.includes(manifest.id)
            ? 'Failed'
            : 'Stopped'))
    const error = loaded?.health.message ?? scan.errors.get(manifest.id)
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      source: candidate.source,
      state,
      enabled,
      builtin: candidate.builtin,
      ...(error ? { error } : {}),
      entry: manifest.entry,
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
      tags: [...(manifest.tags ?? [])],
      dependencies: { ...manifest.dependencies },
      optionalDependencies: { ...manifest.optionalDependencies },
      requires: [...(manifest.requires ?? [])],
      compatibility: { ...manifest.compatibility },
      canUninstall: candidate.source === 'user',
      restartRequired: !enabled && this.isRuntimeLive(manifest.id),
      ...(origin
        ? {
            origin: {
              kind: 'remote' as const,
              url: origin.url,
              sha256: origin.sha256,
              ...(origin.publishedAt
                ? { publishedAt: origin.publishedAt }
                : {}),
            },
          }
        : {}),
    }
  }

  /** Whether the running service still holds a live instance of this plugin. */
  private isRuntimeLive(pluginId: string): boolean {
    const loaded = this.kernel.pluginRegistry.getLoaded(pluginId)
    if (!loaded) return false
    return (
      loaded.state === 'Active' ||
      loaded.state === 'Degraded' ||
      loaded.state === 'Loaded' ||
      loaded.state === 'Initialized' ||
      loaded.state === 'Configured'
    )
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return
    await this.state.load()
    if (this.provenance) await this.provenance.load()
    await mkdir(this.userRoot, { recursive: true })
    await mkdir(this.dataRoot, { recursive: true })
    const stat = await lstat(this.userRoot)
    const real = await realpath(this.userRoot)
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      path.resolve(real) !== this.userRoot
    ) {
      throw new PluginManagementError(
        'E_PATH_ESCAPE',
        'user plugin root must be a real directory',
      )
    }
    this.ready = true
  }

  private async assertInstallSource(source: string): Promise<void> {
    const stat = await lstat(source).catch(error => {
      throw new PluginManagementError(
        'E_SOURCE_INVALID',
        'plugin source is not accessible',
        {
          cause: error,
        },
      )
    })
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PluginManagementError(
        'E_SOURCE_INVALID',
        'plugin source must be a real directory',
      )
    }
    if (isWithin(source, this.userRoot) || isWithin(this.userRoot, source)) {
      throw new PluginManagementError(
        'E_SOURCE_INVALID',
        'plugin source and managed roots must be separate',
      )
    }
  }

  /**
   * Installed hard-dependency closure of `pluginId`, including itself.
   * Missing dependencies are skipped on purpose: the resolver owns that error.
   */
  private async enableDependencyClosure(pluginId: string): Promise<void> {
    const scan = await this.scan()
    const byId = new Map(scan.candidates.map(c => [c.manifest.id, c]))
    const closure = new Set<string>()
    const visit = (id: string): void => {
      if (closure.has(id)) return
      closure.add(id)
      const candidate = byId.get(id)
      if (!candidate) return
      for (const dep of Object.keys(candidate.manifest.dependencies ?? {})) {
        visit(dep)
      }
    }
    visit(pluginId)
    for (const id of closure) {
      if (!byId.has(id)) continue
      if (this.state.isDisabled(id)) await this.state.setDisabled(id, false)
    }
  }

  /** Targets of a disable: the plugin plus every loaded dependent, transitively. */
  private dependentClosure(pluginId: string): Set<string> {
    const targets = new Set<string>([pluginId])
    let grew = true
    while (grew) {
      grew = false
      for (const loaded of this.kernel.pluginRegistry.allLoaded()) {
        const id = loaded.manifest.id
        if (targets.has(id)) continue
        const deps = Object.keys(loaded.manifest.dependencies ?? {})
        if (!deps.some(dep => targets.has(dep))) continue
        targets.add(id)
        grew = true
      }
    }
    return targets
  }

  private hasEnabledDependent(pluginId: string): boolean {
    for (const id of this.dependentClosure(pluginId)) {
      if (id !== pluginId && !this.state.isDisabled(id)) return true
    }
    return false
  }

  private async preserveUserFiles(candidate: Candidate): Promise<void> {
    for (const name of ['config', 'data']) {
      const source = path.join(candidate.rootDir, name)
      try {
        const stat = await lstat(source)
        if (!stat.isDirectory() && !stat.isSymbolicLink()) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const destination = path.join(this.dataRoot, candidate.manifest.id, name)
      assertInside(this.dataRoot, destination, 'plugin data directory')
      await this.copyDirectory(source, destination, { skipExisting: true })
    }
  }

  /** Copy preserved user files from the backup over the freshly installed tree. */
  private async mergeUserData(
    source: string,
    destination: string,
  ): Promise<void> {
    for (const name of ['config', 'data']) {
      const from = path.join(source, name)
      try {
        const info = await lstat(from)
        if (info.isSymbolicLink() || !info.isDirectory()) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      // User files win: never overwrite an existing config/data entry.
      await this.copyDirectory(from, path.join(destination, name), {
        skipExisting: true,
      })
    }
  }

  private requireProvenance(): PluginProvenanceStore {
    if (!this.provenance) {
      throw new PluginManagementError(
        'E_MANAGER_UNAVAILABLE',
        'plugin provenance store is unavailable',
      )
    }
    return this.provenance
  }

  private async resolveRelease(url: string): Promise<RemoteRelease> {
    return await resolveRemoteRelease(
      url,
      this.fetchImpl ? { fetchImpl: this.fetchImpl } : {},
    )
  }

  /**
   * Verify a cached package against a trusted digest and drop the cache entry
   * on mismatch, so a poisoned cache cannot keep failing every retry.
   */
  private async verifyPackage(
    zipPath: string,
    expected: string,
  ): Promise<void> {
    try {
      await verifyFileDigest(zipPath, expected)
    } catch (error) {
      if (
        error instanceof PluginManagementError &&
        error.code === 'E_DIGEST_MISMATCH'
      ) {
        await rm(zipPath, { force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  /**
   * Return a cached package when it is fresh, otherwise download it.
   *
   * The digest computed by the downloader is intentionally discarded here: only
   * release metadata or an explicit caller digest may be trusted.
   */
  private async ensurePackage(
    release: RemoteRelease,
    sink: ProgressSink,
    signal: AbortSignal,
  ): Promise<{ zipPath: string; bytes: number }> {
    const cachePath = path.join(
      this.packagesRoot,
      `${sha256Hex(release.downloadUrl)}.zip`,
    )
    try {
      const info = await stat(cachePath)
      if (
        info.isFile() &&
        info.size > 0 &&
        Date.now() - info.mtimeMs <= PACKAGE_CACHE_TTL_MS
      ) {
        return { zipPath: cachePath, bytes: info.size }
      }
    } catch {
      // Not cached yet.
    }
    await mkdir(this.packagesRoot, { recursive: true })
    sink({
      phase: 'downloading',
      receivedBytes: 0,
      ...(release.size !== undefined ? { totalBytes: release.size } : {}),
    })
    const result = await downloadPackage({
      url: release.downloadUrl,
      destination: cachePath,
      signal,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      onProgress: (receivedBytes, totalBytes) => {
        sink({
          phase: 'downloading',
          receivedBytes,
          ...(totalBytes !== undefined
            ? { totalBytes }
            : release.size !== undefined
              ? { totalBytes: release.size }
              : {}),
        })
      },
    })
    return { zipPath: cachePath, bytes: result.bytes }
  }

  /**
   * Resolve the candidate against the installed set (same id replaced). Throw
   * when it is dropped for incompatibility or a missing hard dependency;
   * nothing has been written yet at this point.
   */
  private async assertDependencyPlan(candidate: Candidate): Promise<void> {
    const pluginId = candidate.manifest.id
    const scan = await this.scan()
    const others = scan.candidates.filter(c => c.manifest.id !== pluginId)
    const plan = new DependencyResolver().resolve([...others, candidate], {
      kernelVersion: this.kernel.version,
      contractVersion: CONTRACT_VERSION,
      onError: 'graceful',
    })
    if (!plan.dropped.includes(pluginId)) return
    const issue = plan.issues.find(
      i => i.pluginId === pluginId && i.level === 'error',
    )
    throw new PluginManagementError(
      issue?.code === 'E_INCOMPATIBLE' ? 'E_INCOMPATIBLE' : 'E_DEPENDENCY',
      `plugin ${pluginId} cannot be installed: ${issue ? `${issue.code}: ${issue.detail}` : 'dependency resolution failed'}`,
    )
  }

  private temporaryPath(kind: string, operationId: string): string {
    const safeId = operationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
    return path.join(
      this.userRoot,
      `.${kind}-${safeId}-${Date.now()}-${randomBytes(3).toString('hex')}`,
    )
  }

  private registerOperation(operationId: string): AbortController {
    if (this.operations.has(operationId)) {
      throw new PluginManagementError(
        'E_OPERATION_IN_PROGRESS',
        `operation is already running: ${operationId}`,
      )
    }
    const controller = new AbortController()
    this.operations.set(operationId, controller)
    return controller
  }

  private unregisterOperation(
    operationId: string,
    controller: AbortController,
  ): void {
    if (this.operations.get(operationId) === controller) {
      this.operations.delete(operationId)
    }
  }

  private linkAbort(
    signal: AbortSignal | undefined,
    controller: AbortController,
  ): () => void {
    if (!signal) return () => undefined
    const onAbort = (): void => controller.abort(signal.reason)
    if (signal.aborted) {
      onAbort()
      return () => undefined
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => signal.removeEventListener('abort', onAbort)
  }

  private assertNotAborted(controller: AbortController): void {
    if (controller.signal.aborted) {
      throw new PluginManagementError('E_CANCELLED', 'operation was cancelled')
    }
  }

  private newOperationId(): string {
    return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

async function readCandidate(
  rootDir: string,
  source: CandidateSource,
): Promise<Candidate> {
  const raw = await readJsonFile(path.join(rootDir, 'plugin.json'))
  const validation = validateManifest(raw)
  if (!validation.ok || !validation.value) {
    throw new PluginManagementError(
      'E_MANIFEST_INVALID',
      validation.issues
        .map(issue => `${issue.path} ${issue.message}`)
        .join('; '),
    )
  }
  const manifest = validation.value
  let resolved: ReturnType<typeof resolveEntry>
  try {
    resolved = resolveEntry(rootDir, manifest.entry, manifest.id)
  } catch (error) {
    throw new PluginManagementError(
      'E_PATH_ESCAPE',
      'entry escapes the plugin directory',
      {
        cause: error,
      },
    )
  }
  if (!resolved.filePath) {
    throw new PluginManagementError(
      'E_ENTRY_INVALID',
      'entry must be a file inside the plugin directory',
    )
  }
  assertInside(rootDir, resolved.filePath, 'entry')
  const stat = await lstat(resolved.filePath).catch(error => {
    throw new PluginManagementError(
      'E_ENTRY_INVALID',
      'entry file does not exist',
      { cause: error },
    )
  })
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PluginManagementError(
      'E_ENTRY_INVALID',
      'entry must be a regular file',
    )
  }
  const [realRoot, realEntry] = await Promise.all([
    realpath(rootDir),
    realpath(resolved.filePath),
  ])
  assertInside(realRoot, realEntry, 'entry')
  return {
    manifest,
    rootDir,
    source,
    builtin: source === 'builtin',
    legacy: false,
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function wrapError(code: string, message: string, error: unknown): Error {
  if (error instanceof PluginManagementError) return error
  return new PluginManagementError(
    code,
    `${message}: ${(error as Error).message}`,
    {
      cause: error,
    },
  )
}
