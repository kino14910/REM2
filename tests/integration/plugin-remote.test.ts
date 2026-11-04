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
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EventBus } from '@/kernel/contracts/event-bus.js'

import { ThemeRegistryImpl } from '@/host/electron/theme-registry.js'
import { IpcBridge } from '@/host/ipc/bridge.js'
import { EVENT_FORWARD_MAP } from '@/host/ipc/forward-map.js'
import { createMethodHandlers } from '@/host/ipc/method-handlers.js'
import { PluginGrantStore } from '@/host/plugins/grant-store.js'
import { LocalPluginManager } from '@/host/plugins/local-plugin-manager.js'
import { PluginProvenanceStore } from '@/host/plugins/provenance-store.js'
import { PluginRemovedStore } from '@/host/plugins/removed-plugin-store.js'
import { copyDirectorySafe } from '@/host/plugins/safe-fs.js'
import { PluginStateStore } from '@/host/plugins/state-store.js'
import { KernelTokens } from '@/kernel/contracts/kernel-tokens.js'
import { Kernel } from '@/kernel/kernel.js'
import { Topics } from '@/kernel/topics.js'
import {
  Ipc,
  channels,
  events,
  type IpcEventPayload,
  type IpcResponse,
} from '@/shared/ipc-contract.js'

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
  grantsFile: string
  removedFile: string
  state: PluginStateStore
  provenance: PluginProvenanceStore
  grants: PluginGrantStore
  removed: PluginRemovedStore
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

async function createEnv(
  options: { copyDirectory?: typeof copyDirectorySafe } = {},
): Promise<RemoteEnv> {
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
  const grantsFile = path.join(root, 'plugin-grants.json')
  const grants = new PluginGrantStore(grantsFile)
  await grants.load()
  const removedFile = path.join(root, 'plugin-removed.json')
  const removed = new PluginRemovedStore(removedFile)
  await removed.load()

  const routes = new Map<string, () => Response>()
  const fetchImpl = createFetch(routes)
  const kernel = new Kernel({
    id: 'rem2-remote-plugin-test',
    roots: [userRoot],
    builtinRoot,
    grantedCapabilities: id => grants.get(id),
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
    grants,
    removed,
    packagesRoot,
    fetchImpl,
    ...(options.copyDirectory ? { copyDirectory: options.copyDirectory } : {}),
  })

  const env: RemoteEnv = {
    root,
    userRoot,
    builtinRoot,
    dataRoot,
    packagesRoot,
    provenanceFile,
    grantsFile,
    removedFile,
    state,
    provenance,
    grants,
    removed,
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

  it('installs from the cached package enabled, records provenance and exposes origin', async () => {
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
      state: 'Active',
      enabled: true,
      canUninstall: true,
      origin: { kind: 'remote', url: REPO_SOURCE, sha256: digest },
    })
    expect(installed.restartRequired).toBe(false)
    // Installation enables the plugin immediately.
    expect(await readFile(marker, 'utf8')).toBe('executed')
    await access(path.join(env.userRoot, PLUGIN_ID, 'plugin.json'))

    const provenance = JSON.parse(
      await readFile(env.provenanceFile, 'utf8'),
    ) as {
      version: number
      entries: Record<string, unknown>
    }
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

  it('installs from remote disabled when marketplace-style enable=false is used', async () => {
    const env = await createEnv()
    const marker = path.join(env.root, 'executed.marker')
    const zip = buildPluginZip({
      version: '1.0.0',
      source: executableSource(marker),
    })
    const digest = digestOf(zip)
    env.publish({ version: '1.0.0', zip, digest })

    const installed = await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-disabled',
      sha256: digest,
      enable: false,
    })

    expect(installed.plugin).toMatchObject({
      id: PLUGIN_ID,
      version: '1.0.0',
      state: 'Disabled',
      enabled: false,
    })
    expect(installed.message).toContain('Review the declared capabilities')
    expect(env.state.isDisabled(PLUGIN_ID)).toBe(true)
    await access(path.join(env.userRoot, PLUGIN_ID, 'plugin.json'))
    await expect(access(marker)).rejects.toThrow()
  })

  it('records install-time capability approval and enables the plugin', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({
      version: '1.0.0',
      requires: ['ui.panel'],
    })
    const digest = digestOf(zip)
    env.publish({ version: '1.0.0', zip, digest })

    const inspection = await env.manager.inspectRemote({
      url: REPO_SOURCE,
      operationId: 'inspect-approve',
    })
    expect(inspection.requires).toEqual(['ui.panel'])

    // Approvals never exceed the manifest.
    await expect(
      env.manager.installFromRemote({
        url: REPO_SOURCE,
        operationId: 'install-undeclared',
        sha256: digest,
        capabilities: ['ui.theme'],
      }),
    ).rejects.toMatchObject({ code: 'E_CAPABILITY_INVALID' })

    const installed = await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-approved',
      sha256: digest,
      capabilities: inspection.requires,
    })

    expect(installed.plugin).toMatchObject({
      version: '1.0.0',
      state: 'Active',
      enabled: true,
      permissions: { granted: ['ui.panel'], denied: [] },
    })
    expect(env.grants.get(PLUGIN_ID)).toEqual(['ui.panel'])
    const persisted = JSON.parse(await readFile(env.grantsFile, 'utf8')) as {
      entries: Record<string, string[]>
    }
    expect(persisted.entries[PLUGIN_ID]).toEqual(['ui.panel'])
  })

  it('keeps an uninstalled remote plugin listed and reinstalls its recorded release', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({
      version: '1.0.0',
      requires: ['ui.panel'],
    })
    const digest = digestOf(zip)
    env.publish({ version: '1.0.0', zip, digest })

    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-removed',
      sha256: digest,
      capabilities: ['ui.panel'],
    })
    await env.manager.uninstall(PLUGIN_ID)

    expect(
      (await env.manager.list()).plugins.find(
        plugin => plugin.id === PLUGIN_ID,
      ),
    ).toMatchObject({
      state: 'NotInstalled',
      enabled: false,
      canUninstall: false,
      canInstall: true,
      origin: { kind: 'remote', url: REPO_SOURCE, sha256: digest },
    })
    // Uninstall clears the grants; the record still knows what was approved.
    expect(env.grants.get(PLUGIN_ID)).toEqual([])

    const reinstalled = await env.manager.reinstall(PLUGIN_ID)
    expect(reinstalled.plugin).toMatchObject({
      id: PLUGIN_ID,
      version: '1.0.0',
      state: 'Active',
      enabled: true,
      permissions: { granted: ['ui.panel'], denied: [] },
      origin: { kind: 'remote', sha256: digest },
    })
    expect(env.grants.get(PLUGIN_ID)).toEqual(['ui.panel'])
    expect(
      (await env.manager.list()).plugins.filter(
        plugin => plugin.id === PLUGIN_ID,
      ),
    ).toHaveLength(1)
  })

  it('requires native confirmation before reinstalling a removed plugin', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({
      version: '1.0.0',
      requires: ['ui.panel'],
    })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-confirm-removed',
      capabilities: ['ui.panel'],
    })
    await env.manager.uninstall(PLUGIN_ID)

    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const confirmPluginAction = vi.fn(async () => false)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
      confirmPluginAction,
    })

    await expect(
      handlers[channels.pluginReinstall]!({ pluginId: PLUGIN_ID }),
    ).rejects.toMatchObject({ code: 'E_CONFIRMATION_DENIED' })
    expect(confirmPluginAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'remote-install',
        detail: expect.stringContaining('ui.panel'),
      }),
    )
    // Nothing was installed by the rejected confirmation.
    expect(
      (await env.manager.list()).plugins.find(
        plugin => plugin.id === PLUGIN_ID,
      ),
    ).toMatchObject({ state: 'NotInstalled' })
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

  it('keeps the plugin disabled when provenance write fails after commit', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    vi.spyOn(env.provenance, 'set').mockRejectedValueOnce(
      new Error('provenance disk full'),
    )

    await expect(
      env.manager.installFromRemote({
        url: REPO_SOURCE,
        operationId: 'install-provenance-failure',
      }),
    ).rejects.toMatchObject({ code: 'E_INSTALL_FAILED' })

    expect(env.state.isDisabled(PLUGIN_ID)).toBe(true)
    expect(await listEntries(env.userRoot)).toEqual([])
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

  it('honours cancellation before the install commit starts', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    let cancelled = false

    await expect(
      env.manager.installFromRemote(
        {
          url: REPO_SOURCE,
          operationId: 'install-cancel-before-commit',
        },
        progress => {
          if (progress.phase === 'installing') {
            cancelled = env.manager.cancelDownload(
              'install-cancel-before-commit',
            )
          }
        },
      ),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' })

    expect(cancelled).toBe(true)
    expect(await listEntries(env.userRoot)).toEqual([])
  })

  it('refuses cancellation once the install commit section has started', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })

    let lateCancel: boolean | undefined
    const installed = await env.manager.installFromRemote(
      { url: REPO_SOURCE, operationId: 'install-cancel-mid-commit' },
      progress => {
        if (progress.phase !== 'installing') return
        // The commit section starts as soon as this callback returns, so a
        // cancellation on a later task must be refused rather than abort a
        // half-committed install.
        setTimeout(() => {
          lateCancel = env.manager.cancelDownload('install-cancel-mid-commit')
        }, 0)
      },
    )

    expect(lateCancel).toBe(false)
    expect(installed.changed).toBe(true)
    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
  })

  it('restores an orphaned backup when the journal is missing', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-orphan',
    })
    const target = path.join(env.userRoot, PLUGIN_ID)
    await rename(target, path.join(env.userRoot, `.backup-${PLUGIN_ID}-orphan`))

    await env.manager.prepare()

    await access(path.join(target, 'plugin.json'))
    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
  })

  it('recovers an update interrupted after the old directory was moved aside', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-recovery',
    })
    const oldEntry = env.provenance.get(PLUGIN_ID)!
    const pluginDir = path.join(env.userRoot, PLUGIN_ID)
    const backupName = `.backup-${PLUGIN_ID}-crash`
    const workName = '.update-crash'
    await rename(pluginDir, path.join(env.userRoot, backupName))
    await mkdir(path.join(env.userRoot, workName))
    const journalDir = path.join(env.root, 'plugin-transactions')
    await mkdir(journalDir)
    await writeFile(
      path.join(journalDir, `${PLUGIN_ID}.json`),
      JSON.stringify({
        version: 1,
        pluginId: PLUGIN_ID,
        stage: 'backed-up',
        backupName,
        workName,
        previousDisabled: true,
        previousProvenance: oldEntry,
        nextProvenance: {
          ...oldEntry,
          sha256: 'b'.repeat(64),
          installedAt: '2026-03-01T00:00:00Z',
        },
      }),
    )

    await env.manager.prepare()

    await access(path.join(pluginDir, 'plugin.json'))
    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
    expect(env.provenance.get(PLUGIN_ID)?.sha256).toBe(oldEntry.sha256)
    expect(await listEntries(journalDir)).toEqual([])
    expect((await env.manager.detail(PLUGIN_ID)).enabled).toBe(false)
  })

  it('finishes cleanup for a committed update whose backup deletion failed', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-committed-cleanup',
    })
    const oldEntry = env.provenance.get(PLUGIN_ID)!
    const pluginDir = path.join(env.userRoot, PLUGIN_ID)
    // Simulate a post-commit crash: the new tree is in place, the old tree is
    // still parked as a backup and the journal already reached `committed`.
    const backupName = `.backup-${PLUGIN_ID}-committed`
    await cp(pluginDir, path.join(env.userRoot, backupName), {
      recursive: true,
    })
    const journalDir = path.join(env.root, 'plugin-transactions')
    await mkdir(journalDir)
    await writeFile(
      path.join(journalDir, `${PLUGIN_ID}.json`),
      JSON.stringify({
        version: 1,
        pluginId: PLUGIN_ID,
        stage: 'committed',
        backupName,
        workName: '.update-committed',
        previousDisabled: true,
        previousProvenance: { ...oldEntry, sha256: 'a'.repeat(64) },
        nextProvenance: oldEntry,
      }),
    )

    await env.manager.prepare()

    await access(path.join(pluginDir, 'plugin.json'))
    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
    expect(env.provenance.get(PLUGIN_ID)?.sha256).toBe(oldEntry.sha256)
    expect(await listEntries(journalDir)).toEqual([])
  })

  it('never exposes a half-updated plugin to a concurrent list()', async () => {
    let markCommitOpen!: () => void
    const commitOpen = new Promise<void>(resolve => {
      markCommitOpen = resolve
    })
    let releaseCommit!: () => void
    const commitGate = new Promise<void>(resolve => {
      releaseCommit = resolve
    })
    let paused = false
    const env = await createEnv({
      // Pause inside the commit section, between the directory swap and the
      // provenance write, which is the window a naive read would tear.
      copyDirectory: async (from, to, options) => {
        if (!paused) {
          paused = true
          markCommitOpen()
          await commitGate
        }
        await copyDirectorySafe(from, to, options)
      },
    })

    const firstZip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip: firstZip, digest: digestOf(firstZip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-snapshot',
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

    const updating = env.manager.applyUpdate({
      pluginId: PLUGIN_ID,
      operationId: 'update-snapshot',
      expectedVersion: '2.0.0',
      expectedSha256: secondDigest,
    })
    await commitOpen

    let settled = false
    const listing = env.manager.list().then(value => {
      settled = true
      return value
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    releaseCommit()
    const updated = await updating
    const listed = await listing
    expect(updated.ok).toBe(true)
    expect(
      listed.plugins.find(plugin => plugin.id === PLUGIN_ID),
    ).toMatchObject({
      id: PLUGIN_ID,
      version: '2.0.0',
      origin: { kind: 'remote', sha256: secondDigest },
    })
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

  it('reports source failures during a bulk check instead of pretending there are no updates', async () => {
    const env = await createEnv()
    const zip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip, digest: digestOf(zip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-check-failure',
    })
    env.routes.set(
      'https://api.github.com/repos/acme/hello/releases/latest',
      () => new Response('unavailable', { status: 503 }),
    )

    const checked = await env.manager.checkUpdates()
    expect(checked.updates).toEqual([])
    expect(checked.issues).toHaveLength(1)
    expect(checked.issues[0]).toContain(PLUGIN_ID)
    expect(checked.issues[0]).toContain('503')
  })

  it('rejects an update when the release changed after it was checked', async () => {
    const env = await createEnv()
    const firstZip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip: firstZip, digest: digestOf(firstZip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-toctou',
    })

    const secondZip = buildPluginZip({ version: '2.0.0' })
    const secondDigest = digestOf(secondZip)
    env.publish({ version: '2.0.0', zip: secondZip, digest: secondDigest })
    const checked = await env.manager.checkUpdates(PLUGIN_ID)
    expect(checked.updates[0]).toMatchObject({
      latestVersion: '2.0.0',
      sha256: secondDigest,
    })

    const thirdZip = buildPluginZip({ version: '3.0.0' })
    env.publish({
      version: '3.0.0',
      zip: thirdZip,
      digest: digestOf(thirdZip),
    })

    await expect(
      env.manager.applyUpdate({
        pluginId: PLUGIN_ID,
        operationId: 'update-toctou',
        expectedVersion: '2.0.0',
        expectedSha256: secondDigest,
      }),
    ).rejects.toMatchObject({ code: 'E_UPDATE_CHANGED' })

    expect((await env.manager.detail(PLUGIN_ID)).version).toBe('1.0.0')
    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
  })

  it('rejects a package whose manifest version does not match the release', async () => {
    const env = await createEnv()
    const firstZip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip: firstZip, digest: digestOf(firstZip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-version-mismatch',
    })

    const mismatchedZip = buildPluginZip({ version: '1.5.0' })
    const digest = digestOf(mismatchedZip)
    env.publish({ version: '2.0.0', zip: mismatchedZip, digest })

    await expect(
      env.manager.applyUpdate({
        pluginId: PLUGIN_ID,
        operationId: 'update-version-mismatch',
        expectedVersion: '2.0.0',
        expectedSha256: digest,
      }),
    ).rejects.toMatchObject({ code: 'E_MANIFEST_INVALID' })

    expect((await env.manager.detail(PLUGIN_ID)).version).toBe('1.0.0')
    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
  })

  it('uses an explicit marketplace release URL for the update and provenance', async () => {
    const env = await createEnv()
    const firstZip = buildPluginZip({ version: '1.0.0' })
    const firstDigest = digestOf(firstZip)
    env.publish({ version: '1.0.0', zip: firstZip, digest: firstDigest })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-for-market-update',
      sha256: firstDigest,
    })

    const secondZip = buildPluginZip({ version: '2.0.0' })
    const secondDigest = digestOf(secondZip)
    env.publish({ version: '2.0.0', zip: secondZip, digest: secondDigest })
    const sourceUrl = `${REPO_SOURCE}/releases/download/v2.0.0/hello.zip`

    const updated = await env.manager.applyUpdate({
      pluginId: PLUGIN_ID,
      operationId: 'market-update',
      expectedVersion: '2.0.0',
      expectedSha256: secondDigest,
      sourceUrl,
    })

    expect(updated.plugin).toMatchObject({
      id: PLUGIN_ID,
      version: '2.0.0',
      enabled: true,
    })
    expect(env.provenance.get(PLUGIN_ID)?.url).toBe(sourceUrl)
  })

  it('updates a live plugin in place and preserves config and data', async () => {
    const env = await createEnv()
    const firstZip = buildPluginZip({ version: '1.0.0' })
    const firstDigest = digestOf(firstZip)
    env.publish({ version: '1.0.0', zip: firstZip, digest: firstDigest })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-v1',
    })
    await writeUserData(env)

    const secondZip = buildPluginZip({
      version: '2.0.0',
      extraEntries: [
        {
          name: 'config/settings.json',
          content: '{"a":"default-from-v2"}',
        },
      ],
    })
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
      expectedVersion: '2.0.0',
      expectedSha256: secondDigest,
    })

    expect(updated.ok).toBe(true)
    expect(updated.changed).toBe(true)
    expect(updated.restartRequired).toBe(false)
    expect(updated.plugin).toMatchObject({
      id: PLUGIN_ID,
      version: '2.0.0',
      state: 'Active',
      enabled: true,
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
    ) as {
      entries: Record<string, { sha256: string }>
    }
    expect(provenance.entries[PLUGIN_ID]?.sha256).toBe(secondDigest)

    expect(await listEntries(env.userRoot)).toEqual([PLUGIN_ID])
  })

  it('installs a capability-adding update disabled for explicit approval', async () => {
    const env = await createEnv()
    const firstZip = buildPluginZip({ version: '1.0.0' })
    env.publish({ version: '1.0.0', zip: firstZip, digest: digestOf(firstZip) })
    await env.manager.installFromRemote({
      url: REPO_SOURCE,
      operationId: 'install-before-capability-update',
    })
    expect((await env.manager.detail(PLUGIN_ID)).state).toBe('Active')

    const secondZip = buildPluginZip({
      version: '2.0.0',
      requires: ['ui.panel'],
    })
    const secondDigest = digestOf(secondZip)
    env.publish({ version: '2.0.0', zip: secondZip, digest: secondDigest })

    const result = await env.manager.applyUpdate({
      pluginId: PLUGIN_ID,
      operationId: 'update-adds-capability',
      expectedVersion: '2.0.0',
      expectedSha256: secondDigest,
    })

    expect(result.plugin).toMatchObject({
      version: '2.0.0',
      state: 'Disabled',
      enabled: false,
      permissions: { denied: ['ui.panel'] },
    })
    expect(result.message).toContain('require approval')
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
      expectedVersion: '1.0.0',
      expectedSha256: digestOf(zip),
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
    const brokenDigest = digestOf(brokenZip)
    env.publish({
      version: '2.0.0',
      zip: brokenZip,
      digest: brokenDigest,
    })

    await expect(
      env.manager.applyUpdate({
        pluginId: PLUGIN_ID,
        operationId: 'update-broken',
        expectedVersion: '2.0.0',
        expectedSha256: brokenDigest,
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
        expectedVersion: '2.0.0',
        expectedSha256: digestOf(brokenZip),
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
        expectedVersion: '9.9.9',
        expectedSha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'E_PROVENANCE_MISSING' })
    await expect(
      env.manager.checkUpdates('com.acme.local'),
    ).rejects.toMatchObject({
      code: 'E_PROVENANCE_MISSING',
    })
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
        expectedVersion: '2.0.0',
        expectedSha256: 'a'.repeat(64),
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
