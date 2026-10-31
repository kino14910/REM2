/**
 * Integration test: plugin-inspector chain from the plugin's own perspective.
 *
 * Rationale: the inspector dogfoods the extension system - it contributes the
 * panel/route (covered by ui-chain.test.ts) and serves its data over a private
 * topic. This suite drives that topic directly on the kernel bus:
 * - the data request shape (a table covering every loaded plugin, with state
 *   and health joined from the kernel HealthService);
 * - the interaction push path (`kind: 'refresh'` -> re-snapshot ->
 *   `Topics.PanelDataChanged`), including the "unknown kind is a no-op" case;
 * - responder reclamation on unload (the plugin unsubscribes in onStop, so the
 *   topic must answer NoResponderError afterwards - never silence).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { createDeps } from '../../src/kernel/composition.js'
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js'
import { Topics } from '../../src/kernel/topics.js'
import type {
  EventBus,
  Unsubscribe,
} from '../../src/kernel/contracts/event-bus.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist')
/** Theme Switcher is external: built into plugins-external-dist, installed as a user plugin. */
const EXTERNAL_ROOT = path.join(PROJECT_ROOT, 'plugins-external-dist')
const THEME_ID = 'com.rem2.theme-switcher'
const THEME_CAPABILITIES = ['ui.theme', 'ui.panel', 'ui.route']

const DATA_TOPIC = 'com.rem2.plugin-inspector.data'
const INSPECTOR_PLUGIN_ID = 'com.rem2.plugin-inspector'

/** The 7 plugins loaded by these suites (6 built-in + external theme-switcher). */
const BUILTIN_PLUGIN_IDS = [
  'com.rem2.config-json',
  'com.rem2.health-http',
  'com.rem2.hello-command',
  'com.rem2.logger-console',
  'com.rem2.notify-worker',
  'com.rem2.plugin-inspector',
  'com.rem2.theme-switcher',
]

function createKernel(): Kernel {
  return new Kernel(
    createDeps({
      id: 'rem2-inspector-chain',
      roots: [EXTERNAL_ROOT],
      builtinRoot: BUILTIN_ROOT,
      grantedCapabilities: id =>
        id === THEME_ID ? THEME_CAPABILITIES : [],
      startTimeoutMs: 8000,
      stopTimeoutMs: 8000,
      legacyFallback: false,
      logLevel: 'error',
    }),
  )
}

interface PanelDataTable {
  kind: 'table'
  columns: string[]
  rows: Array<Array<string | number>>
}

interface PanelDataChangedPayload {
  panelId: string
  data: PanelDataTable
}

/**
 * Event collector: waiters are woken by the bus callback itself (no blind
 * sleeping); every wait carries a hard bound so a missing event fails the
 * test instead of hanging it.
 */
class Collector<T> {
  readonly items: T[] = []
  private waiters: Array<() => void> = []
  private readonly unsub: Unsubscribe

  constructor(bus: EventBus, topic: string) {
    this.unsub = bus.on(topic, payload => {
      this.items.push(payload as T)
      const waiters = this.waiters
      this.waiters = []
      for (const wake of waiters) wake()
    })
  }

  /** Resolves once at least `count` items have arrived; rejects when the bound elapses. */
  async waitFor(count: number, boundMs: number): Promise<void> {
    while (this.items.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `expected ${count} event(s), got ${this.items.length} within ${boundMs}ms`,
              ),
            ),
          boundMs,
        )
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  dispose(): void {
    this.unsub()
  }
}

describe('integration · inspector chain (plugin self-view)', () => {
  it('①/④ the data topic serves a table covering every loaded plugin, all Active/healthy', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      const table = await bus.request<{ panelId: string }, PanelDataTable>(
        DATA_TOPIC,
        { panelId: 'plugin-inspector' },
        { timeoutMs: 5000 },
      )

      expect(table.kind).toBe('table')
      expect(table.columns).toEqual([
        'id',
        'name',
        'version',
        'state',
        'health',
        'message',
      ])
      expect(table.rows.map(r => r[0]).toSorted()).toEqual(
        [...BUILTIN_PLUGIN_IDS].toSorted(),
      )
      for (const row of table.rows) {
        expect(row, `row for ${String(row[0])} is malformed`).toHaveLength(6)
        expect(row[3]).toBe('Active')
        expect(row[4]).toBe('healthy')
      }
    } finally {
      await kernel.shutdown()
    }
  })

  it('④ a refresh interaction pushes a fresh table via PanelDataChanged', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const collector = new Collector<PanelDataChangedPayload>(
        bus,
        Topics.PanelDataChanged,
      )
      try {
        const result = await bus.request<unknown, { ok: boolean }>(
          DATA_TOPIC,
          { kind: 'refresh' },
          { timeoutMs: 5000 },
        )
        expect(result).toEqual({ ok: true })

        await collector.waitFor(1, 2000)
        const pushed = collector.items[0]!
        expect(pushed.panelId).toBe('plugin-inspector')
        expect(pushed.data.kind).toBe('table')
        expect(pushed.data.rows).toHaveLength(BUILTIN_PLUGIN_IDS.length)
      } finally {
        collector.dispose()
      }
    } finally {
      await kernel.shutdown()
    }
  })

  it('④ an unknown interaction kind is accepted but pushes nothing', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const collector = new Collector<unknown>(bus, Topics.PanelDataChanged)
      try {
        const result = await bus.request<unknown, { ok: boolean }>(
          DATA_TOPIC,
          { kind: 'bogus' },
          { timeoutMs: 5000 },
        )
        expect(result).toEqual({ ok: true })
        // The reply resolves only after the handler completed, and the handler
        // emits nothing for unknown kinds - so the collector must still be empty.
        expect(collector.items).toEqual([])
      } finally {
        collector.dispose()
      }
    } finally {
      await kernel.shutdown()
    }
  })

  it('⑤ after unloading the inspector its responder is gone (NoResponderError, not silence)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      await kernel.unloadPlugin(INSPECTOR_PLUGIN_ID)

      // The plugin unsubscribes its private topic in onStop; a lingering
      // responder would answer here instead of raising NoResponderError.
      await expect(
        bus.request(DATA_TOPIC, {}, { timeoutMs: 2000 }),
      ).rejects.toThrow(/no responder/)
    } finally {
      await kernel.shutdown()
    }
  })
})
