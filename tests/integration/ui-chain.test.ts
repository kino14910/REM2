/**
 * Integration test: UI chain (plugin contribution -> host method table -> IPC
 * bridge -> renderer-equivalent layer).
 *
 * Rationale: the UI surface is a chain of four independent links that used to
 * break one at a time:
 * 1. the plugin contributes `ui.panel` / `ui.route` (here: plugin-inspector);
 * 2. the host method table reads the extension slots (`method-handlers.ts`);
 * 3. the IPC bridge narrows renderer calls to the whitelist and carries
 *    request/response by id (`bridge.ts`);
 * 4. the frontend consumes lists + panel data through the same bridge.
 *
 * A break at any link shows up as "the panel never appears" with no error, so
 * this suite drives the real chain end to end: a real kernel over
 * plugins-dist, the real method table, the real IpcBridge, and a fake
 * transport that plays the renderer. The timeout case is the single
 * deliberate real-timeout wait (a plugin whose data command never answers).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { createDeps } from '../../src/kernel/composition.js'
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js'
import { Topics } from '../../src/kernel/topics.js'
import type { EventBus } from '../../src/kernel/contracts/event-bus.js'
import type { PanelContribution } from '../../src/kernel/contracts/ui.js'
import { ThemeRegistryImpl } from '../../src/host/electron/theme-registry.js'
import { createMethodHandlers } from '../../src/host/ipc/method-handlers.js'
import { IpcBridge } from '../../src/host/ipc/bridge.js'
import {
  channels,
  Ipc,
  type IpcResponse,
} from '../../src/shared/ipc-contract.js'
import { createTmpPluginsDir } from '../helpers/tmp-plugins-dir.js'
import {
  cleanupTestPluginDataRoots,
  createTestPluginDataRoot,
} from '../helpers/plugin-data-root.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist')
/** Theme Switcher is an external (user-installed) plugin, never bundled as builtin. */
const EXTERNAL_ROOT = path.join(PROJECT_ROOT, 'plugins-external-dist')
const THEME_ID = 'com.rem2.theme-switcher'
const THEME_CAPABILITIES = ['ui.theme', 'ui.panel', 'ui.route']
const EMPTY_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'empty-plugins')

const INSPECTOR_PANEL_ID = 'plugin-inspector'
const INSPECTOR_PLUGIN_ID = 'com.rem2.plugin-inspector'
const DATA_TOPIC = 'com.rem2.plugin-inspector.data'

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
      id: 'rem2-ui-chain',
      roots: [EXTERNAL_ROOT],
      builtinRoot: BUILTIN_ROOT,
      grantedCapabilities: id =>
        id === THEME_ID ? THEME_CAPABILITIES : [],
      pluginDataRoot: createTestPluginDataRoot('ui-chain'),
      startTimeoutMs: 8000,
      stopTimeoutMs: 8000,
      legacyFallback: false,
      logLevel: 'error',
    }),
  )
}

/**
 * Renderer-equivalent IPC client: a fake transport wired to the real IpcBridge.
 *
 * Replies are matched by request id as they arrive (event-driven, no blind
 * sleeping); every invoke carries a hard bound so a lost reply fails the test
 * instead of hanging it. The default bound covers the one deliberate
 * real-timeout case (a hanging panel command answers at ~5s).
 */
function createIpcClient(bus: EventBus, boundMs = 9000) {
  const bridge = new IpcBridge(bus)
  const pending = new Map<string, (res: IpcResponse) => void>()
  let invokeHandler: ((payload: unknown) => void) | null = null
  bridge.bind({
    send: (_channel, payload) => {
      const res = payload as IpcResponse
      const resolve = pending.get(res.id)
      if (resolve) {
        pending.delete(res.id)
        resolve(res)
      }
    },
    on: (channel, handler) => {
      if (channel !== Ipc.Invoke) return () => undefined
      invokeHandler = handler
      return () => {
        invokeHandler = null
      }
    },
  })
  let seq = 0
  return {
    bridge,
    invoke(method: string, args?: unknown): Promise<IpcResponse> {
      const id = `ui-chain-${++seq}`
      return new Promise<IpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`no IPC reply for ${method} within ${boundMs}ms`))
        }, boundMs)
        pending.set(id, res => {
          clearTimeout(timer)
          resolve(res)
        })
        invokeHandler?.({ id, method, args })
      })
    },
  }
}

/** Registers the given method handlers on the bus (what main.ts does at startup). */
function registerHandlers(
  bus: EventBus,
  kernel: Kernel,
  methods: readonly string[],
): void {
  const handlers = createMethodHandlers({
    kernel,
    bus,
    themeRegistry: new ThemeRegistryImpl(),
  })
  for (const method of methods) {
    const handler = handlers[method as keyof typeof handlers]
    if (handler) bus.respond(method, handler)
  }
}

afterEach(cleanupTestPluginDataRoots)

describe('integration · ui chain', () => {
  it('① plugin-inspector starts and contributes exactly one panel + one route', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()

      const panels = kernel.extensions.listAll<PanelContribution>('ui.panel')
      const inspector = panels.find(p => p.panelId === INSPECTOR_PANEL_ID)
      expect(inspector).toMatchObject({
        panelId: INSPECTOR_PANEL_ID,
        title: 'Plugin Inspector',
        icon: '🔍',
        region: 'main',
        order: 10,
        command: DATA_TOPIC,
      })

      const routes = kernel.extensions.listAll<{ path: string }>('ui.route')
      const inspectorRoute = routes.find(r => r.path === '/plugins')
      expect(inspectorRoute).toMatchObject({
        path: '/plugins',
        title: 'Plugins',
        panelId: INSPECTOR_PANEL_ID,
        order: 10,
      })
    } finally {
      await kernel.shutdown()
    }
  })

  it('② contributions reach the renderer-equivalent layer through host + IPC', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      registerHandlers(bus, kernel, [channels.panelList, channels.routeList])
      const client = createIpcClient(bus)

      const panelRes = await client.invoke(channels.panelList)
      expect(panelRes.ok).toBe(true)
      expect(panelRes.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            panelId: INSPECTOR_PANEL_ID,
            command: DATA_TOPIC,
            region: 'main',
            order: 10,
          }),
        ]),
      )

      const routeRes = await client.invoke(channels.routeList)
      expect(routeRes.ok).toBe(true)
      expect(routeRes.result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: '/plugins',
            panelId: INSPECTOR_PANEL_ID,
            order: 10,
          }),
        ]),
      )

      client.bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })

  it('④ panel data resolves to the inspector table (all 7 plugins, Active/healthy)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      registerHandlers(bus, kernel, [channels.panelData])
      const client = createIpcClient(bus)

      const res = await client.invoke(channels.panelData, {
        panelId: INSPECTOR_PANEL_ID,
      })
      expect(res.ok).toBe(true)
      const table = res.result as {
        kind: string
        columns: string[]
        rows: unknown[][]
      }
      expect(table.kind).toBe('table')
      expect(table.columns).toEqual([
        'id',
        'name',
        'version',
        'state',
        'health',
        'message',
      ])
      expect(table.rows).toHaveLength(BUILTIN_PLUGIN_IDS.length)
      expect(table.rows.map(r => r[0]).toSorted()).toEqual(
        [...BUILTIN_PLUGIN_IDS].toSorted(),
      )
      const self = table.rows.find(r => r[0] === INSPECTOR_PLUGIN_ID)
      expect(self).toBeDefined()
      expect(self).toHaveLength(6)
      expect(self?.[3]).toBe('Active')
      expect(self?.[4]).toBe('healthy')
      for (const row of table.rows) {
        expect(row, `row for ${String(row[0])} is malformed`).toHaveLength(6)
        expect(row[3]).toBe('Active')
        expect(row[4]).toBe('healthy')
      }

      client.bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })

  it('④ unknown panel and invalid args fail explicitly (never silent)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      registerHandlers(bus, kernel, [channels.panelData, channels.uiEvent])
      const client = createIpcClient(bus)

      const unknown = await client.invoke(channels.panelData, {
        panelId: 'nope',
      })
      expect(unknown.ok).toBe(false)
      expect(unknown.error).toContain('panel not found')

      for (const badArgs of [{}, { panelId: 42 }, null]) {
        const invalid = await client.invoke(channels.panelData, badArgs)
        expect(invalid.ok).toBe(false)
        expect(invalid.error).toMatch(/invalid args/)
      }

      const unknownEvent = await client.invoke(channels.uiEvent, {
        panelId: 'nope',
        kind: 'click',
      })
      expect(unknownEvent.ok).toBe(true)
      expect(unknownEvent.result).toEqual({ ok: false })

      for (const badArgs of [{}, { panelId: 42 }, null]) {
        const invalid = await client.invoke(channels.uiEvent, badArgs)
        expect(invalid.ok).toBe(false)
        expect(invalid.error).toMatch(/invalid args/)
      }

      client.bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })

  it('④ a hanging panel data command surfaces a timeout error (the only real-timeout case)', async () => {
    const tmp = await createTmpPluginsDir('rem2-ui-hang-')
    try {
      await tmp.writePlugin(
        { id: 'com.rem2.ui-hang', requires: ['ui.panel'] },
        `
export default function factory(ctx) {
  return {
    async onStart() {
      ctx.extensions.contribute('ui.panel', {
        contributionId: 'qa-hang',
        impl: {
          panelId: 'qa-hang',
          title: 'Hang Panel',
          icon: '⏳',
          region: 'main',
          order: 10,
          command: 'test.hang',
        },
      })
      // Never resolves: the panel data path must degrade to an explicit
      // timeout, not hang the renderer forever.
      ctx.events.respond('test.hang', () => new Promise(() => {}))
    },
  }
}
`,
        'index.js',
      )

      const kernel = new Kernel(
        createDeps({
          id: 'rem2-ui-hang',
          roots: [tmp.root],
          builtinRoot: BUILTIN_ROOT,
          startTimeoutMs: 8000,
          stopTimeoutMs: 8000,
          legacyFallback: false,
          logLevel: 'error',
          // The fixture declares requires: ['ui.panel']; a workspace plugin is
          // sandboxed by default, so elevate trust for this fixture only.
          trustLevel: 'trusted',
        }),
      )
      try {
        await kernel.start()
        const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
        registerHandlers(bus, kernel, [channels.panelData])
        const client = createIpcClient(bus)

        // Event-driven: resolves when the reply arrives (~5s, the real bus
        // timeout); the 9s client bound only guards against a lost reply.
        const res = await client.invoke(channels.panelData, {
          panelId: 'qa-hang',
        })
        expect(res.ok).toBe(false)
        expect(res.error).toMatch(/timeout|timed out/i)

        client.bridge.unbind()
      } finally {
        await kernel.shutdown()
      }
    } finally {
      await tmp.cleanup()
    }
  })

  it('⑤ unloading the inspector reclaims its panel and route (degraded, not stale)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      registerHandlers(bus, kernel, [
        channels.panelList,
        channels.routeList,
        channels.panelData,
        channels.uiEvent,
      ])
      const client = createIpcClient(bus)

      const before = await client.invoke(channels.panelList)
      expect(before.ok).toBe(true)
      expect(before.result).toHaveLength(2)

      await kernel.unloadPlugin(INSPECTOR_PLUGIN_ID)

      const panels = await client.invoke(channels.panelList)
      expect(panels.ok).toBe(true)
      expect(panels.result).toMatchObject([{ panelId: 'theme-switcher' }])
      const routes = await client.invoke(channels.routeList)
      expect(routes.ok).toBe(true)
      expect(routes.result).toMatchObject([{ path: '/theme' }])

      const data = await client.invoke(channels.panelData, {
        panelId: INSPECTOR_PANEL_ID,
      })
      expect(data.ok).toBe(false)
      expect(data.error).toContain('panel not found')

      const event = await client.invoke(channels.uiEvent, {
        panelId: INSPECTOR_PANEL_ID,
        kind: 'click',
      })
      expect(event.ok).toBe(true)
      expect(event.result).toEqual({ ok: false })

      client.bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })

  it('⑤ the Stopped state event fires only after contributions are reclaimed (ordering guarantee)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      const seen: Array<{
        pluginId: string
        state: string
        panelsAtEvent: string[]
      }> = []
      bus.on<{ pluginId: string; state: string }>(
        Topics.PluginStateChanged,
        payload => {
          // Synchronous check inside the event handler: the kernel reclaims
          // contributions BEFORE publishing the state change, so a frontend
          // that re-pulls on this event must already see a free slot. If the
          // order ever flips, panelsAtEvent still contains the panel here.
          seen.push({
            ...payload,
            panelsAtEvent: kernel.extensions
              .listAll<PanelContribution>('ui.panel')
              .map(p => p.panelId),
          })
        },
      )

      await kernel.unloadPlugin(INSPECTOR_PLUGIN_ID)

      const inspectorEvents = seen.filter(
        e => e.pluginId === INSPECTOR_PLUGIN_ID,
      )
      expect(inspectorEvents).toEqual([
        {
          pluginId: INSPECTOR_PLUGIN_ID,
          state: 'Stopped',
          panelsAtEvent: ['theme-switcher'],
        },
      ])
    } finally {
      await kernel.shutdown()
    }
  })

  it('⑥ with no panel plugin the lists degrade to empty arrays and data lookup fails explicitly', async () => {
    const kernel = new Kernel(
      createDeps({
        id: 'rem2-ui-empty',
        roots: [],
        builtinRoot: EMPTY_ROOT,
        startTimeoutMs: 5000,
        stopTimeoutMs: 5000,
        legacyFallback: false,
        logLevel: 'error',
      }),
    )
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      registerHandlers(bus, kernel, [
        channels.panelList,
        channels.routeList,
        channels.panelData,
      ])
      const client = createIpcClient(bus)

      const panels = await client.invoke(channels.panelList)
      expect(panels.ok).toBe(true)
      expect(panels.result).toEqual([])
      const routes = await client.invoke(channels.routeList)
      expect(routes.ok).toBe(true)
      expect(routes.result).toEqual([])

      const data = await client.invoke(channels.panelData, {
        panelId: 'anything',
      })
      expect(data.ok).toBe(false)
      expect(data.error).toContain('panel not found')

      client.bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })

  it('a method outside the whitelist is rejected by the bridge and never enters the bus', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      let responderCalls = 0
      bus.respond('config.changed', () => {
        responderCalls++
        return { ok: true }
      })
      const client = createIpcClient(bus)

      const res = await client.invoke('config.changed', { key: 'x' })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/whitelist/)
      // A responder exists for the topic; it must never have been reached.
      expect(responderCalls).toBe(0)

      client.bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })
})
