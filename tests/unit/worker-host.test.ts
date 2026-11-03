import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LogEntry, LogSink } from '@/kernel/contracts/logging.js'
import type { MetricRecord, MetricSink } from '@/kernel/contracts/metrics.js'

import { ConfigService } from '@/kernel/config/config-service.js'
import { MemoryConfigProvider } from '@/kernel/config/memory-provider.js'
import { TimeoutError } from '@/kernel/errors.js'
import { EventBusImpl } from '@/kernel/events/event-bus.js'
import { WorkerPluginHost } from '@/kernel/isolation/worker-host.js'
import { LogService } from '@/kernel/observability/log-service.js'
import { MetricsService } from '@/kernel/observability/metrics-service.js'

import { makeCandidate } from '../helpers/make-manifest.js'

/**
 * One fixture covers every proxied context domain: each hook below issues a
 * different RPC, so adding a domain never requires a new worker variant.
 *
 * Worker hooks are called as `fn.call(instance, ctx, ...args)` (see
 * `worker-bootstrap.ts`), so `ctx` is the first parameter — `onHealthCheck`
 * being the one exception.
 */
const PLUGIN_SOURCE = `
export default function factory(ctx) {
  return {
    async ping(_ctx, value) { return { echo: value } },
    async boom() { throw new Error('hook exploded') },
    async hang() { await new Promise(() => {}) },
    async useLog() { ctx.log.info('from-worker', { a: 1 }) },
    async useEvents() { await ctx.events.emit('worker:event', { ok: true }) },
    async useMetrics() { ctx.metrics.counter('worker.counter', { s: 'x' }).add(3) },
    async useGauge() { ctx.metrics.gauge('worker.gauge', { s: 'x' }).set(7) },
    async useHistogram() { ctx.metrics.histogram('worker.hist', { s: 'x' }).observe(9) },
    async useConfigGet(_ctx, key, fallback) { return ctx.config.get(key, fallback) },
    async useRequest(_ctx, topic, payload, timeoutMs) {
      return await ctx.events.request(topic, payload, { timeoutMs })
    },
    async useContribute(_ctx, point, contribution) {
      ctx.extensions.contribute(point, contribution)
      return 'sent'
    },
    async useForbidden() {
      try {
        ctx.services.resolve('anything')
        return 'allowed'
      } catch (error) {
        return String(error && error.message)
      }
    },
  }
}
`

const CRASH_SOURCE = `
export default function factory() {
  return {
    async onStart() { process.exit(1) },
  }
}
`

interface Harness {
  host: WorkerPluginHost
  bus: EventBusImpl
  config: ConfigService
  logs: LogEntry[]
  metrics: MetricRecord[]
  exits: Array<{ code: number | null; error?: string }>
  contributed: Array<{
    pluginId: string
    point: string
    contribution: unknown
  }>
}

interface HarnessOptions {
  /** `null` leaves `facilities.extensions` unset (the kernel may omit it). */
  extensions?: null
}

async function writePlugin(
  root: string,
  id: string,
  source: string,
): Promise<string> {
  const dir = path.join(root, id.replace(/[^a-z0-9._-]/gi, '_'))
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(path.join(dir, 'dist', 'index.mjs'), source, 'utf8')
  return dir
}

function makeHarness(
  pluginDir: string,
  id: string,
  opts: HarnessOptions = {},
): Harness {
  const logs: LogEntry[] = []
  const metrics: MetricRecord[] = []
  const exits: Array<{ code: number | null; error?: string }> = []
  const contributed: Harness['contributed'] = []

  const logService = new LogService()
  const logSink: LogSink = {
    name: 'test-sink',
    write: entry => void logs.push(entry),
  }
  logService.addSink(logSink)

  const metricsService = new MetricsService()
  const metricSink: MetricSink = {
    name: 'test-sink',
    record: record => void metrics.push(record),
  }
  metricsService.addSink(metricSink)

  const bus = new EventBusImpl()
  const config = new ConfigService()

  const extensions =
    opts.extensions === null
      ? undefined
      : {
          contribute: (
            pluginId: string,
            point: string,
            contribution: unknown,
          ) => {
            contributed.push({ pluginId, point, contribution })
          },
        }

  const host = new WorkerPluginHost(
    makeCandidate({ id, entry: 'dist/index.mjs', rootDir: pluginDir }),
    {
      events: bus,
      config,
      logService,
      metrics: metricsService,
      ...(extensions ? { extensions } : {}),
      onUnexpectedExit: (pluginId, code, error) => {
        expect(pluginId).toBe(id)
        exits.push(error === undefined ? { code } : { code, error })
      },
    },
  )

  return { host, bus, config, logs, metrics, exits, contributed }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('worker-host · hook RPC', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-workerhost-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exposes the manifest id', async () => {
    const dir = await writePlugin(root, 'com.rem2.worker', PLUGIN_SOURCE)
    const { host } = makeHarness(dir, 'com.rem2.worker')

    expect(host.pluginId).toBe('com.rem2.worker')
    await host.terminate()
  })

  it('forwards a hook call and returns its value', async () => {
    const dir = await writePlugin(root, 'com.rem2.worker', PLUGIN_SOURCE)
    const { host } = makeHarness(dir, 'com.rem2.worker')

    const result = await host.callHook('ping', ['hello'], 5000)

    expect(result).toEqual({ echo: 'hello' })
    await host.terminate()
  })

  it('rejects with the error thrown inside the worker', async () => {
    const dir = await writePlugin(root, 'com.rem2.worker', PLUGIN_SOURCE)
    const { host } = makeHarness(dir, 'com.rem2.worker')

    await expect(host.callHook('boom', [], 5000)).rejects.toThrow(
      /hook exploded/,
    )

    await host.terminate()
  })

  it('times out a hook that never settles', async () => {
    const dir = await writePlugin(root, 'com.rem2.worker', PLUGIN_SOURCE)
    const { host } = makeHarness(dir, 'com.rem2.worker')

    await expect(host.callHook('hang', [], 100)).rejects.toBeInstanceOf(
      TimeoutError,
    )

    await host.terminate()
  }, 15_000)

  it('a hook can no longer be called after the worker exits unexpectedly', async () => {
    const dir = await writePlugin(root, 'com.rem2.crash', CRASH_SOURCE)
    const { host, exits } = makeHarness(dir, 'com.rem2.crash')

    await expect(host.callHook('onStart', [], 300)).rejects.toThrow()
    await waitFor(() => exits.length > 0)

    await expect(host.callHook('onStart', [], 300)).rejects.toThrow(
      /already failed/,
    )

    await host.terminate()
  }, 15_000)

  it('terminate is idempotent', async () => {
    const dir = await writePlugin(root, 'com.rem2.worker', PLUGIN_SOURCE)
    const { host } = makeHarness(dir, 'com.rem2.worker')

    await host.terminate()
    await host.callHook('ping', [1], 5000)
    await host.terminate()
    await host.terminate()

    expect(host.pluginId).toBe('com.rem2.worker')
  })

  it('fails fast when the entry module cannot be resolved', async () => {
    const dir = await writePlugin(root, 'com.rem2.missing', PLUGIN_SOURCE)
    const { host } = makeHarness(dir, 'com.rem2.missing')
    const broken = new WorkerPluginHost(
      makeCandidate({
        id: 'com.rem2.missing',
        entry: 'dist/absent.mjs',
        rootDir: dir,
      }),
      {
        events: new EventBusImpl(),
        config: new ConfigService(),
        logService: new LogService(),
        metrics: new MetricsService(),
        onUnexpectedExit: () => undefined,
      },
    )

    await expect(broken.callHook('ping', [], 1000)).rejects.toThrow()

    await host.terminate()
    await broken.terminate()
  })
})

describe('worker-host · context proxy whitelist', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-workerhost-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function setup(): Promise<Harness> {
    const dir = await writePlugin(root, 'com.rem2.proxy', PLUGIN_SOURCE)
    return makeHarness(dir, 'com.rem2.proxy')
  }

  it('proxies ctx.log to the host log service', async () => {
    const { host, logs } = await setup()

    await host.callHook('useLog', [], 5000)

    expect(logs.some(entry => entry.msg === 'from-worker')).toBe(true)
    await host.terminate()
  })

  it('proxies ctx.events.emit to the host event bus', async () => {
    const { host, bus } = await setup()

    const received = new Promise<unknown>(resolve => {
      bus.once('worker:event', resolve)
    })
    await host.callHook('useEvents', [], 5000)

    await expect(received).resolves.toEqual({ ok: true })
    await host.terminate()
  })

  it('proxies ctx.metrics counters to the host metrics sinks', async () => {
    const { host, metrics } = await setup()

    await host.callHook('useMetrics', [], 5000)

    expect(metrics).toContainEqual(
      expect.objectContaining({
        kind: 'counter',
        name: 'worker.counter',
        value: 3,
      }),
    )
    await host.terminate()
  })

  it('proxies ctx.metrics gauges and histograms to the host sinks', async () => {
    const { host, metrics } = await setup()

    await host.callHook('useGauge', [], 5000)
    await host.callHook('useHistogram', [], 5000)

    expect(metrics).toContainEqual(
      expect.objectContaining({
        kind: 'gauge',
        name: 'worker.gauge',
        value: 7,
      }),
    )
    expect(metrics).toContainEqual(
      expect.objectContaining({
        kind: 'histogram',
        name: 'worker.hist',
        value: 9,
      }),
    )
    await host.terminate()
  })

  it('keeps ctx.services unreachable inside a worker', async () => {
    const { host } = await setup()

    const outcome = await host.callHook('useForbidden', [], 5000)

    expect(outcome).not.toBe('allowed')
    expect(String(outcome)).toMatch(/services\.resolve/)
    await host.terminate()
  })
})

describe('worker-host · events.request over the proxy', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-workerhost-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('delivers the payload to the responder and returns its result', async () => {
    const dir = await writePlugin(root, 'com.rem2.request', PLUGIN_SOURCE)
    const { host, bus } = makeHarness(dir, 'com.rem2.request')
    const seen: unknown[] = []
    bus.respond('worker:double', (payload: unknown) => {
      seen.push(payload)
      return { doubled: (payload as { n: number }).n * 2 }
    })

    const result = await host.callHook(
      'useRequest',
      ['worker:double', { n: 21 }, 1000],
      5000,
    )

    expect(seen).toEqual([{ n: 21 }])
    expect(result).toEqual({ doubled: 42 })
    await host.terminate()
  })

  it('honours the timeoutMs supplied by the plugin', async () => {
    const dir = await writePlugin(root, 'com.rem2.request', PLUGIN_SOURCE)
    const { host, bus } = makeHarness(dir, 'com.rem2.request')
    bus.respond('worker:slow', async () => {
      await new Promise(resolve => setTimeout(resolve, 500))
      return 'late'
    })

    await expect(
      host.callHook('useRequest', ['worker:slow', null, 50], 5000),
    ).rejects.toThrow(/operation timed out: worker:slow \(50ms\)/)

    await host.terminate()
  }, 15_000)

  it('surfaces a missing responder as an error for that call only', async () => {
    const dir = await writePlugin(root, 'com.rem2.request', PLUGIN_SOURCE)
    const { host } = makeHarness(dir, 'com.rem2.request')

    await expect(
      host.callHook('useRequest', ['worker:nobody', null, 200], 5000),
    ).rejects.toThrow(/no responder for topic: worker:nobody/)

    await expect(host.callHook('ping', ['still alive'], 5000)).resolves.toEqual(
      {
        echo: 'still alive',
      },
    )

    await host.terminate()
  })
})

describe('worker-host · config snapshot over the proxy', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-workerhost-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads the init snapshot and applies the fallback for a missing key', async () => {
    const dir = await writePlugin(root, 'com.rem2.config', PLUGIN_SOURCE)
    const { host, config } = makeHarness(dir, 'com.rem2.config')
    config.registerProvider(
      new MemoryConfigProvider({ app: { theme: 'rem' } }, 'memory', 10),
    )
    await config.refresh()

    await expect(
      host.callHook('useConfigGet', ['app.theme', 'fallback'], 5000),
    ).resolves.toBe('rem')
    await expect(
      host.callHook('useConfigGet', ['app.absent', 'fallback'], 5000),
    ).resolves.toBe('fallback')

    await host.terminate()
  })
})

describe('worker-host · extensions.contribute over the proxy', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-workerhost-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('forwards pluginId, point and contribution to the host registry', async () => {
    const dir = await writePlugin(root, 'com.rem2.contribute', PLUGIN_SOURCE)
    const { host, contributed } = makeHarness(dir, 'com.rem2.contribute')

    await expect(
      host.callHook('useContribute', ['log.sink', { name: 'sink-1' }], 5000),
    ).resolves.toBe('sent')
    // `extensions.contribute` is fire-and-forget on the worker side, so the
    // host observes the contribution one message later.
    await waitFor(() => contributed.length > 0)

    expect(contributed).toEqual([
      {
        pluginId: 'com.rem2.contribute',
        point: 'log.sink',
        contribution: { name: 'sink-1' },
      },
    ])
    await host.terminate()
  })
})

/**
 * `dispatchCtx` stays private: two of its branches cannot be reached from a
 * real worker, which is exactly why they need a direct entry —
 * - `config`: `worker-bootstrap.ts` resolves `ctx.config.get` against the init
 *   snapshot locally and never sends a config RPC, so the host-side branch
 *   would otherwise never run.
 * - unknown domains: the worker proxy exposes only the whitelisted domains, so
 *   a plugin cannot construct one.
 * Exercised through a narrow cast rather than widening the production API.
 */
type Dispatch = (
  domain: string,
  rest: string[],
  args: unknown[],
) => Promise<unknown>

function dispatcherOf(host: WorkerPluginHost): Dispatch {
  return (host as unknown as { dispatchCtx: Dispatch }).dispatchCtx.bind(host)
}

describe('worker-host · dispatch whitelist (direct)', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-workerhost-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function setup(opts: HarnessOptions = {}): Promise<Harness> {
    const dir = await writePlugin(root, 'com.rem2.direct', PLUGIN_SOURCE)
    return makeHarness(dir, 'com.rem2.direct', opts)
  }

  it('config.get returns a configured value', async () => {
    const { host, config } = await setup()
    config.registerProvider(
      new MemoryConfigProvider({ app: { theme: 'rem' } }, 'memory', 10),
    )
    await config.refresh()

    const value = await dispatcherOf(host)(
      'config',
      ['get'],
      ['app.theme', 'fallback'],
    )

    expect(value).toBe('rem')
  })

  it('config.get returns the default for a missing key', async () => {
    const { host } = await setup()

    const value = await dispatcherOf(host)(
      'config',
      ['get'],
      ['app.absent', 'fallback'],
    )

    expect(value).toBe('fallback')
  })

  it('config rejects any operation other than get', async () => {
    const { host } = await setup()

    await expect(
      dispatcherOf(host)('config', ['set'], ['k', 1]),
    ).rejects.toThrow(/Worker config only supports get/)
  })

  it('extensions.contribute forwards the host-side plugin id and payload', async () => {
    const { host, contributed } = await setup()

    const value = await dispatcherOf(host)(
      'extensions',
      ['contribute'],
      ['log.sink', { name: 'sink-1' }],
    )

    expect(value).toBeUndefined()
    expect(contributed).toEqual([
      {
        pluginId: 'com.rem2.direct',
        point: 'log.sink',
        contribution: { name: 'sink-1' },
      },
    ])
  })

  it('extensions.contribute is silently dropped when the facility is absent', async () => {
    const { host, contributed } = await setup({ extensions: null })

    // KNOWN GAP: `this.facilities.extensions?.contribute(...)` short-circuits,
    // so an unset facility loses the contribution without any signal. Pinned
    // here so turning it into an explicit error stays a deliberate change.
    await expect(
      dispatcherOf(host)(
        'extensions',
        ['contribute'],
        ['log.sink', { name: 'sink-1' }],
      ),
    ).resolves.toBeUndefined()

    expect(contributed).toEqual([])
  })

  it('extensions rejects an unsupported operation', async () => {
    const { host } = await setup()

    await expect(
      dispatcherOf(host)('extensions', ['retract'], ['log.sink', 'x']),
    ).rejects.toThrow(/Unsupported worker extensions operation/)
  })

  it('events rejects an unsupported operation', async () => {
    const { host } = await setup()

    await expect(
      dispatcherOf(host)('events', ['publish'], ['x']),
    ).rejects.toThrow(/Unknown events operation/)
  })

  it('metrics rejects an unknown operation', async () => {
    const { host, metrics } = await setup()

    await expect(
      dispatcherOf(host)('metrics', ['summary'], ['m', {}, 1]),
    ).rejects.toThrow(/Unknown metrics operation/)

    expect(metrics).toEqual([])
  })

  it('log rejects an unknown level', async () => {
    const { host, logs } = await setup()

    await expect(
      dispatcherOf(host)('log', ['verbose'], ['msg']),
    ).rejects.toThrow(/Unknown log level/)

    expect(logs).toEqual([])
  })

  it('an unknown domain is rejected without touching any capability', async () => {
    const { host, logs, metrics, contributed, bus } = await setup()
    let busEvents = 0
    bus.on('*', () => {
      busEvents += 1
    })

    await expect(
      dispatcherOf(host)('secrets', ['read'], ['token']),
    ).rejects.toThrow(/Unsupported worker context domain: secrets/)

    expect(logs).toEqual([])
    expect(metrics).toEqual([])
    expect(contributed).toEqual([])
    expect(busEvents).toBe(0)
  })
})
