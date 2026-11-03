import { createHash, randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { Kernel } from '@/kernel/kernel.js'
import { CONTRACT_VERSION } from '@/kernel/version.js'
import { PluginDiscovery } from '@/kernel/discovery/discovery.js'
import {
  validateManifest,
  isValidPluginId,
} from '@/kernel/discovery/manifest-validator.js'
import { DependencyResolver } from '@/kernel/dependency/resolver.js'
import { resolveEntry } from '@/kernel/loader/module-resolver.js'
import type {
  Candidate,
  CandidateSource,
} from '@/kernel/discovery/candidate.js'
import type {
  PluginDetailDto,
  PluginDownloadPhase,
  PluginListDto,
  PluginOperationResultDto,
  PluginOriginDto,
  PluginRemoteInspectionDto,
  PluginUpdateCheckDto,
  PluginUpdateDto,
} from '@/shared/ipc-contract.js'
import { PluginManagementError } from './errors.js'
import { PluginStateStore } from './state-store.js'
import { isSha256, verifyFileDigest } from './integrity.js'
import { downloadPackage } from './remote-download.js'
import { extractZipSafe } from './zip-extract.js'
import { resolveRemoteRelease, type RemoteRelease } from './release-source.js'
import {
  PluginProvenanceStore,
  type PluginProvenance,
} from './provenance-store.js'
import {
  PluginRemovedStore,
  type RemovedPluginRecord,
} from './removed-plugin-store.js'
import { PluginGrantStore } from './grant-store.js'
import {
  PluginUpdateJournal,
  type UpdateTransactionRecord,
  type UpdateTransactionStage,
} from './transaction-journal.js'
import { isNewerVersion } from './update-compare.js'
import { PermissionManager } from '@/kernel/security/permission-manager.js'
import { trustLevelFor } from '@/kernel/security/trust-policy.js'
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

/** Read-only manifest preview of a directory that is about to be installed. */
export interface DirectoryInstallInspection {
  id: string
  name: string
  version: string
  requires: string[]
  dependencies: Record<string, string>
}

/** Stable snapshot of the installed set used for DTO projections. */
interface PluginScanResult {
  candidates: Candidate[]
  issues: string[]
  dropped: string[]
  errors: Map<string, string>
}

export type ProgressSink = (progress: RemoteProgress) => void

/** What the user saw in a native confirmation dialog. */
export interface PluginTargetExpectation {
  version: string
  sha256?: string
}

export interface LocalPluginManagerOptions {
  kernel: Kernel
  userRoot: string
  dataRoot: string
  state: PluginStateStore
  builtinRoot?: string
  copyDirectory?: typeof copyDirectorySafe
  /** Remote installs keep their source URL/digest here; absent = remote operations unavailable. */
  provenance?: PluginProvenanceStore
  /** Explicit capability grants for user-installed plugins; absent = no grant management. */
  grants?: PluginGrantStore
  /** Records of uninstalled plugins so they stay listed and can be installed again. */
  removed?: PluginRemovedStore
  /** Download cache directory; defaults to `<userData>/plugin-packages`. */
  packagesRoot?: string
  /** Update journal directory; defaults to `<userData>/plugin-transactions`. */
  transactionsRoot?: string
  /** Injected for tests; production uses the Electron session `fetch` adapter. */
  fetchImpl?: typeof fetch
  /**
   * Redirect handling for package downloads. Production uses `manual` through
   * the Electron ClientRequest adapter, so every hop can be allowlisted.
   */
  downloadRedirectMode?: 'manual' | 'follow'
}

export class LocalPluginManager {
  private readonly kernel: Kernel
  /** Canonicalized in ensureReady(): Windows temp paths may use 8.3 aliases. */
  private userRoot: string
  private readonly dataRoot: string
  private readonly state: PluginStateStore
  private readonly builtinRoot?: string
  private readonly copyDirectory: typeof copyDirectorySafe
  private readonly provenance?: PluginProvenanceStore
  private readonly grants?: PluginGrantStore
  private readonly removed?: PluginRemovedStore
  private readonly packagesRoot: string
  private readonly transactionsRoot: string
  private readonly fetchImpl?: typeof fetch
  private readonly downloadRedirectMode: 'manual' | 'follow'
  private ready = false
  private readyPromise?: Promise<void>
  private recovered = false
  private journal?: PluginUpdateJournal
  private readonly recoveryIssues: string[] = []
  /** Incremented around directory commits; public reads retry across them. */
  private commitEpoch = 0
  private activeCommit?: { promise: Promise<void>; release: () => void }
  private queue: Promise<void> = Promise.resolve()
  /** Active download/update operations keyed by the renderer-generated id (cancellation handle). */
  private readonly operations = new Map<string, AbortController>()
  /** Operations past the point where cancellation can be honoured safely. */
  private readonly uncancellable = new Set<string>()

  constructor(options: LocalPluginManagerOptions) {
    this.kernel = options.kernel
    this.userRoot = path.resolve(options.userRoot)
    this.dataRoot = path.resolve(options.dataRoot)
    this.state = options.state
    this.builtinRoot = options.builtinRoot
    this.copyDirectory = options.copyDirectory ?? copyDirectorySafe
    this.provenance = options.provenance
    this.grants = options.grants
    this.removed = options.removed
    this.packagesRoot = path.resolve(
      options.packagesRoot ??
        path.join(path.dirname(this.userRoot), 'plugin-packages'),
    )
    this.transactionsRoot = path.resolve(
      options.transactionsRoot ??
        path.join(path.dirname(this.userRoot), 'plugin-transactions'),
    )
    this.fetchImpl = options.fetchImpl
    this.downloadRedirectMode = options.downloadRedirectMode ?? 'manual'
  }

  /**
   * Read-only projections intentionally bypass the mutation queue: a long
   * download must not make the UI time out while merely refreshing the list.
   * They only read stable snapshots; hidden staging/backup directories are not
   * discovered as plugins.
   */
  async list(): Promise<PluginListDto> {
    await this.ensureReady()
    const scan = await this.readStable(() => this.scan())
    const plugins = scan.candidates.map(c => this.toDetail(c, scan))
    const installed = new Set(plugins.map(plugin => plugin.id))
    // Uninstalled plugins stay visible: the code is gone, but the record keeps
    // them installable instead of silently dropping them from the manager list.
    for (const record of this.removed?.entriesOf() ?? []) {
      if (installed.has(record.manifest.id)) continue
      plugins.push(this.toRemovedDetail(record))
    }
    plugins.sort((left, right) => left.id.localeCompare(right.id, 'en'))
    return {
      plugins,
      issues: [...this.recoveryIssues, ...scan.issues],
      restartRequired: plugins.some(plugin => plugin.restartRequired),
    }
  }

  async detail(pluginId: string): Promise<PluginDetailDto> {
    await this.ensureReady()
    return await this.readStable(async () => {
      try {
        return await this.detailUnlocked(pluginId)
      } catch (error) {
        if (
          error instanceof PluginManagementError &&
          error.code === 'E_NOT_FOUND'
        ) {
          const record = this.removed?.get(pluginId)
          if (record) return this.toRemovedDetail(record)
        }
        throw error
      }
    })
  }

  /** Run before kernel.start(): recover interrupted updates and stale staging. */
  async prepare(): Promise<void> {
    await this.ensureReady()
    if (this.recovered) return
    this.recovered = true
    await this.recoverInterruptedOperations()
  }

  /**
   * Read the manifest of a directory that is about to be installed, so the
   * caller can ask for capability approval before any file is copied.
   */
  async inspectDirectory(
    sourcePath: string,
  ): Promise<DirectoryInstallInspection> {
    await this.ensureReady()
    const source = path.resolve(sourcePath)
    await this.assertInstallSource(source)
    const { candidate } = await this.inspectInstallCandidate(source)
    const manifest = candidate.manifest
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      requires: [...(manifest.requires ?? [])],
      dependencies: { ...manifest.dependencies },
    }
  }

  /**
   * Install a directory enabled by default. Capabilities approved during the
   * install confirmation are persisted before the directory becomes visible,
   * so the plugin starts with them on the first try.
   */
  installFromDirectory(
    sourcePath: string,
    options: { capabilities?: readonly string[] } = {},
  ): Promise<PluginOperationResultDto> {
    const approved = options.capabilities ?? []
    return this.serialize(async () => {
      await this.ensureReady()
      const source = path.resolve(sourcePath)
      await this.assertInstallSource(source)
      const { candidate, scan: existing } =
        await this.inspectInstallCandidate(source)
      this.assertApprovedCapabilities(candidate, approved)
      const pluginId = candidate.manifest.id

      const target = path.join(this.userRoot, pluginId)
      assertInside(this.userRoot, target, 'plugin directory')
      const staging = path.join(
        this.userRoot,
        `.${pluginId}.install-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )
      let committed = false
      let installed: Candidate | undefined
      let grantsWritten = false
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
        // Approve against the files that are actually committed, not the source
        // snapshot read before the copy.
        this.assertApprovedCapabilities(staged, approved)
        // Persist grants and the enabled intent before the directory becomes
        // visible: a crash must never expose an approved plugin without its
        // grants or a stale disabled tombstone.
        if (approved.length > 0) {
          await this.requireGrants().set(pluginId, approved)
          grantsWritten = true
        }
        if (this.state.isDisabled(pluginId)) {
          await this.state.setDisabled(pluginId, false)
        }
        await rename(staging, target)
        committed = true
        installed = { ...staged, rootDir: target }
        // A successful install replaces any NotInstalled entry for this id.
        await this.removed?.remove(pluginId).catch(() => undefined)
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(
          () => undefined,
        )
        if (committed)
          await rm(target, { recursive: true, force: true }).catch(
            () => undefined,
          )
        if (grantsWritten)
          await this.grants?.remove(pluginId).catch(() => undefined)
        // Only a committed directory needs a disabled tombstone: if its cleanup
        // fails, an enabled intent could otherwise execute a plugin whose
        // install was reported as failed. A failure before the rename leaves no
        // directory to execute, and must not disable an already-installed id.
        if (committed) {
          await this.state.setDisabled(pluginId, true).catch(() => undefined)
        }
        throw wrapError('E_INSTALL_FAILED', 'plugin installation failed', error)
      }

      const startError = await this.enableInstalled(pluginId)
      return {
        ok: true,
        changed: true,
        restartRequired: false,
        // Build the projection from the verified staged candidate: a later
        // discovery failure must not turn a committed install into an error.
        plugin: this.toDetail(installed!, {
          dropped: existing.dropped,
          errors: existing.errors,
        }),
        message: startError
          ? `Installed and enabled, but the plugin did not start: ${startError}`
          : approved.length > 0
            ? 'Installed, capabilities approved and enabled.'
            : 'Installed and enabled.',
      }
    })
  }

  /**
   * Download + verify + read a remote package without installing anything.
   *
   * Writes only to the download cache and a temporary extraction directory;
   * never touches plugin roots, disabled intent, or executes plugin code.
   */
  async inspectRemote(
    input: { url: string; operationId?: string; onProgress?: ProgressSink },
    signal?: AbortSignal,
  ): Promise<PluginRemoteInspectionDto> {
    const operationId = input.operationId ?? this.newOperationId()
    const controller = this.registerOperation(operationId)
    const detach = this.linkAbort(signal, controller)
    const sink: ProgressSink = progress => input.onProgress?.(progress)
    try {
      return await this.serialize(async () => {
        await this.ensureReady()
        this.assertNotAborted(controller)
        const workDir = this.temporaryPath('inspect', operationId)
        try {
          const release = await this.resolveRelease(
            input.url,
            controller.signal,
          )
          this.assertNotAborted(controller)
          const downloaded = await this.ensurePackage(
            release,
            sink,
            controller.signal,
            release.sha256,
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
          this.assertNotAborted(controller)
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
            ...(release.publishedAt
              ? { publishedAt: release.publishedAt }
              : {}),
            ...(release.notes ? { notes: release.notes } : {}),
            ...(trusted ? { sha256: trusted } : {}),
            size: downloaded.bytes,
          }
        } finally {
          await rm(workDir, { recursive: true, force: true }).catch(
            () => undefined,
          )
        }
      })
    } finally {
      detach()
      this.unregisterOperation(operationId, controller)
    }
  }

  /**
   * Install a remote package. The digest must come from release metadata or the
   * caller; a digest computed from the download itself is never trusted.
   */
  async installFromRemote(
    input: {
      url: string
      sha256?: string
      operationId: string
      /** Capabilities approved during the install confirmation. */
      capabilities?: readonly string[]
    },
    onProgress?: ProgressSink,
  ): Promise<PluginOperationResultDto> {
    const approved = input.capabilities ?? []
    // Register before entering the mutation queue: a queued operation can then
    // be cancelled and will abort as soon as it reaches the front of the queue.
    const controller = this.registerOperation(input.operationId)
    const sink: ProgressSink = progress => onProgress?.(progress)
    try {
      return await this.serialize(async () => {
        await this.ensureReady()
        this.assertNotAborted(controller)
        const provenance = this.requireProvenance()
        const workDir = this.temporaryPath('install', input.operationId)
        let cachePath: string | undefined
        let pluginId: string | undefined
        let committed = false
        let provenanceWritten = false
        let grantsWritten = false
        try {
          if (input.sha256 !== undefined && !isSha256(input.sha256)) {
            throw new PluginManagementError(
              'E_DIGEST_INVALID',
              'expected SHA-256 digest must contain exactly 64 hexadecimal characters',
            )
          }
          const release = await this.resolveRelease(
            input.url,
            controller.signal,
          )
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
            trusted,
          )
          cachePath = downloaded.zipPath
          sink({ phase: 'verifying' })
          await this.verifyPackage(cachePath, trusted)
          this.assertNotAborted(controller)
          sink({ phase: 'extracting' })
          const extracted = await extractZipSafe(cachePath, workDir)
          const candidate = await readCandidate(extracted.root, 'user')
          pluginId = candidate.manifest.id
          const existing = await this.scan()
          if (existing.candidates.some(c => c.manifest.id === pluginId)) {
            throw new PluginManagementError(
              'E_DUPLICATE_ID',
              `plugin is already installed: ${pluginId}`,
            )
          }
          await this.assertDependencyPlan(candidate)
          this.assertApprovedCapabilities(candidate, approved)
          sink({ phase: 'installing' })
          // A progress listener may cancel synchronously. Check before entering
          // the commit section, then refuse further cancellation because the
          // grants, directory swap and provenance write must complete atomically.
          this.assertNotAborted(controller)
          this.uncancellable.add(input.operationId)
          const target = path.join(this.userRoot, pluginId)
          assertInside(this.userRoot, target, 'plugin directory')
          // Persist grants and the enabled intent before the directory becomes
          // discoverable; the plugin is approved at install time and starts
          // immediately after the commit.
          if (approved.length > 0) {
            await this.requireGrants().set(pluginId, approved)
            grantsWritten = true
          }
          if (this.state.isDisabled(pluginId)) {
            await this.state.setDisabled(pluginId, false)
          }
          await rename(extracted.root, target)
          committed = true
          await provenance.set(pluginId, {
            kind: 'remote',
            url: input.url,
            sha256: trusted,
            ...(release.publishedAt
              ? { publishedAt: release.publishedAt }
              : {}),
            installedAt: new Date().toISOString(),
          })
          provenanceWritten = true
          // A successful install replaces any NotInstalled entry for this id.
          await this.removed?.remove(pluginId).catch(() => undefined)
          const startError = await this.enableInstalled(pluginId)
          return {
            ok: true,
            changed: true,
            restartRequired: false,
            plugin: this.toDetail(
              { ...candidate, rootDir: target },
              { dropped: [], errors: new Map() },
            ),
            message: startError
              ? `Installed and enabled, but the plugin did not start: ${startError}`
              : approved.length > 0
                ? 'Installed from remote source, capabilities approved and enabled.'
                : 'Installed from remote source and enabled.',
          }
        } catch (error) {
          if (committed && pluginId) {
            await rm(path.join(this.userRoot, pluginId), {
              recursive: true,
              force: true,
            }).catch(() => undefined)
          }
          if (provenanceWritten && pluginId) {
            await provenance.remove(pluginId).catch(() => undefined)
          }
          if (grantsWritten && pluginId) {
            await this.grants?.remove(pluginId).catch(() => undefined)
          }
          // Only a committed directory needs a disabled tombstone: a failed
          // cleanup must not turn into code execution on next boot, but a
          // failure before the rename must not disable an already-installed id.
          if (committed && pluginId) {
            await this.state.setDisabled(pluginId, true).catch(() => undefined)
          }
          if (cachePath)
            await rm(cachePath, { force: true }).catch(() => undefined)
          throw wrapError(
            'E_INSTALL_FAILED',
            'remote plugin installation failed',
            error,
          )
        } finally {
          await rm(workDir, { recursive: true, force: true }).catch(
            () => undefined,
          )
        }
      })
    } finally {
      this.unregisterOperation(input.operationId, controller)
    }
  }

  /**
   * Install an uninstalled plugin again from the source recorded when it was
   * removed. Remote records are pinned to the recorded digest, so the exact
   * version the user had is restored instead of silently picking a newer one.
   *
   * Directory records have no replayable source (only the selected folder was
   * known), so they must go through the native folder chooser instead.
   */
  async reinstall(pluginId: string): Promise<PluginOperationResultDto> {
    await this.ensureReady()
    if (!isValidPluginId(pluginId)) {
      throw new PluginManagementError(
        'E_INVALID_ID',
        `invalid plugin id: ${pluginId}`,
      )
    }
    const record = this.removed?.get(pluginId)
    if (!record) {
      throw new PluginManagementError(
        'E_NOT_FOUND',
        `uninstalled plugin not found: ${pluginId}`,
      )
    }
    const origin = record.origin
    if (!origin || origin.kind !== 'remote' || !origin.url || !origin.sha256) {
      throw new PluginManagementError(
        'E_SOURCE_INVALID',
        'this plugin was installed from a local directory; choose its folder to install it again',
      )
    }
    const existing = await this.scan()
    if (existing.candidates.some(c => c.manifest.id === pluginId)) {
      throw new PluginManagementError(
        'E_DUPLICATE_ID',
        `plugin is already installed: ${pluginId}`,
      )
    }
    return await this.installFromRemote({
      url: origin.url,
      sha256: origin.sha256,
      operationId: this.newOperationId(),
      capabilities: record.manifest.requires ?? [],
    })
  }

  /** Cancel an in-flight download/update; repeated calls are no-ops returning false. */
  cancelDownload(operationId: string): boolean {
    const controller = this.operations.get(operationId)
    if (!controller || this.uncancellable.has(operationId)) return false
    this.operations.delete(operationId)
    controller.abort(
      new PluginManagementError('E_CANCELLED', 'operation was cancelled'),
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
      const issues: string[] = []
      for (const candidate of targets) {
        const targetId = candidate.manifest.id
        const entry = provenance.get(targetId)
        if (!entry) continue
        let release: RemoteRelease
        try {
          release = await this.resolveRelease(entry.url)
        } catch (error) {
          // A bulk check keeps going, but must not present a source failure as
          // "no update"; a targeted check surfaces the original error.
          if (pluginId !== undefined) throw error
          issues.push(`${targetId}: ${(error as Error).message}`)
          continue
        }
        const hasUpdate = isNewerVersion(
          candidate.manifest.version,
          release.version,
        )
        if (hasUpdate && !release.sha256) {
          issues.push(
            `${targetId}: the release does not publish a SHA-256 digest, so the update cannot be applied`,
          )
        }
        const latestVersion = release.version || candidate.manifest.version
        updates.push({
          pluginId: targetId,
          currentVersion: candidate.manifest.version,
          latestVersion,
          hasUpdate,
          url: entry.url,
          ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
          ...(release.notes ? { notes: release.notes } : {}),
          ...(release.sha256 ? { sha256: release.sha256 } : {}),
        })
      }
      return { updates, issues }
    })
  }

  /**
   * Replace an installed remote plugin with its newer release and roll back on
   * any failure after the old directory has been moved aside.
   */
  async applyUpdate(
    input: {
      pluginId: string
      operationId: string
      /** Version and digest the user actually confirmed in the update dialog. */
      expectedVersion: string
      expectedSha256: string
    },
    onProgress?: ProgressSink,
  ): Promise<PluginOperationResultDto> {
    if (!isSha256(input.expectedSha256)) {
      throw new PluginManagementError(
        'E_DIGEST_INVALID',
        'expected SHA-256 digest must contain exactly 64 hexadecimal characters',
      )
    }
    const controller = this.registerOperation(input.operationId)
    const sink: ProgressSink = progress => onProgress?.(progress)
    try {
      return await this.serialize(async () => {
        await this.ensureReady()
        this.assertNotAborted(controller)
        const provenance = this.requireProvenance()
        const workDir = this.temporaryPath('update', input.operationId)
        const target = path.join(this.userRoot, input.pluginId)
        const backup = path.join(
          this.userRoot,
          `.backup-${input.pluginId}-${Date.now()}-${randomBytes(3).toString('hex')}`,
        )
        let wasLive = false
        let transactionHandled = false
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

          const release = await this.resolveRelease(
            entry.url,
            controller.signal,
          )
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
          // Bind the operation to the values shown in the confirmation dialog.
          // Re-resolving "latest" is not consent for a different release.
          if (
            release.version !== input.expectedVersion ||
            release.sha256.toLowerCase() !== input.expectedSha256.toLowerCase()
          ) {
            throw new PluginManagementError(
              'E_UPDATE_CHANGED',
              'the release changed after it was checked; review the update again',
            )
          }
          const downloaded = await this.ensurePackage(
            release,
            sink,
            controller.signal,
            release.sha256,
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
          if (next.manifest.version !== release.version) {
            throw new PluginManagementError(
              'E_MANIFEST_INVALID',
              `updated package version ${next.manifest.version} does not match release ${release.version}`,
            )
          }
          await this.assertDependencyPlan(next)
          await this.assertUserDataTreesSafe(target)
          this.assertNotAborted(controller)

          sink({ phase: 'installing' })
          this.assertNotAborted(controller)
          this.uncancellable.add(input.operationId)
          assertInside(this.userRoot, target, 'plugin directory')
          assertInside(this.userRoot, backup, 'plugin backup directory')
          const nextProvenance: PluginProvenance = {
            kind: 'remote',
            url: entry.url,
            sha256: release.sha256,
            ...((release.publishedAt ?? entry.publishedAt)
              ? { publishedAt: release.publishedAt ?? entry.publishedAt }
              : {}),
            installedAt: new Date().toISOString(),
          }
          const previousDisabled = this.state.isDisabled(input.pluginId)
          const requiresCapabilityConsent =
            wasLive && this.hasDeniedCapabilities(next)
          const journal = this.journal
          if (!journal) {
            throw new PluginManagementError(
              'E_MANAGER_UNAVAILABLE',
              'update journal is unavailable',
            )
          }
          transactionHandled = true

          return await this.withCommit(async () => {
            let backedUp = false
            let installed = false
            let committed = false
            let provenanceWritten = false
            let disabledForConsent = false
            const transactionBase = {
              version: 1 as const,
              pluginId: input.pluginId,
              backupName: path.basename(backup),
              workName: path.basename(workDir),
              previousDisabled,
              previousProvenance: entry,
              nextProvenance,
            }
            try {
              await journal.record({
                ...transactionBase,
                stage: 'prepared' satisfies UpdateTransactionStage,
              })
              await rename(target, backup)
              backedUp = true
              await journal.record({
                ...transactionBase,
                stage: 'backed-up' satisfies UpdateTransactionStage,
              })
              await rename(extracted.root, target)
              installed = true
              await this.mergeUserData(backup, target)
              await journal.record({
                ...transactionBase,
                stage: 'installed' satisfies UpdateTransactionStage,
              })
              if (wasLive) {
                if (requiresCapabilityConsent) {
                  // Never silently start code with permissions the user has not
                  // approved. Install the update disabled and let the normal
                  // grant-and-enable flow ask for the new capabilities.
                  await this.state.setDisabled(input.pluginId, true)
                  disabledForConsent = true
                  await this.kernel.restartPlugins(this.state.ids())
                } else {
                  await this.kernel.restartPlugins(this.state.ids())
                  const updated = this.toDetail(
                    { ...next, rootDir: target },
                    { dropped: [], errors: new Map() },
                  )
                  if (
                    updated.state !== 'Active' &&
                    updated.state !== 'Degraded'
                  ) {
                    throw new PluginManagementError(
                      'E_UPDATE_FAILED',
                      `updated plugin did not start: ${updated.state}`,
                    )
                  }
                }
              }
              await provenance.set(input.pluginId, nextProvenance)
              provenanceWritten = true
              await journal.record({
                ...transactionBase,
                stage: 'committed' satisfies UpdateTransactionStage,
              })
              committed = true

              // Cleanup is post-commit. A locked backup must not roll back an
              // update that is already durable; startup recovery retries it.
              let cleanupPending = false
              try {
                await rm(backup, { recursive: true, force: true })
                backedUp = false
              } catch {
                cleanupPending = true
              }
              try {
                await journal.clear(input.pluginId)
              } catch {
                cleanupPending = true
              }
              const outcome = requiresCapabilityConsent
                ? `Updated to ${release.version}. New capabilities require approval; the plugin was disabled and will not run until enabled.`
                : `Updated to ${release.version}${wasLive ? ' and restarted the plugin service.' : '.'}`
              return {
                ok: true,
                changed: true,
                restartRequired: false,
                plugin: this.toDetail(
                  { ...next, rootDir: target },
                  { dropped: [], errors: new Map() },
                ),
                message: `${outcome}${
                  cleanupPending
                    ? ' Cleanup is pending and will be retried on the next application start.'
                    : ''
                }`,
              }
            } catch (error) {
              if (committed) {
                // New directory and provenance are durable. Never delete the
                // only valid copy because the final DTO projection failed.
                throw new PluginManagementError(
                  'E_UPDATE_COMMITTED',
                  'plugin update completed, but the final status report failed; reload the plugin list',
                  { cause: error },
                )
              }
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
              if (provenanceWritten) {
                try {
                  await this.setProvenance(input.pluginId, entry)
                } catch (rollbackError) {
                  rollbackIssues.push((rollbackError as Error).message)
                }
              }
              if (disabledForConsent) {
                try {
                  await this.state.setDisabled(input.pluginId, false)
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
                // Leave the journal in place so the next startup can retry.
                throw new PluginManagementError(
                  'E_ROLLBACK_FAILED',
                  `plugin update failed (${(error as Error).message}) and rollback failed: ${rollbackIssues.join('; ')}`,
                  { cause: error },
                )
              }
              await journal.clear(input.pluginId).catch(() => undefined)
              throw wrapError(
                'E_UPDATE_FAILED',
                'plugin update failed and the previous version was restored',
                error,
              )
            }
          })
        } catch (error) {
          if (cachePath)
            await rm(cachePath, { force: true }).catch(() => undefined)
          if (transactionHandled) throw error
          throw wrapError(
            'E_UPDATE_FAILED',
            'plugin update failed before any directory change',
            error,
          )
        } finally {
          await rm(workDir, { recursive: true, force: true }).catch(
            () => undefined,
          )
        }
      })
    } finally {
      this.unregisterOperation(input.operationId, controller)
    }
  }

  enable(
    pluginId: string,
    expected?: PluginTargetExpectation,
  ): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const before = await this.detailUnlocked(pluginId)
      this.assertTargetMatches(before, expected)
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

  /**
   * Record explicit capability grants for a user-installed plugin.
   *
   * Grants are additive, persisted, and limited to capabilities the manifest
   * declares. They take effect on the next start of the plugin; built-ins are
   * trusted and cannot be granted.
   */
  grantPermissions(
    pluginId: string,
    capabilities: readonly string[],
    expected?: PluginTargetExpectation,
  ): Promise<PluginOperationResultDto> {
    return this.serialize(async () => {
      await this.ensureReady()
      const scan = await this.scan()
      const candidate = scan.candidates.find(c => c.manifest.id === pluginId)
      if (!candidate) {
        throw new PluginManagementError(
          'E_NOT_FOUND',
          `plugin not found: ${pluginId}`,
        )
      }
      if (candidate.source !== 'user') {
        throw new PluginManagementError(
          'E_BUILTIN_PROTECTED',
          'built-in plugins are trusted and cannot be granted capabilities',
        )
      }
      this.assertTargetMatches(await this.detailUnlocked(pluginId), expected)
      const declared = new Set(candidate.manifest.requires ?? [])
      const unknown = capabilities.filter(
        capability => !declared.has(capability),
      )
      if (unknown.length > 0) {
        throw new PluginManagementError(
          'E_CAPABILITY_INVALID',
          `plugin ${pluginId} does not declare: ${unknown.join(', ')}`,
        )
      }
      const grants = this.requireGrants()
      await grants.set(pluginId, capabilities)
      const restartRequired = this.isRuntimeLive(pluginId)
      return {
        ok: true,
        changed: true,
        restartRequired,
        plugin: await this.detailUnlocked(pluginId),
        message:
          'Capabilities granted. Enable or restart the plugin to apply them.',
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

  uninstall(
    pluginId: string,
    expected?: PluginTargetExpectation,
  ): Promise<PluginOperationResultDto> {
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
      this.assertTargetMatches(await this.detailUnlocked(pluginId), expected)

      // Check canonical containment before any state change or file copy: a
      // plugin root that resolves outside the managed root must be rejected
      // while it is still untouched.
      await assertRealDirectoryInside(this.userRoot, candidate.rootDir)
      await this.assertUserDataTreesSafe(candidate.rootDir)
      return await this.withCommit(async () => {
        await this.state.setDisabled(pluginId, true)
        await this.kernel.disablePlugin(pluginId)
        await this.preserveUserFiles(candidate)
        // Keep the plugin in the manager list after the code is gone. Capture
        // the manifest and source before removing provenance.
        await this.recordRemoved(candidate)
        try {
          // Removal failures must surface. Silently keeping grants after deleting
          // the code would let a future same-id install inherit old permissions.
          await this.grants?.remove(pluginId)
          // A stale remote origin would offer updates for a plugin that is gone;
          // the source needed for a reinstall was captured above.
          await this.provenance?.remove(pluginId)
          await rm(candidate.rootDir, { recursive: true, force: false })
        } catch (error) {
          // The code is still installed, so it must not also appear as a
          // NotInstalled entry.
          await this.removed?.remove(pluginId).catch(() => undefined)
          throw error
        }
        return {
          ok: true,
          changed: true,
          restartRequired: false,
          message:
            'Plugin removed. Configuration and plugin data were preserved; it stays listed and can be installed again.',
        }
      })
    })
  }

  private assertTargetMatches(
    detail: PluginDetailDto,
    expected?: PluginTargetExpectation,
  ): void {
    if (!expected) return
    if (
      detail.version !== expected.version ||
      (expected.sha256 !== undefined &&
        detail.origin?.sha256 !== expected.sha256)
    ) {
      throw new PluginManagementError(
        'E_TARGET_CHANGED',
        'the installed plugin changed while confirmation was pending; review it again',
      )
    }
  }

  /** Shared read-only checks for both the install preview and the install itself. */
  private async inspectInstallCandidate(
    source: string,
  ): Promise<{ candidate: Candidate; scan: PluginScanResult }> {
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
    return { candidate, scan: existing }
  }

  /**
   * Approvals are limited to capabilities the manifest declares. The caller
   * (the install confirmation) shows that list to the user first.
   */
  private assertApprovedCapabilities(
    candidate: Candidate,
    capabilities: readonly string[],
  ): void {
    if (capabilities.length === 0) return
    const declared = new Set(candidate.manifest.requires ?? [])
    const unknown = capabilities.filter(capability => !declared.has(capability))
    if (unknown.length > 0) {
      throw new PluginManagementError(
        'E_CAPABILITY_INVALID',
        `plugin ${candidate.manifest.id} does not declare: ${unknown.join(', ')}`,
      )
    }
  }

  /**
   * Start a freshly installed (approved) plugin. A plugin whose code fails to
   * start stays installed and enabled with its health error; install success
   * is about the files, not the plugin's own lifecycle.
   */
  private async enableInstalled(pluginId: string): Promise<string | undefined> {
    try {
      await this.enableDependencyClosure(pluginId)
      await this.kernel.enablePlugin(pluginId, this.state.ids())
      return undefined
    } catch (error) {
      return (error as Error).message
    }
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

  private async scan(): Promise<PluginScanResult> {
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
      permissions: this.permissionsFor(candidate),
      compatibility: { ...manifest.compatibility },
      canUninstall: candidate.source === 'user',
      canInstall: false,
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

  /** Project an uninstalled plugin that stays in the list with an Install action. */
  private toRemovedDetail(record: RemovedPluginRecord): PluginDetailDto {
    const manifest = record.manifest
    const permissions = new PermissionManager().check(
      manifest,
      trustLevelFor('user'),
    )
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      source: 'user',
      state: 'NotInstalled',
      enabled: false,
      builtin: false,
      entry: manifest.entry,
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
      tags: [...(manifest.tags ?? [])],
      dependencies: { ...manifest.dependencies },
      optionalDependencies: { ...manifest.optionalDependencies },
      requires: [...(manifest.requires ?? [])],
      permissions: {
        granted: [...permissions.granted].toSorted(byName),
        denied: [...permissions.denied].toSorted(byName),
      },
      compatibility: { ...manifest.compatibility },
      canUninstall: false,
      canInstall: true,
      restartRequired: false,
      ...(record.origin ? { origin: { ...record.origin } } : {}),
    }
  }

  /**
   * Capture what is needed to list the plugin after uninstall and to install it
   * again: the manifest snapshot plus the recorded remote source (if any).
   */
  private async recordRemoved(candidate: Candidate): Promise<void> {
    if (!this.removed) return
    const provenance = this.provenance?.get(candidate.manifest.id)
    const origin: PluginOriginDto = provenance
      ? {
          kind: 'remote',
          url: provenance.url,
          sha256: provenance.sha256,
          ...(provenance.publishedAt
            ? { publishedAt: provenance.publishedAt }
            : {}),
        }
      : { kind: 'directory' }
    await this.removed.set(candidate.manifest.id, {
      manifest: candidate.manifest,
      origin,
      removedAt: new Date().toISOString(),
    })
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
    // Read projections no longer share the mutation queue, so initialization
    // must also be single-flight or two callers could load the stores twice.
    this.readyPromise ??= this.initialize().catch(error => {
      this.readyPromise = undefined
      throw error
    })
    await this.readyPromise
  }

  private async initialize(): Promise<void> {
    await this.state.load()
    if (this.provenance) await this.provenance.load()
    if (this.grants) await this.grants.load()
    if (this.removed) await this.removed.load()
    await mkdir(this.userRoot, { recursive: true })
    await mkdir(this.dataRoot, { recursive: true })
    const rootStat = await lstat(this.userRoot)
    const real = await realpath(this.userRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new PluginManagementError(
        'E_PATH_ESCAPE',
        'user plugin root must be a real directory',
      )
    }
    // Adopt the canonical path instead of requiring it to equal the configured
    // one: Windows short (8.3) temp paths and case differences are aliases of
    // the same real directory, and lexical containment checks must use one form.
    this.userRoot = path.resolve(real)
    this.journal = new PluginUpdateJournal(this.transactionsRoot)
    this.ready = true
  }

  /** Read a projection without observing an in-flight directory commit. */
  private async readStable<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const epoch = this.commitEpoch
      if (this.activeCommit) await this.activeCommit.promise
      const value = await read()
      if (epoch === this.commitEpoch && !this.activeCommit) return value
    }
    if (this.activeCommit) await this.activeCommit.promise
    return await read()
  }

  /** Run a destructive directory swap; public reads retry around it. */
  private async withCommit<T>(operation: () => Promise<T>): Promise<T> {
    this.commitEpoch += 1
    let release!: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    const owner = { promise, release }
    this.activeCommit = owner
    try {
      return await operation()
    } finally {
      release()
      if (this.activeCommit === owner) this.activeCommit = undefined
    }
  }

  private async recoverInterruptedOperations(): Promise<void> {
    const journal = this.journal
    const provenance = this.provenance
    if (!journal || !provenance) return
    let records: UpdateTransactionRecord[]
    try {
      records = await journal.list()
    } catch (error) {
      console.error('[rem2-kernel] Update journal could not be read:', error)
      this.recoveryIssues.push(
        'The update journal could not be read; orphaned backups will still be checked',
      )
      records = []
    }
    const referenced = new Set(records.map(record => record.backupName))
    for (const record of records) {
      try {
        await this.recoverTransaction(record)
        // Only a completed recovery drops the record; a failed backup deletion
        // must keep it so the next start can retry.
        await journal.clear(record.pluginId)
      } catch (error) {
        console.error(
          `[rem2-kernel] Failed to recover update for ${record.pluginId}:`,
          error,
        )
        this.recoveryIssues.push(
          `${record.pluginId}: an interrupted update could not be recovered automatically`,
        )
      }
    }
    await this.cleanOrphanedArtifacts(referenced)
  }

  private async recoverTransaction(
    record: UpdateTransactionRecord,
  ): Promise<void> {
    const target = path.join(this.userRoot, record.pluginId)
    const backup = path.join(this.userRoot, record.backupName)
    const work = path.join(this.userRoot, record.workName)
    assertInside(this.userRoot, target, 'plugin directory')
    assertInside(this.userRoot, backup, 'plugin backup directory')
    assertInside(this.userRoot, work, 'plugin work directory')

    const targetExists = await pathExists(target)
    const backupExists = await pathExists(backup)
    const keepNew = record.stage === 'committed' && targetExists

    if (keepNew) {
      await this.setProvenance(record.pluginId, record.nextProvenance)
      if (backupExists) await rm(backup, { recursive: true, force: true })
    } else if (backupExists) {
      if (targetExists) await rm(target, { recursive: true, force: false })
      await rename(backup, target)
      await this.setProvenance(record.pluginId, record.previousProvenance)
      await this.state.setDisabled(record.pluginId, record.previousDisabled)
    } else if (targetExists) {
      // The old directory is still in place (crash before the first rename).
      await this.setProvenance(record.pluginId, record.previousProvenance)
      await this.state.setDisabled(record.pluginId, record.previousDisabled)
    } else {
      throw new PluginManagementError(
        'E_ROLLBACK_FAILED',
        `both the plugin and its backup are missing: ${record.pluginId}`,
      )
    }

    if (await pathExists(work)) {
      await rm(work, { recursive: true, force: true })
    }
    // The caller clears the journal record once recovery returns: a committed
    // update whose backup deletion failed keeps its record so the next start
    // retries, and only a successful recovery drops it.
  }

  private async setProvenance(
    pluginId: string,
    entry: PluginProvenance | undefined,
  ): Promise<void> {
    if (!this.provenance) return
    if (entry) await this.provenance.set(pluginId, entry)
    else await this.provenance.remove(pluginId)
  }

  private async cleanOrphanedArtifacts(
    referencedBackups: ReadonlySet<string>,
  ): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.userRoot)
    } catch {
      return
    }
    for (const name of entries) {
      const full = path.join(this.userRoot, name)
      try {
        if (name.startsWith('.backup-') && !referencedBackups.has(name)) {
          const backupStat = await lstat(full)
          if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) {
            throw new PluginManagementError(
              'E_UNSAFE_TREE',
              `orphaned plugin backup is not a real directory: ${name}`,
            )
          }
          const candidate = await readCandidate(full, 'user')
          const target = path.join(this.userRoot, candidate.manifest.id)
          if (await pathExists(target)) {
            const current = await readCandidate(target, 'user').catch(
              () => undefined,
            )
            if (
              current &&
              !isNewerVersion(
                candidate.manifest.version,
                current.manifest.version,
              )
            ) {
              await rm(full, { recursive: true, force: true })
            } else {
              await rm(target, { recursive: true, force: false })
              await rename(full, target)
            }
          } else {
            await rename(full, target)
          }
        } else if (
          name.startsWith('.install-') ||
          name.startsWith('.inspect-') ||
          name.startsWith('.update-')
        ) {
          await rm(full, { recursive: true, force: true })
        }
      } catch (error) {
        console.error(
          `[rem2-kernel] Failed to clean orphaned plugin artifact ${name}:`,
          error,
        )
        this.recoveryIssues.push(
          'An interrupted plugin operation left an artifact that needs manual cleanup',
        )
      }
    }
  }

  private async assertInstallSource(source: string): Promise<void> {
    const sourceStat = await lstat(source).catch(error => {
      throw new PluginManagementError(
        'E_SOURCE_INVALID',
        'plugin source is not accessible',
        {
          cause: error,
        },
      )
    })
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new PluginManagementError(
        'E_SOURCE_INVALID',
        'plugin source must be a real directory',
      )
    }
    // Compare canonical forms: Windows short/case aliases must not bypass the
    // "source and managed roots are separate" check.
    const realSource = path.resolve(await realpath(source))
    if (
      isWithin(realSource, this.userRoot) ||
      isWithin(this.userRoot, realSource)
    ) {
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
    const enabled: string[] = []
    try {
      for (const id of closure) {
        if (!byId.has(id)) continue
        if (!this.state.isDisabled(id)) continue
        await this.state.setDisabled(id, false)
        enabled.push(id)
      }
    } catch (error) {
      // Do not leave a partially enabled dependency closure behind when one
      // state write fails: the operation reports failure, so it must not have
      // changed boot intent either.
      for (const id of enabled) {
        await this.state.setDisabled(id, true).catch(() => undefined)
      }
      throw error
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
        const sourceStat = await lstat(source)
        // Never follow a link out of the plugin tree. Skipping it also keeps a
        // symlink from making an otherwise valid plugin impossible to remove.
        if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const destination = path.join(this.dataRoot, candidate.manifest.id, name)
      assertInside(this.dataRoot, destination, 'plugin data directory')
      // A later uninstall must replace an older preserved snapshot, otherwise
      // the most recent user configuration is silently discarded.
      await this.copyDirectory(source, destination, { overwrite: true })
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
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new PluginManagementError(
            'E_UNSAFE_TREE',
            `plugin ${name}/ must be a real directory before it can be updated`,
          )
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      // User files win: replace defaults shipped inside the new package.
      await this.copyDirectory(from, path.join(destination, name), {
        overwrite: true,
      })
    }
  }

  /**
   * Refuse destructive operations when config/ or data/ is a link or special
   * file. This runs before any state change, so a symlink cannot silently lose
   * data while uninstall still reports success.
   */
  private async assertUserDataTreesSafe(rootDir: string): Promise<void> {
    for (const name of ['config', 'data']) {
      const source = path.join(rootDir, name)
      try {
        const info = await lstat(source)
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new PluginManagementError(
            'E_UNSAFE_TREE',
            `plugin ${name}/ is a link or special file; resolve it before uninstalling`,
          )
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
  }

  /**
   * Project the current authorization decision for the management UI.
   *
   * The live snapshot is authoritative once the plugin has started; for a
   * never-started plugin the trust-policy decision is recomputed from a scratch
   * manager. Persisted grants are overlaid in both cases because they apply on
   * the next start.
   */
  private permissionsFor(candidate: Candidate): {
    granted: string[]
    denied: string[]
  } {
    const declared = candidate.manifest.requires ?? []
    if (declared.length === 0) return { granted: [], denied: [] }
    const loaded = this.kernel.pluginRegistry.getLoaded(candidate.manifest.id)
    const live =
      loaded?.manifest.version === candidate.manifest.version
        ? this.kernel.permissionsOf(candidate.manifest.id)
        : undefined
    const base =
      live ??
      new PermissionManager().check(
        candidate.manifest,
        this.kernel.options.trustLevel ?? trustLevelFor(candidate.source),
      )
    const granted = new Set(base.granted)
    const denied = new Set(base.denied)
    if (!candidate.builtin) {
      for (const capability of this.grants?.get(candidate.manifest.id) ?? []) {
        if (!declared.includes(capability)) continue
        granted.add(capability)
        denied.delete(capability)
      }
    }
    return {
      granted: [...granted].toSorted(byName),
      denied: [...denied].toSorted(byName),
    }
  }

  /**
   * Whether a new manifest would still have denied capabilities after applying
   * the existing grants. Used to stop an update from silently restarting with
   * less authority than the previous version.
   */
  private hasDeniedCapabilities(candidate: Candidate): boolean {
    return this.permissionsFor(candidate).denied.length > 0
  }

  private requireGrants(): PluginGrantStore {
    if (!this.grants) {
      throw new PluginManagementError(
        'E_MANAGER_UNAVAILABLE',
        'plugin grant store is unavailable',
      )
    }
    return this.grants
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

  private async resolveRelease(
    url: string,
    signal?: AbortSignal,
  ): Promise<RemoteRelease> {
    const options = {
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(signal ? { signal } : {}),
    }
    return await resolveRemoteRelease(url, options)
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
   * release metadata or an explicit caller digest may be trusted. When a
   * digest is known it is part of the cache key, so changed bytes behind an
   * unchanged URL cannot be served from the previous release's cache entry.
   */
  private async ensurePackage(
    release: RemoteRelease,
    sink: ProgressSink,
    signal: AbortSignal,
    expectedSha256?: string,
  ): Promise<{ zipPath: string; bytes: number }> {
    const cachePath = path.join(
      this.packagesRoot,
      `${sha256Hex(
        expectedSha256 === undefined
          ? release.downloadUrl
          : `${release.downloadUrl}\0${expectedSha256.toLowerCase()}`,
      )}.zip`,
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
      redirectMode: this.downloadRedirectMode,
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
    this.uncancellable.delete(operationId)
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
  const entryStat = await lstat(resolved.filePath).catch(error => {
    throw new PluginManagementError(
      'E_ENTRY_INVALID',
      'entry file does not exist',
      { cause: error },
    )
  })
  if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
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

function byName(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
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
