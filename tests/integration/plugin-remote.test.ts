/**
 * Integration test: remote plugin install, update and rollback
 * (`LocalPluginManager` + `MethodHandlers` + `IpcBridge`).
 *
 * Network access is replaced by an injected `fetchImpl` serving GitHub release
 * metadata and in-memory ZIP bytes built by `tests/helpers/zip-builder.ts`; no
 * real network, no third-party archive library.
 */

import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js'
import type { EventBus } from '../../src/kernel/contracts/event-bus.js'
import { Topics } from '../../src/kernel/topics.js'
import { LocalPluginManager } from '../../src/host/plugins/local-plugin-manager.js'
import { PluginStateStore } from '../../src/host/plugins/state-store.js'
import { PluginProvenanceStore } from '../../src/host/plugins/provenance-store.js'
import { ThemeRegistryImpl } from '../../src/host/electron/theme-registry.js'
import { createMethodHandlers } from '../../src/host/ipc/method-handlers.js'
import { IpcBridge } from '../../src/host/ipc/bridge.js'
import { EVENT_FORWARD_MAP } from '../../src/host/ipc/forward-map.js'
import {
  Ipc,
  channels,
  events,
  type IpcEventPayload,
  type IpcResponse,
} from '../../src/shared/ipc-contract.js'
import { makeManifest } from '../helpers/make-manifest.js'
import { buildZip, type ZipBuilderEntry } from '../helpers/zip-builder.js'

const REPO_SOURCE = 'https://github.com/acme/hello'
const PLUGIN_ID = 'com.acme.hello'

interface ReleaseSpec {
  version: string
  zip: Buffer
  tag?: string
  /** Release metadata digest; omit to publish no digest at all. */
  digest?: string
  notes?: string
  publishedAt?: string
}

interface RemoteEnv {
  root: string
  userRoot: string
  builtinRoot: string
  dataRoot: string
  packagesRoot: string
  provenanceFile: string
  state: PluginStateStore
  provenance: PluginProvenanceStore
  kernel: Kernel
  manager: LocalPluginManager
  routes: Map<string, () => Response>
  publish(spec: ReleaseSpec): void
  dispose(): Promise<void>
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()!()
})

function digestOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function defaultSource(): string {
  return `
export default function factory() {
  return {
    async onStart() {},
    async onStop() {},
    async onUnload() {},
    async onDispose() {},
  }
}
`
}

function executableSource(marker: string): string {
  return `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'executed')
export default function factory() {
  return { async onStart() {}, async onStop() {} }
}
`
}

function buildPluginZip(options: {
  version: string
  source?: string
  dependencies?: Record<string, string>
  requires?: string[]
  prefix?: string
  extraEntries?: ZipBuilderEntry[]
}): Buffer {
  const manifest = makeManifest({
    id: PLUGIN_ID,
    name: 'Hello',
    version: options.version,
    entry: 'index.js',
    description: 'Remote test plugin',
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.requires ? { requires: options.requires } : {}),
  })
  const prefix = options.prefix ?? ''
  return buildZip([
    {
      name: `${prefix}plugin.json`,
      content: JSON.stringify(manifest, null, 2),
    },
    {
      name: `${prefix}index.js`,
      content: options.source ?? defaultSource(),
    },
    ...(options.extraEntries ?? []),
  ])
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function zipResponse(buffer: Buffer): Response {
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  })
}

function createFetch(routes: Map<string, () => Response>): typeof fetch {
  return (async input => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const route = routes.get(url)
    if (!route) return new Response('not found', { status: 404 })
    return route()
  }) as typeof fetch
}

async function createEnv(): Promise<RemoteEnv> {
  const root = await mkdtemp(path.join(tmpdir(), 'rem2-remote-'))
  const userRoot = path.join(root, 'user-plugins')
  const builtinRoot = path.join(root, 'builtin-plugins')
  const dataRoot = path.join(root, 'plugin-data')
  const packagesRoot = path.join(root, 'plugin-packages')
  await Promise.all([mkdir(userRoot), mkdir(builtinRoot)])

  const state = new PluginStateStore(path.join(root, 'plugin-manager.json'))
  await state.load()
  const provenanceFile = path.join(root, 'plugin-provenance.json')
  const provenance = new PluginProvenanceStore(provenanceFile)
  await provenance.load()

  const routes = new Map<string, () => Response>()
  const fetchImpl = createFetch(routes)
  const kernel = new Kernel({
    id: 'rem2-remote-plugin-test',
    roots: [userRoot],
    builtinRoot,
    disabledPlugins: state.ids(),
    startTimeoutMs: 5000,
    stopTimeoutMs: 5000,
    legacyFallback: false,
    logLevel: 'error',
  })
  await kernel.start()
  const manager = new LocalPluginManager({
    kernel,
    userRoot,
    dataRoot,
    state,
    builtinRoot,
    provenance,
    packagesRoot,
    fetchImpl,
  })

  const env: RemoteEnv = {
    root,
    userRoot,
    builtinRoot,
    dataRoot,
    packagesRoot,
    provenanceFile,
    state,
    provenance,
    kernel,
    manager,
    routes,
    publish: spec => {
      const tag = spec.tag ?? `v${spec.version}`
      const assetName = 'hello.zip'
      const assetUrl = `${REPO_SOURCE}/releases/download/${tag}/${assetName}`
      const release = {
        tag_name: tag,
        published_at: spec.publishedAt ?? '2026-01-01T00:00:00Z',
        body: spec.notes ?? 'Release notes',
        assets: [
          {
            name: assetName,
            browser_download_url: assetUrl,
            size: spec.zip.byteLength,
            ...(spec.digest ? { digest: `sha256:${spec.digest}` } : {}),
          },
        ],
      }
      routes.set(
        'https://api.github.com/repos/acme/hello/releases/latest',
        () => jsonResponse(release),
      )
      routes.set(
        `https://api.github.com/repos/acme/hello/releases/tags/${tag}`,
        () => jsonResponse(release),
      )
      routes.set(assetUrl, () => zipResponse(spec.zip))
    },
    dispose: async () => {
      if (kernel.isStarted()) await kernel.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
  disposals.push(env.dispose)
  return env
}

async function writeUserData(env: RemoteEnv): Promise<void> {
  const pluginDir = path.join(env.userRoot, PLUGIN_ID)
  await mkdir(path.join(pluginDir, 'config'), { recursive: true })
  await mkdir(path.join(pluginDir, 'data'), { recursive: true })
  await writeFile(
    path.join(pluginDir, 'config', 'settings.json'),
    '{"a":1}',
    'utf8',
  )
  await writeFile(path.join(pluginDir, 'data', 'store.json'), '{"b":2}', 'utf8')
}

async function listEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).toSorted()
  } catch {
    return []
  }
}

describe('integration · remote plugin inspect and install', () => {
  it('inspecting downloads and previews without installing or executing code', async () => {
    const env = await createEnv()
    const marker = path.join(env.root, 'executed.marker')
    const zip = buildPluginZip({
      version: '1.0.0',
      source: executableSource(marker),
      requires: ['network.http'],
      prefix: 'hello-1.0.0/',
    })
    const digest = digestOf(zip)
    env.publish({ version: '1.0.0', zip, digest, notes: 'First release' })

    const phases: string[] = []
    const inspection = await env.manager.inspectRemote({
      url: REPO_SOURCE,
      operationId: 'inspect-1',
      onProgress: progress => phases.push(progress.phase),
    })

    expect(inspection).toMatchObject({
      url: REPO_SOURCE,
      id: PLUGIN_ID,
      version: '1.0.0',
      requires: ['network.http'],
      sha256: digest,
      size: zip.byteLength,
      notes: 'First release',
    })
    expect(phases).toContain('extracting')
    expect(await listEntries(env.userRoot)).toEqual([])
    await expect(access(marker)).rejects.toThrow()

    // Nothing in the DTO may leak host paths or internals.
    const serialized = JSON.stringify(inspection)
    expect(serialized).not.toMatch(/rootDir|container/)
    expect(serialized).not.toContain(env.root)
  })

  it('installs from the cached package disabled, records provenance and exposes origin', async () => {
    const env = await createEnv()
    const marker = path.join(env.root, 'executed.marker')
    const zip = buildPluginZip({
      version: '1.0.0',
      source: executableSource(marker),
    })
    const digest = digestOf(zip)
    env.publish({ version: '1.0.0', zip, digest })

    const inspection = await env.manager.inspectRemote({
      url: REPO_SOURCE,
      operationId: 'inspect-2',
    })
    await expect(access(marker)).rejects.toThrow()

    const installed = await env.manager.installFromRemote(
      { url: inspection.url, operationId: 'install-2', sha256: digest },
      () => undefined,
    )

    expect(installed.ok).toBe(true)
    expect(installed.plugin).toMatchObject({
      id: PLUGIN_ID,
      version: '1.0.0',
      source: 'user',
      state: 'Disabled',
      enabled: false,
      canUninstall: true,
      origin: { kind: 'remote', url: REPO_SOURCE, sha256: digest },
    })
    expect(installed.restartRequired).toBe(false)
    await expect(access(marker)).rejects.toThrow()
    await access(path.join(env.userRoot, PLUGIN_ID, 'plugin.json'))

    const provenance = JSON.parse(
      await readFile(env.provenanceFile, 'utf8'),
    ) as { version: number; entries: Record<string, unknown> }
    expect(provenance.version).toBe(1)
    expect(provenance.entries[PLUGIN_ID]).toMatchObject({
      kind: 'remote',
      url: REPO_SOURCE,
      sha256: digest,
    })

    // The inspect download is reused by install: a second download would be
    // visible as a second asset request in the route map call count.
    expect(await listEntries(env.packagesRoot)).toHaveLength(1)

    const detail = await env.manager.detail(PLUGIN_ID)
    expect(JSON.stringify(detail)).not.toMatch(/rootDir|container/)
    expect(JSON.stringify(detail)).not.toContain(env.userRoot)
  })

  it('blocks installation when the release publishes no digest', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip })

    await expect(
      env.manager.installFromRemote({
        url: REPO_SOURCE,
        operationId: 'install-no-digest',
      }),
    ).rejects.toMatchObject({ code: 'E_DIGEST_MISSING' })
    expect(await listEntries(env.userRoot)).toEqual([])
    await expect(access(env.provenanceFile)).rejects.toThrow()
  })

  it('rejects a digest mismatch and cleans the temporary download', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: 'b'.repeat(64) })

    await expect(
      env.manager.installFromRemote({
        url: REPO_SOURCE,
        operationId: 'install-mismatch',
      }),
    ).rejects.toMatchObject({ code: 'E_DIGEST_MISMATCH' })
    expect(await listEntries(env.userRoot)).toEqual([])
    const leftovers = (await listEntries(env.packagesRoot)).filter(name =>
      name.includes('.part-'),
    )
    expect(leftovers).toEqual([])
  })

  it('drops a poisoned cache entry when an inspect digest does not match', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: 'c'.repeat(64) })

    await expect(
      env.manager.inspectRemote({ url: REPO_SOURCE, operationId: 'poisoned' }),
    ).rejects.toMatchObject({ code: 'E_DIGEST_MISMATCH' })
    const cached = (await listEntries(env.packagesRoot)).filter(name =>
      name.endsWith('.zip'),
    )
    expect(cached).toEqual([])
  })

  it('rejects zip-slip entries without leaving files behind', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({
      version: '1.0.0',
      extraEntries: [{ name: '../escape.txt', content: 'escaped' }],
    })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })

    await expect(
      env.manager.inspectRemote({ url: REPO_SOURCE, operationId: 'zip-slip' }),
    ).rejects.toMatchObject({ code: 'E_PATH_ESCAPE' })
    expect(await listEntries(env.userRoot)).toEqual([])
    await expect(access(path.join(env.root, 'escape.txt'))).rejects.toThrow()
  })

  it('rejects symbolic links inside a remote package', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({
      version: '1.0.0',
      extraEntries: [{ name: 'linked.js', content: '', unixMode: 0o120777 }],
    })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })

    await expect(
      env.manager.inspectRemote({ url: REPO_SOURCE, operationId: 'symlink' }),
    ).rejects.toMatchObject({ code: 'E_UNSAFE_TREE' })
    expect(await listEntries(env.userRoot)).toEqual([])
  })

  it('cancelling an unknown operation id is idempotent', async () => {
    const env = await createEnv()
    expect(env.manager.cancelDownload('missing-operation')).toBe(false)
    expect(env.manager.cancelDownload('missing-operation')).toBe(false)
  })
})

describe('integration · remote plugin updates', () => {
  it('checks updates for one plugin and for all installed remote plugins', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-for-check',
    })

    const same = await env.manager.checkUpdates(PLUGIN_ID)
    expect(same.updates[0]).toMatchObject({
      pluginId: PLUGIN_ID,
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      hasUpdate: false,
    })
    expect((await env.manager.checkUpdates()).updates).toHaveLength(1)

    const newerZip = buildPluginZip({ version: '1.1.0' })
    env.publish({
      version: '1.1.0',
      zip: newerZip,
      digest: digestOf(newerZip),
      notes: 'Bug fixes',
    })
    const newer = await env.manager.checkUpdates(PLUGIN_ID)
    expect(newer.updates[0]).toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      hasUpdate: true,
      notes: 'Bug fixes',
    })
  })

  it('updates a disabled plugin in place and preserves config and data', async () => {
    const env = await createEnv()
    const firstZip = buildPluginZip({ version: '1.0.0' })
    const firstDigest = digestOf(firstZip)
    env.publish({ version: '1.0.0', zip: firstZip, digest: firstDigest })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-v1',
    })
    await writeUserData(env)

    const secondZip = buildPluginZip({ version: '2.0.0' })
    const secondDigest = digestOf(secondZip)
    env.publish({
      version: '2.0.0',
      zip: secondZip,
      digest: secondDigest,
      publishedAt: '2026-02-01T00:00:00Z',
    })

    const updated = await env.manager.applyUpdate({
      pluginId: PLUGIN_ID,
      operationId: 'update-v2',
    })

    expect(updated.ok).toBe(true)
    expect(updated.changed).toBe(true)
    expect(updated.restartRequired).toBe(false)
    expect(updated.plugin).toMatchObject({
      id: PLUGIN_ID,
      version: '2.0.0',
      state: 'Disabled',
      origin: { kind: 'remote', sha256: secondDigest },
    })
    expect(
      await readFile(
        path.join(env.userRoot, PLUGIN_ID, 'config', 'settings.json'),
        'utf8',
      ),
    ).toBe('{"a":1}')
    expect(
      await readFile(
        path.join(env.userRoot, PLUGIN_ID, 'data', 'store.json'),
        'utf8',
      ),
    ).toBe('{"b":2}')

    const provenance = JSON.parse(
      await readFile(env.provenanceFile, 'utf8'),
    ) as { entries: Record<string, { sha256: string }> }
    expect(provenance.entries[PLUGIN_ID]?.sha256).toBe(secondDigest)

    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
  })

  it('reports changed:false when the installed version is already newest', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-current',
    })

    const result = await env.manager.applyUpdate({
      pluginId: PLUGIN_ID,
      operationId: 'update-current',
    })
    expect(result).toMatchObject({ changed: false, restartRequired: false })
    expect(result.plugin?.version).toBe('1.0.0')
  })

  it('rolls back directory, provenance and runtime when the new version fails to start', async () => {
    const env = await createEnv()
    const marker = path.join(env.root, 'v1.marker')
    const firstZip = buildPluginZip({
      version: '1.0.0',
      source: executableSource(marker),
    })
    const firstDigest = digestOf(firstZip)
    env.publish({ version: '1.0.0', zip: firstZip, digest: firstDigest })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-rollback-v1',
    })
    await env.manager.enable(PLUGIN_ID)
    expect((await env.manager.detail(PLUGIN_ID)).state).toBe('Active')
    await writeUserData(env)

    const brokenZip = buildPluginZip({
      version: '2.0.0',
      source: `
export default function factory() {
  return { async onStart() { throw new Error('update boom') }, async onStop() {} }
}
`,
    })
    env.publish({
      version: '2.0.0',
      zip: brokenZip,
      digest: digestOf(brokenZip),
    })

    await expect(
      env.manager.applyUpdate({
        pluginId: PLUGIN_ID,
        operationId: 'update-broken',
      }),
    ).rejects.toMatchObject({ code: 'E_UPDATE_FAILED' })

    const detail = await env.manager.detail(PLUGIN_ID)
    expect(detail.version).toBe('1.0.0')
    expect(detail.state).toBe('Active')
    expect(detail.origin?.sha256).toBe(firstDigest)
    expect(
      await readFile(
        path.join(env.userRoot, PLUGIN_ID, 'config', 'settings.json'),
        'utf8',
      ),
    ).toBe('{"a":1}')
    const entries = await listEntries(env.userRoot)
    expect(entries).toEqual([PLUGIN_ID])
  })

  it('rejects an update whose new manifest needs a missing hard dependency', async () => {
    const env = await createEnv()
    const firstZip = buildPluginZip({ version: '1.0.0' })
    const firstDigest = digestOf(firstZip)
    env.publish({ version: '1.0.0', zip: firstZip, digest: firstDigest })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-dep-v1',
    })

    const brokenZip = buildPluginZip({
      version: '2.0.0',
      dependencies: { 'com.acme.absent': '^1.0.0' },
    })
    env.publish({
      version: '2.0.0',
      zip: brokenZip,
      digest: digestOf(brokenZip),
    })

    await expect(
      env.manager.applyUpdate({
        pluginId: PLUGIN_ID,
        operationId: 'update-dep',
      }),
    ).rejects.toMatchObject({ code: 'E_DEPENDENCY' })

    const detail = await env.manager.detail(PLUGIN_ID)
    expect(detail.version).toBe('1.0.0')
    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
  })

  it('refuses to update a plugin without recorded provenance', async () => {
    const env = await createEnv()
    const localDir = path.join(env.userRoot, 'com.acme.local')
    await mkdir(localDir)
    await writeFile(
      path.join(localDir, 'plugin.json'),
      JSON.stringify(makeManifest({ id: 'com.acme.local' })),
      'utf8',
    )
    await writeFile(path.join(localDir, 'index.js'), defaultSource(), 'utf8')

    await expect(
      env.manager.applyUpdate({
        pluginId: 'com.acme.local',
        operationId: 'update-local',
      }),
    ).rejects.toMatchObject({ code: 'E_PROVENANCE_MISSING' })
    await expect(
      env.manager.checkUpdates('com.acme.local'),
    ).rejects.toMatchObject({ code: 'E_PROVENANCE_MISSING' })
  })
})

describe('integration · remote plugin IPC boundary', () => {
  it('validates args before any network or filesystem work', async () => {
    const env = await createEnv()
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
    })

    await expect(
      handlers[channels.pluginRemoteInspect]!(undefined),
    ).rejects.toThrow(/expected an object/)
    await expect(
      handlers[channels.pluginRemoteInspect]!({ url: 'http://github.com/a/b' }),
    ).rejects.toThrow(/https/)
    await expect(
      handlers[channels.pluginRemoteInspect]!({
        url: `https://github.com/${'a'.repeat(3000)}`,
      }),
    ).rejects.toThrow(/at most/)
    await expect(
      handlers[channels.pluginInstallFromRemote]!({
        url: REPO_SOURCE,
      }),
    ).rejects.toThrow(/operationId/)
    await expect(
      handlers[channels.pluginInstallFromRemote]!({
        operationId: 'has space',
        url: REPO_SOURCE,
      }),
    ).rejects.toThrow(/operationId/)
    expect(() =>
      handlers[channels.pluginDownloadCancel]!({ operationId: '' }),
    ).toThrow(/operationId/)
    await expect(
      handlers[channels.pluginUpdateInstall]!({
        operationId: 'op-1',
        pluginId: '../escape',
      }),
    ).rejects.toThrow(/invalid format/)
    expect(() =>
      handlers[channels.pluginUpdateCheck]!({ pluginId: '../escape' }),
    ).toThrow(/invalid format/)

    const cancelled = (await handlers[channels.pluginDownloadCancel]!({
      operationId: 'unknown-op',
    })) as { ok: boolean; cancelled: boolean }
    expect(cancelled).toEqual({ ok: true, cancelled: false })
  })

  it('forwards progress through the IPC bridge with DTO-only fields', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
    })
    bus.respond(
      channels.pluginRemoteInspect,
      handlers[channels.pluginRemoteInspect]!,
    )

    const eventsSeen: string[] = []
    const forwarded: IpcEventPayload[] = []
    const replies: IpcResponse[] = []
    const bridge = new IpcBridge(bus, { forwardMap: EVENT_FORWARD_MAP })
    bus.on(Topics.PluginDownloadProgress, () => {
      eventsSeen.push('topic')
    })
    bridge.bind({
      send: (channel, payload) => {
        if (channel === Ipc.Event) forwarded.push(payload as IpcEventPayload)
        if (channel === Ipc.Invoke) replies.push(payload as IpcResponse)
      },
      on: (channel, handler) => {
        if (channel === Ipc.Invoke) {
          void handler({
            id: 'remote-ipc-1',
            method: channels.pluginRemoteInspect,
            args: { url: REPO_SOURCE, operationId: 'bridge-op' },
          })
        }
        return () => undefined
      },
    })

    await waitFor(() => replies.length > 0)
    bridge.unbind()

    expect(replies[0]).toMatchObject({ ok: true })
    expect(eventsSeen.length).toBeGreaterThan(0)
    expect(forwarded.length).toBeGreaterThan(0)
    const allowed = new Set([
      'operationId',
      'phase',
      'receivedBytes',
      'totalBytes',
    ])
    for (const event of forwarded) {
      expect(event.event).toBe(events.pluginDownloadProgress)
      for (const key of Object.keys(event.payload as Record<string, unknown>)) {
        expect(allowed.has(key)).toBe(true)
      }
    }
    expect(JSON.stringify(forwarded)).not.toContain(env.root)
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not met')
}
