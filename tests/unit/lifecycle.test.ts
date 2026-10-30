import { describe, expect, it } from 'vitest'
import { LifecycleManager } from '../../src/kernel/lifecycle/manager.js'
import { isLegalTransition } from '../../src/kernel/lifecycle/phases.js'
import { makePlugin } from '../helpers/make-plugin.js'

/** Build a minimal PluginContext stand-in usable by LifecycleManager. */
function stubContext(pluginId: string): import('rem2-kernel').PluginContext {
  return {
    pluginId,
    manifest: { id: pluginId } as never,
    container: {} as never,
    services: {} as never,
    events: {} as never,
    config: {
      get: (_k: string, d?: unknown) => d,
      has: () => false,
      getOrThrow: () => undefined,
      onDidChange: () => () => undefined,
    } as never,
    log: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    },
    metrics: {} as never,
    permissions: {
      pluginId,
      granted: [],
      denied: [],
      isGranted: () => true,
    } as never,
    api: {} as never,
    extensions: {} as never,
    phase: 'Registered',
    plugins: {
      has: () => false,
      isStarted: () => false,
      get: () => undefined,
      all: () => [],
      byState: () => [],
    },
    resolvePath: (p: string) => p,
    dataPath: (p: string) => p,
  }
}

describe('lifecycle · phase sequence', () => {
  it('normal startup runs onDiscover→onLoad→onConfigure→onStart', async () => {
    const log: Array<{ hook: string; phase: string }> = []
    const plugin = makePlugin({ id: 'a', log })
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    })
    const outcome = await mgr.runStartSequence(plugin, stubContext('a'))
    expect(outcome.ok).toBe(true)
    expect(log.map(l => l.hook)).toEqual([
      'onDiscover',
      'onLoad',
      'onConfigure',
      'onStart',
    ])
  })

  it('shutdown runs Stop→Unload→Dispose', async () => {
    const log: Array<{ hook: string; phase: string }> = []
    const plugin = makePlugin({ id: 'a', log })
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    })
    await mgr.runStartSequence(plugin, stubContext('a'))
    await mgr.runStopSequence(plugin, stubContext('a'), 'shutdown')
    const hooks = log.map(l => l.hook)
    expect(hooks).toContain('onStop')
    expect(hooks).toContain('onUnload')
    expect(hooks).toContain('onDispose')
    expect(hooks.indexOf('onStop')).toBeLessThan(hooks.indexOf('onDispose'))
  })

  it('rolls back when onStart throws (Dispose/Unload are called)', async () => {
    const log: Array<{ hook: string; phase: string }> = []
    const plugin = makePlugin({ id: 'a', startBehavior: 'throw', log })
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    })
    const outcome = await mgr.runStartSequence(plugin, stubContext('a'))
    expect(outcome.ok).toBe(false)
    expect(outcome.rolledBack).toBe(true)
    const hooks = log.map(l => l.hook)
    expect(hooks).toContain('onStop')
    expect(hooks).toContain('onUnload')
  })

  it('an onStart timeout is forcibly interrupted', async () => {
    const log: Array<{ hook: string; phase: string }> = []
    const plugin = makePlugin({
      id: 'slow',
      startBehavior: { delayMs: 500 },
      log,
    })
    const mgr = new LifecycleManager({
      startTimeoutMs: 30,
      stopTimeoutMs: 1000,
    })
    const outcome = await mgr.runStartSequence(plugin, stubContext('slow'))
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/timed out/)
  })

  it('missing hooks count as success', async () => {
    const plugin = {
      onStart: async (): Promise<void> => undefined,
    }
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    })
    const outcome = await mgr.runStartSequence(
      plugin as never,
      stubContext('min'),
    )
    expect(outcome.ok).toBe(true)
  })
})

describe('lifecycle · phase transition legality', () => {
  it('allows sequential forward transitions', () => {
    expect(isLegalTransition('Registered', 'Loaded')).toBe(true)
    expect(isLegalTransition('Loaded', 'Initialized')).toBe(true)
    expect(isLegalTransition('Initialized', 'Configured')).toBe(true)
    expect(isLegalTransition('Configured', 'Stopped')).toBe(true)
  })

  it('forbids going back', () => {
    expect(isLegalTransition('Configured', 'Loaded')).toBe(false)
  })

  it('any phase may enter Degraded', () => {
    expect(isLegalTransition('Configured', 'Degraded')).toBe(true)
  })
})
