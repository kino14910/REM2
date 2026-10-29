/**
 * Kernel orchestration: discover -> resolve -> load and drive lifecycle in
 * topological order -> reclaim.
 *
 * The constructor only accepts injected KernelDeps and never news up any
 * implementation class; all assembly lives in composition.ts. These two files
 * are the repo's only two assembly points (the documented exception to the
 * no-concrete-import rule). Dependency resolution physically precedes any
 * plugin code loading.
 */

import { KERNEL_VERSION, CONTRACT_VERSION } from './version.js'
import type { KernelDeps } from './composition.js'
import { createDeps } from './composition.js'
import type { KernelOptions } from './bootstrap/options.js'
import { Container } from './di/container.js'
import { KERNEL_METRICS } from './contracts/metrics.js'
import { KernelError } from './errors.js'
import { Topics } from './topics.js'
import type { KernelStartResult } from './state-machine.js'
import type { LoadedPlugin } from './extensions/ports-types.js'
import type { Candidate } from './discovery/candidate.js'
import type { HealthReport } from './contracts/health.js'
import type { StopReason } from './contracts/lifecycle.js'
import type { PluginStateT } from './contracts/plugins.js'
import type { Unsubscribe } from './contracts/event-bus.js'
import type { TrustLevel } from './contracts/permission.js'
import { trustLevelFor } from './security/trust-policy.js'
import type { LoadOptions } from './loader/loader.js'
import type { ResolveIssue, ResolutionPlan } from './dependency/resolver.js'

type StartOutcome = 'started' | 'degraded' | 'failed'

export class Kernel {
  readonly id: string
  readonly version = KERNEL_VERSION
  readonly options: KernelOptions

  private readonly deps: KernelDeps

  private started = false
  private reloadCounter = 0
  /** Plugins whose Degraded state is caused solely by missing optional dependencies. */
  private readonly softDegraded = new Set<string>()
  /** Unsubscribe for the kernel's own command dispatcher responder (set in start()). */
  private commandExecuteUnsub: Unsubscribe | null = null
  private startResult: KernelStartResult = {
    loadOrder: [],
    started: [],
    degraded: [],
    failed: [],
    dropped: [],
  }

  constructor(partial: Partial<KernelOptions> | KernelDeps = {}) {
    this.deps = isKernelDeps(partial) ? partial : createDeps(partial)
    this.options = this.deps.options
    this.id = this.options.id
  }

  get tracing(): KernelDeps['tracer'] {
    return this.deps.tracer
  }

  get root(): Container {
    return this.deps.rootContainer
  }

  get pluginRegistry(): KernelDeps['registry'] {
    return this.deps.registry
  }

  /** Extension point registry (used by hosts to register UI-related default implementations). */
  get extensions(): KernelDeps['extensions'] {
    return this.deps.extensions
  }

  get issues(): ReadonlyArray<ResolveIssue> {
    return this.deps.resolveIssues()
  }

  isStarted(): boolean {
    return this.started
  }

  get lastStartResult(): KernelStartResult {
    return this.startResult
  }

  /**
   * Start the kernel: discover -> resolve -> load and start in topological order.
   *
   * Physical order: config snapshot -> discovery -> dependency resolution ->
   * per-plugin loading and lifecycle driving.
   */
  async start(): Promise<KernelStartResult> {
    if (this.started) {
      throw new KernelError('E_ALREADY_STARTED', 'kernel started')
    }
    const log = this.deps.log.child('kernel')
    log.info(`kernel starting v${this.version} (contract v${CONTRACT_VERSION})`)

    // Register the command dispatcher here, before any plugin starts:
    // - `pickResponder` prefers the earliest registration, so this responder
    //   deterministically shadows any plugin-side responder for the same
    //   topic (single dispatch path, no competing command responders).
    // - It is deliberately NOT registered in createDeps(): the recursion
    //   regression sentinel in tests/integration/command-chain.test.ts
    //   registers a rogue responder between construction and start(), and
    //   only this timing keeps its seq smaller so the sentinel still fires.
    this.commandExecuteUnsub = this.deps.events.respond(
      Topics.CommandExecute,
      payload => this.deps.commandDispatcher.dispatch(payload),
    )

    const result = await this.launch()
    log.info(
      `kernel start complete: started=${result.started.length} degraded=${result.degraded.length} failed=${result.failed.length} dropped=${result.dropped.length}`,
    )
    return result
  }

  /**
   * Restart the plugin service in place: stop every loaded plugin, then run
   * discovery/resolution/start again with the current disabled set.
   *
   * Deliberately narrower than shutdown(): the root container, event bus,
   * command dispatcher, log/trace sinks and therefore the host process stay
   * untouched. Plugins are reloaded with a cache-busting query so module-level
   * state does not survive the restart.
   */
  async restartPlugins(
    disabledPluginIds: readonly string[] = this.options.disabledPlugins,
  ): Promise<KernelStartResult> {
    if (!this.started) {
      throw new KernelError('E_GENERIC', 'kernel is not started')
    }
    const log = this.deps.log.child('kernel')
    log.info('restarting plugin service (plugins only)')

    await this.stopAllPlugins()
    this.startResult = {
      loadOrder: [],
      started: [],
      degraded: [],
      failed: [],
      dropped: [],
    }
    const result = await this.launch(disabledPluginIds, {
      cacheBust: `restart-${this.reloadCounter++}`,
    })
    log.info(
      `plugin service restarted: started=${result.started.length} degraded=${result.degraded.length} failed=${result.failed.length} dropped=${result.dropped.length}`,
    )
    return result
  }

  private async launch(
    disabledPluginIds: readonly string[] = this.options.disabledPlugins,
    loadOptions?: LoadOptions,
  ): Promise<KernelStartResult> {
    const log = this.deps.log.child('kernel')

    // Config: plugins read configuration during Initialize, so providers must be merged into a snapshot first.
    await this.deps.config.refresh()

    const discovered = await this.deps.discovery.discoverDetailed({
      roots: this.options.roots,
      ...(this.options.builtinRoot
        ? { builtinRoot: this.options.builtinRoot }
        : {}),
      ...(this.options.workspaceRoot
        ? { workspaceRoot: this.options.workspaceRoot }
        : {}),
      legacyFallback: this.options.legacyFallback,
    })
    for (const issue of discovered.issues) {
      log.warn(`discovery issue: ${issue.dir} - ${issue.message}`)
    }
    const candidates = discovered.candidates.filter(
      c => !disabledPluginIds.includes(c.manifest.id),
    )
    // Dependency resolution must complete here: the dependency graph requires the manifests from discovery.
    const plan = this.deps.planOf(candidates)
    for (const issue of plan.issues) {
      const line = `[${issue.code}] ${issue.pluginId}: ${issue.detail}`
      if (issue.level === 'error') log.error(line)
      else log.warn(line)
    }

    const started: string[] = []
    const degraded: string[] = []
    const failed: string[] = []
    const candidatesById = new Map<string, Candidate>(
      candidates.map(c => [c.manifest.id, c]),
    )
    const missingOptionalById = new Map<string, string[]>(
      plan.steps.map(s => [s.candidate.manifest.id, s.missingOptional]),
    )

    for (const pluginId of plan.loadOrder) {
      const candidate = candidatesById.get(pluginId)
      if (!candidate) continue

      if (this.hasFailedDependency(candidate, failed)) {
        log.warn(`skipping ${pluginId}: dependency failed (dependency-failed)`)
        failed.push(pluginId)
        continue
      }

      const outcome = await this.startOnePlugin(candidate, {
        ...(loadOptions ? { loadOptions } : {}),
        missingOptional: missingOptionalById.get(pluginId) ?? [],
      })
      if (outcome === 'started') started.push(pluginId)
      else if (outcome === 'degraded') degraded.push(pluginId)
      else failed.push(pluginId)
    }

    this.started = true
    this.startResult = {
      loadOrder: plan.loadOrder,
      started,
      degraded,
      failed,
      dropped: plan.dropped,
    }
    await this.deps.events.emit(Topics.KernelReady, {
      loadOrder: plan.loadOrder,
      started,
      degraded,
      failed,
    })
    return this.startResult
  }

  /**
   * Stop every loaded plugin in reverse start order and reclaim its artifacts.
   * Used by restartPlugins(); shutdown() additionally disposes kernel-level
   * infrastructure, which must survive a plugin-service restart.
   */
  private async stopAllPlugins(): Promise<void> {
    const order = this.startResult.loadOrder.toReversed()
    const orderedLoaded: LoadedPlugin[] = [
      ...order
        .map(id => this.deps.registry.getLoaded(id))
        .filter((p): p is LoadedPlugin => p !== undefined),
      ...this.deps.registry
        .allLoaded()
        .filter(p => !order.includes(p.manifest.id)),
    ]

    for (const loaded of orderedLoaded) {
      const pluginId = loaded.manifest.id
      const log = this.deps.log.child(`plugin:${pluginId}`, pluginId)
      try {
        await this.deps.lifecycle.runStopSequence(
          loaded.hooks,
          loaded.context,
          'reload',
        )
        this.applyPluginState(pluginId, 'Stopped')
      } catch (error) {
        log.warn(
          `plugin failed to stop during restart: ${(error as Error).message}`,
        )
      }
      this.teardownPluginArtifacts(loaded)
      this.deps.registry.remove(pluginId)
      this.softDegraded.delete(pluginId)
      await this.deps.events.emit(Topics.PluginUnloaded, {
        pluginId,
        reason: 'reload',
      })
    }
  }

  async reload(pluginId: string): Promise<void> {
    const loaded = this.deps.registry.getLoaded(pluginId)
    if (!loaded) {
      throw new KernelError(
        'E_GENERIC',
        `plugin not loaded, cannot reload: ${pluginId}`,
      )
    }
    const log = this.deps.log.child(`plugin:${pluginId}`, pluginId)

    await this.deps.lifecycle.runStopSequence(
      loaded.hooks,
      loaded.context,
      'reload',
    )
    this.teardownPluginArtifacts(loaded)
    this.deps.registry.remove(pluginId)

    const rediscovered = await this.deps.discovery.discoverDetailed({
      roots: this.options.roots,
      ...(this.options.builtinRoot
        ? { builtinRoot: this.options.builtinRoot }
        : {}),
      ...(this.options.workspaceRoot
        ? { workspaceRoot: this.options.workspaceRoot }
        : {}),
      legacyFallback: this.options.legacyFallback,
    })
    const candidate = rediscovered.candidates.find(
      c => c.manifest.id === pluginId,
    )
    if (!candidate) {
      throw new KernelError(
        'E_GENERIC',
        `reload failed: plugin not found ${pluginId}`,
      )
    }

    // Re-resolve: compatibility and hard dependencies may have changed; if dropped, mark Failed (never bypass the resolver).
    const plan = this.deps.planOf(rediscovered.candidates)
    if (!plan.loadOrder.includes(pluginId)) {
      this.applyPluginState(pluginId, 'Failed')
      const issue = plan.issues.find(i => i.pluginId === pluginId)
      throw new KernelError(
        'E_GENERIC',
        `reload failed: plugin dropped in new resolve plan (${issue ? `${issue.code}: ${issue.detail}` : 'unknown reason'})`,
      )
    }
    const step = plan.steps.find(s => s.candidate.manifest.id === pluginId)

    if (!this.startResult.loadOrder.includes(pluginId)) {
      this.startResult.loadOrder.push(pluginId)
    }
    const outcome = await this.startOnePlugin(candidate, {
      loadOptions: { cacheBust: `${Date.now()}-${this.reloadCounter++}` },
      missingOptional: step?.missingOptional ?? [],
    })
    log.info(`hot reload complete: ${outcome}`)
    await this.deps.events.emit(Topics.PluginReloaded, { pluginId, outcome })
  }

  /**
   * Unload a plugin (Stop -> Unload -> Dispose -> reclaim artifacts).
   *
   * Cascade: loaded plugins with a hard dependency on this one are recursively
   * unloaded first. Idempotent: returns directly if the plugin is not loaded.
   */
  async unloadPlugin(
    pluginId: string,
    reason: StopReason = 'user-disable',
  ): Promise<void> {
    const loaded = this.deps.registry.getLoaded(pluginId)
    if (!loaded) return

    const dependents = this.deps.registry
      .allLoaded()
      .filter(p =>
        Object.keys(p.manifest.dependencies ?? {}).includes(pluginId),
      )
    for (const dependent of dependents) {
      await this.unloadPlugin(dependent.manifest.id, 'dependency-failed')
    }

    const log = this.deps.log.child(`plugin:${pluginId}`, pluginId)
    await this.deps.lifecycle.runStopSequence(
      loaded.hooks,
      loaded.context,
      reason,
    )
    // Reclaim contributions BEFORE publishing the state change: when the
    // frontend receives the event and re-pulls the panel/route lists, the
    // slot must already be free of this plugin's contributions (no race
    // between "still listed" and "already stopped").
    this.teardownPluginArtifacts(loaded)
    this.applyPluginState(pluginId, 'Stopped')
    this.deps.registry.remove(pluginId)
    this.softDegraded.delete(pluginId)

    this.startResult.loadOrder = this.startResult.loadOrder.filter(
      id => id !== pluginId,
    )
    this.startResult.started = this.startResult.started.filter(
      id => id !== pluginId,
    )
    this.startResult.degraded = this.startResult.degraded.filter(
      id => id !== pluginId,
    )
    this.startResult.failed = this.startResult.failed.filter(
      id => id !== pluginId,
    )

    log.info('plugin unloaded')
    await this.deps.events.emit(Topics.PluginUnloaded, { pluginId, reason })
  }

  async enablePlugin(
    pluginId: string,
    disabledPluginIds: readonly string[] = this.options.disabledPlugins,
  ): Promise<void> {
    if (!this.started) {
      throw new KernelError('E_GENERIC', 'kernel is not started')
    }
    const current = this.deps.registry.getLoaded(pluginId)
    // Active is a no-op. Degraded is not: a plugin degraded only because an
    // optional dependency was absent must be re-evaluated once that dependency
    // becomes available again.
    if (current?.state === 'Active') return

    const discovered = await this.deps.discovery.discoverDetailed({
      roots: this.options.roots,
      ...(this.options.builtinRoot
        ? { builtinRoot: this.options.builtinRoot }
        : {}),
      ...(this.options.workspaceRoot
        ? { workspaceRoot: this.options.workspaceRoot }
        : {}),
      legacyFallback: this.options.legacyFallback,
    })
    const candidates = discovered.candidates.filter(
      c =>
        c.manifest.id === pluginId ||
        !disabledPluginIds.includes(c.manifest.id),
    )
    const candidate = candidates.find(c => c.manifest.id === pluginId)
    if (!candidate) {
      throw new KernelError('E_GENERIC', `plugin not found: ${pluginId}`)
    }

    const plan = this.deps.planOf(candidates)
    if (!plan.loadOrder.includes(pluginId)) {
      const issue = plan.issues.find(i => i.pluginId === pluginId)
      throw new KernelError(
        'E_GENERIC',
        `plugin cannot be enabled: ${issue ? `${issue.code}: ${issue.detail}` : 'dependency resolution failed'}`,
      )
    }

    const byId = new Map(candidates.map(c => [c.manifest.id, c]))
    const required = new Set<string>()
    const collect = (id: string): void => {
      if (required.has(id)) return
      required.add(id)
      for (const dep of Object.keys(
        byId.get(id)?.manifest.dependencies ?? {},
      )) {
        collect(dep)
      }
    }
    collect(pluginId)

    for (const id of plan.loadOrder) {
      if (!required.has(id)) continue
      const step = plan.steps.find(s => s.candidate.manifest.id === id)
      if (!step) continue
      const loaded = this.deps.registry.getLoaded(id)
      if (loaded?.state === 'Active') continue
      if (loaded?.state === 'Degraded') {
        // A degraded dependency is still usable. The target itself is only
        // restarted when its missing optional set actually shrank; otherwise
        // there is nothing new to evaluate.
        if (id !== pluginId) continue
        if (step.missingOptional.length > 0) return
      }
      if (loaded) await this.unloadPlugin(id, 'reload')

      const outcome = await this.startOnePlugin(step.candidate, {
        loadOptions: { cacheBust: `${Date.now()}-${this.reloadCounter++}` },
        missingOptional: step.missingOptional,
      })
      this.recordStartOutcome(id, outcome)
      if (outcome === 'failed') {
        const message = this.deps.registry.getLoaded(id)?.health.message
        throw new KernelError(
          'E_GENERIC',
          `plugin failed to start: ${id}${message ? ` (${message})` : ''}`,
        )
      }
    }

    await this.recoverSoftDegraded(plan)
  }

  /**
   * Re-run plugins that were degraded purely by a missing optional dependency
   * once that dependency is available again. Without this the stale Degraded
   * state (and its health message) survives until a full restart.
   */
  private async recoverSoftDegraded(plan: ResolutionPlan): Promise<void> {
    // allLoaded() already returns a fresh array, so unloads below are safe.
    for (const loaded of this.deps.registry.allLoaded()) {
      const id = loaded.manifest.id
      if (loaded.state !== 'Degraded' || !this.softDegraded.has(id)) continue
      const step = plan.steps.find(s => s.candidate.manifest.id === id)
      if (!step || step.missingOptional.length > 0) continue

      await this.unloadPlugin(id, 'reload')
      const outcome = await this.startOnePlugin(step.candidate, {
        loadOptions: { cacheBust: `${Date.now()}-${this.reloadCounter++}` },
        missingOptional: [],
      })
      this.recordStartOutcome(id, outcome)
    }
  }

  async disablePlugin(pluginId: string): Promise<void> {
    await this.unloadPlugin(pluginId, 'user-disable')
  }

  async shutdown(): Promise<void> {
    const log = this.deps.log.child('kernel')
    log.info('kernel shutting down...')

    const order = this.startResult.loadOrder.toReversed()
    const orderedLoaded = [
      ...order
        .map(id => this.deps.registry.getLoaded(id))
        .filter((p): p is LoadedPlugin => p !== undefined),
      ...this.deps.registry
        .allLoaded()
        .filter(p => !order.includes(p.manifest.id)),
    ]

    for (const loaded of orderedLoaded) {
      try {
        await this.deps.lifecycle.runStopSequence(
          loaded.hooks,
          loaded.context,
          'shutdown',
        )
        if (loaded.state === 'Active' || loaded.state === 'Degraded') {
          this.applyPluginState(loaded.manifest.id, 'Stopped')
        }
      } catch {
        // Isolation: a single plugin failing to stop does not block overall shutdown.
      }
      this.teardownPluginArtifacts(loaded)
      this.softDegraded.delete(loaded.manifest.id)
    }

    this.commandExecuteUnsub?.()
    this.commandExecuteUnsub = null
    this.deps.events.clear()
    await this.deps.log.flush()
    await this.deps.tracer.flush()
    this.deps.rootContainer.dispose()
    this.started = false
    log.info('kernel stopped')
  }

  async health(): Promise<HealthReport> {
    return await this.deps.health.report()
  }

  private async startOnePlugin(
    candidate: Candidate,
    opts: { loadOptions?: LoadOptions; missingOptional?: string[] } = {},
  ): Promise<StartOutcome> {
    const pluginId = candidate.manifest.id
    const log = this.deps.log.child(`plugin:${pluginId}`, pluginId)

    try {
      // Permissions: trust level is derived from source, overridable via options.trustLevel.
      const trustLevel: TrustLevel =
        this.options.trustLevel ?? trustLevelFor(candidate.source)
      const decision = this.deps.permissions.check(
        candidate.manifest,
        trustLevel,
      )
      for (const w of decision.warnings) {
        log.warn(`permission warning: ${w.capability} - ${w.reason}`)
      }

      const loaded = await this.deps.loader.load(
        candidate,
        opts.loadOptions ?? {},
      )
      const withPerms: LoadedPlugin = {
        ...loaded,
        permissions: this.deps.permissions.get(pluginId) ?? loaded.permissions,
      }
      this.deps.registry.add(withPerms)
      this.applyPluginState(pluginId, 'Loaded')

      const outcome = await this.deps.lifecycle.runStartSequence(
        withPerms.hooks,
        withPerms.context,
        opts.missingOptional ?? [],
      )

      if (outcome.ok && outcome.degraded) {
        const missing = opts.missingOptional ?? []
        this.applyPluginState(pluginId, 'Degraded')
        this.deps.registry.setHealth(pluginId, {
          status: 'degraded',
          message:
            missing.length > 0
              ? `missing optional dependency: ${missing.join(', ')}`
              : 'non-fatal lifecycle phase failure',
          checkedAt: Date.now(),
        })
        if (missing.length > 0) this.softDegraded.add(pluginId)
        else this.softDegraded.delete(pluginId)
        this.registerHealthCheck(withPerms)
        log.warn('plugin started degraded')
        this.deps.metrics
          .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Degraded' })
          .add(1)
        await this.deps.events.emit(Topics.PluginDegraded, { pluginId })
        return 'degraded'
      }

      if (outcome.ok) {
        this.softDegraded.delete(pluginId)
        this.applyPluginState(pluginId, outcome.finalState)
        this.deps.registry.setHealth(pluginId, {
          status: 'healthy',
          checkedAt: Date.now(),
        })
        this.registerHealthCheck(withPerms)
        log.info('plugin started')
        this.deps.metrics
          .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Active' })
          .add(1)
        return 'started'
      }

      this.softDegraded.delete(pluginId)
      this.applyPluginState(pluginId, 'Failed')
      this.deps.registry.setHealth(pluginId, {
        status: 'unhealthy',
        ...(outcome.error ? { message: outcome.error } : {}),
        checkedAt: Date.now(),
      })
      log.error(`plugin start failed: ${outcome.error ?? 'unknown error'}`)
      this.deps.metrics
        .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Failed' })
        .add(1)
      await this.deps.events.emit(Topics.PluginFailed, {
        pluginId,
        error: outcome.error ?? 'unknown error',
      })
      return 'failed'
    } catch (error) {
      this.softDegraded.delete(pluginId)
      this.applyPluginState(pluginId, 'Failed')
      log.error(`plugin load/authorization failed: ${(error as Error).message}`)
      this.deps.metrics
        .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Failed' })
        .add(1)
      await this.deps.events.emit(Topics.PluginFailed, {
        pluginId,
        error: (error as Error).message,
      })
      return 'failed'
    }
  }

  /**
   * Plugin health checks are exposed through the `health.check` extension
   * point (not via a direct registerCheck call); plugins without
   * `onHealthCheck` contribute nothing.
   */
  private registerHealthCheck(loaded: LoadedPlugin): void {
    const check = loaded.hooks.onHealthCheck
    if (typeof check !== 'function') return
    this.deps.extensions.contribute(loaded.manifest.id, 'health.check', {
      contributionId: loaded.manifest.id,
      impl: () => check.call(loaded.hooks),
    })
  }

  /**
   * Apply a plugin state change and publish it.
   *
   * The single producer of `plugin.state-changed`: every transition (including
   * error and rollback paths) emits, because the frontend re-pulls its lists
   * on any state change and a missed event leaves stale UI. The emit is
   * fire-and-forget (subscriber errors are isolated by the bus).
   */
  private applyPluginState(pluginId: string, state: PluginStateT): void {
    this.deps.registry.setState(pluginId, state)
    void this.deps.events.emit(Topics.PluginStateChanged, { pluginId, state })
  }

  /**
   * Reclaim plugin artifacts without relying on plugin self-cleanup:
   * retract extension contributions -> unregister health checks -> revoke
   * permissions -> unmount and dispose the container.
   */
  private teardownPluginArtifacts(loaded: LoadedPlugin): void {
    const pluginId = loaded.manifest.id
    this.deps.extensions.retractAll(pluginId)
    this.deps.health.unregisterCheck(pluginId)
    this.deps.permissions.unregister(pluginId)
    const container = loaded.container as Container
    this.deps.rootContainer.unmountChildContainer(container)
    container.dispose()
  }

  private recordStartOutcome(pluginId: string, outcome: StartOutcome): void {
    if (!this.startResult.loadOrder.includes(pluginId)) {
      this.startResult.loadOrder.push(pluginId)
    }
    for (const key of ['started', 'degraded', 'failed'] as const) {
      this.startResult[key] = this.startResult[key].filter(
        id => id !== pluginId,
      )
    }
    this.startResult[outcome].push(pluginId)
  }

  private hasFailedDependency(candidate: Candidate, failed: string[]): boolean {
    const deps = Object.keys(candidate.manifest.dependencies ?? {})
    return deps.some(d => failed.includes(d))
  }
}

function isKernelDeps(
  value: Partial<KernelOptions> | KernelDeps,
): value is KernelDeps {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rootContainer' in value &&
    'lifecycle' in value &&
    'extensions' in value
  )
}
