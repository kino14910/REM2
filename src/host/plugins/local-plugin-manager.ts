import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
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
  PluginListDto,
  PluginOperationResultDto,
} from '../../shared/ipc-contract.js'
import { PluginManagementError } from './errors.js'
import { PluginStateStore } from './state-store.js'
import {
  assertInside,
  assertRealDirectoryInside,
  copyDirectorySafe,
  readJsonFile,
} from './safe-fs.js'

export interface LocalPluginManagerOptions {
  kernel: Kernel
  userRoot: string
  dataRoot: string
  state: PluginStateStore
  builtinRoot?: string
  copyDirectory?: typeof copyDirectorySafe
}

export class LocalPluginManager {
  private readonly kernel: Kernel
  private readonly userRoot: string
  private readonly dataRoot: string
  private readonly state: PluginStateStore
  private readonly builtinRoot?: string
  private readonly copyDirectory: typeof copyDirectorySafe
  private ready = false
  private queue: Promise<void> = Promise.resolve()

  constructor(options: LocalPluginManagerOptions) {
    this.kernel = options.kernel
    this.userRoot = path.resolve(options.userRoot)
    this.dataRoot = path.resolve(options.dataRoot)
    this.state = options.state
    this.builtinRoot = options.builtinRoot
    this.copyDirectory = options.copyDirectory ?? copyDirectorySafe
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
