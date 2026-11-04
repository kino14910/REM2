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
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { copyDirectorySafe } from '@/host/plugins/safe-fs.js'
import type { EventBus } from '@/kernel/contracts/event-bus.js'

import { ThemeRegistryImpl } from '@/host/electron/theme-registry.js'
import { IpcBridge } from '@/host/ipc/bridge.js'
import { createMethodHandlers } from '@/host/ipc/method-handlers.js'
import { PluginGrantStore } from '@/host/plugins/grant-store.js'
import { LocalPluginManager } from '@/host/plugins/local-plugin-manager.js'
import { PluginRemovedStore } from '@/host/plugins/removed-plugin-store.js'
import { PluginStateStore } from '@/host/plugins/state-store.js'
import { KernelTokens } from '@/kernel/contracts/kernel-tokens.js'
import { Kernel } from '@/kernel/kernel.js'
import { Ipc, channels, type IpcResponse } from '@/shared/ipc-contract.js'

import {
  makeManifest,
  type MakeManifestOptions,
} from '../helpers/make-manifest.js'

interface Env {
  root: string
  userRoot: string
  builtinRoot: string
  dataRoot: string
  sourceRoot: string
  stateFile: string
  grantsFile: string
  removedFile: string
  state: PluginStateStore
  grants: PluginGrantStore
  removed: PluginRemovedStore
  kernel: Kernel
  manager: LocalPluginManager
  dispose(): Promise<void>
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()!()
})

async function writePlugin(
  root: string,
  options: MakeManifestOptions,
  source?: string,
): Promise<string> {
  const dir = path.join(root, options.id)
  await mkdir(dir, { recursive: true })
  const manifest = makeManifest({
    ...options,
    entry: options.entry ?? 'index.js',
  })
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
  await writeFile(path.join(dir, 'index.js'), source ?? defaultSource(), 'utf8')
  return dir
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

const failingCopy: typeof copyDirectorySafe = async (_source, destination) => {
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, 'partial.txt'), 'partial', 'utf8')
  throw new Error('simulated copy failure')
}

async function createEnv(
  options: {
    user?: Array<{ manifest: MakeManifestOptions; source?: string }>
    builtin?: Array<{ manifest: MakeManifestOptions; source?: string }>
    builtinRoot?: string
    copyDirectory?: typeof copyDirectorySafe
  } = {},
): Promise<Env> {
  const root = await mkdtemp(path.join(tmpdir(), 'rem2-manager-'))
  const userRoot = path.join(root, 'user-plugins')
  const builtinRoot = options.builtinRoot ?? path.join(root, 'builtin-plugins')
  const dataRoot = path.join(root, 'plugin-data')
  const sourceRoot = path.join(root, 'sources')
  await Promise.all([
    mkdir(userRoot),
    mkdir(sourceRoot),
    ...(options.builtinRoot ? [] : [mkdir(builtinRoot)]),
  ])
  for (const plugin of options.user ?? []) {
    await writePlugin(userRoot, plugin.manifest, plugin.source)
  }
  for (const plugin of options.builtin ?? []) {
    await writePlugin(builtinRoot, plugin.manifest, plugin.source)
  }

  const stateFile = path.join(root, 'plugin-manager.json')
  const state = new PluginStateStore(stateFile)
  await state.load()
  const grantsFile = path.join(root, 'plugin-grants.json')
  const grants = new PluginGrantStore(grantsFile)
  await grants.load()
  const removedFile = path.join(root, 'plugin-removed.json')
  const removed = new PluginRemovedStore(removedFile)
  await removed.load()
  const kernel = new Kernel({
    id: 'rem2-plugin-manager-test',
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
    grants,
    removed,
    ...(options.copyDirectory ? { copyDirectory: options.copyDirectory } : {}),
  })
  const env: Env = {
    root,
    userRoot,
    builtinRoot,
    dataRoot,
    sourceRoot,
    stateFile,
    grantsFile,
    removedFile,
    state,
    grants,
    removed,
    kernel,
    manager,
    dispose: async () => {
      if (kernel.isStarted()) await kernel.shutdown()
      await rm(root, { recursive: true, force: true })
    },
  }
  disposals.push(env.dispose)
  return env
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

describe('integration · local plugin manager lifecycle', () => {
  it('installs enabled, then disables and re-enables it', async () => {
    const env = await createEnv()
    const marker = path.join(env.root, 'executed.marker')
    await writePlugin(
      env.sourceRoot,
      { id: 'com.example.installed' },
      executableSource(marker),
    )

    const installed = await env.manager.installFromDirectory(
      path.join(env.sourceRoot, 'com.example.installed'),
    )
    expect(installed.plugin).toMatchObject({
      id: 'com.example.installed',
      source: 'user',
      state: 'Active',
      enabled: true,
      canUninstall: true,
    })
    expect(installed.message).toContain('enabled')
    expect(await readFile(marker, 'utf8')).toBe('executed')
    await access(
      path.join(env.userRoot, 'com.example.installed', 'plugin.json'),
    )

    const disabled = await env.manager.disable('com.example.installed')
    expect(disabled.plugin).toMatchObject({
      state: 'Disabled',
      enabled: false,
      restartRequired: true,
    })
    expect(disabled.restartRequired).toBe(true)
    // The intent is persisted, but the live instance is untouched until restart.
    expect(
      env.kernel.pluginRegistry.getLoaded('com.example.installed'),
    ).toBeDefined()
    expect((await env.manager.list()).restartRequired).toBe(true)

    const restarted = await env.manager.restart()
    expect(restarted).toMatchObject({
      ok: true,
      changed: true,
      restartRequired: false,
    })
    expect(env.kernel.isStarted()).toBe(true)
    expect(
      env.kernel.pluginRegistry.getLoaded('com.example.installed'),
    ).toBeUndefined()
    expect((await env.manager.list()).restartRequired).toBe(false)
    expect(await env.manager.disable('com.example.installed')).toMatchObject({
      changed: false,
      restartRequired: false,
    })

    // Re-enabling starts the same installed plugin again.
    const enabled = await env.manager.enable('com.example.installed')
    expect(enabled.plugin?.state).toBe('Active')
  })

  it('restarts only the plugin service and keeps kernel infrastructure alive', async () => {
    const env = await createEnv({
      user: [{ manifest: { id: 'com.example.live' } }],
    })
    const root = env.kernel.root
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    expect((await env.manager.detail('com.example.live')).state).toBe('Active')

    const result = await env.manager.restart()

    expect(result).toMatchObject({ ok: true, changed: true })
    expect(env.kernel.isStarted()).toBe(true)
    expect(env.kernel.root).toBe(root)
    expect(env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)).toBe(bus)
    expect(env.kernel.lastStartResult.started).toContain('com.example.live')
    expect((await env.manager.detail('com.example.live')).state).toBe('Active')
  })

  it('rolls back staging and the target when copying fails', async () => {
    const env = await createEnv({ copyDirectory: failingCopy })
    await writePlugin(env.sourceRoot, { id: 'com.example.rollback' })

    await expect(
      env.manager.installFromDirectory(
        path.join(env.sourceRoot, 'com.example.rollback'),
      ),
    ).rejects.toMatchObject({ code: 'E_INSTALL_FAILED' })
    expect(await readdir(env.userRoot)).toEqual([])
    await expect(
      env.manager.detail('com.example.rollback'),
    ).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })

  it('rejects invalid manifests, traversal entries, duplicate ids and managed sources', async () => {
    const env = await createEnv({
      builtin: [{ manifest: { id: 'com.example.builtin' } }],
    })

    const invalid = path.join(env.sourceRoot, 'invalid')
    await mkdir(invalid)
    await writeFile(
      path.join(invalid, 'plugin.json'),
      JSON.stringify({
        id: 'com.example.invalid',
        name: 'Bad',
        version: '1.0',
        entry: 'index.js',
      }),
      'utf8',
    )
    await writeFile(path.join(invalid, 'index.js'), defaultSource(), 'utf8')
    await expect(
      env.manager.installFromDirectory(invalid),
    ).rejects.toMatchObject({
      code: 'E_MANIFEST_INVALID',
    })

    const traversal = path.join(env.sourceRoot, 'traversal')
    await mkdir(traversal)
    await writeFile(
      path.join(traversal, 'plugin.json'),
      JSON.stringify(
        makeManifest({ id: 'com.example.traversal', entry: '../outside.js' }),
      ),
      'utf8',
    )
    await writeFile(
      path.join(env.sourceRoot, 'outside.js'),
      defaultSource(),
      'utf8',
    )
    await expect(
      env.manager.installFromDirectory(traversal),
    ).rejects.toMatchObject({
      code: 'E_PATH_ESCAPE',
    })

    const missingEntry = path.join(env.sourceRoot, 'missing-entry')
    await mkdir(missingEntry)
    await writeFile(
      path.join(missingEntry, 'plugin.json'),
      JSON.stringify(makeManifest({ id: 'com.example.missing-entry' })),
      'utf8',
    )
    await expect(
      env.manager.installFromDirectory(missingEntry),
    ).rejects.toMatchObject({
      code: 'E_ENTRY_INVALID',
    })

    const missingDependency = await writePlugin(env.sourceRoot, {
      id: 'com.example.needs-missing',
      dependencies: { 'com.example.absent': '^1.0.0' },
    })
    await expect(
      env.manager.installFromDirectory(missingDependency),
    ).rejects.toMatchObject({
      code: 'E_DEPENDENCY',
    })

    const duplicate = await writePlugin(env.sourceRoot, {
      id: 'com.example.builtin',
    })
    await expect(
      env.manager.installFromDirectory(duplicate),
    ).rejects.toMatchObject({
      code: 'E_DUPLICATE_ID',
    })
    await expect(
      env.manager.installFromDirectory(env.userRoot),
    ).rejects.toMatchObject({
      code: 'E_SOURCE_INVALID',
    })
  })

  it('rejects symbolic links inside an install tree', async ({ skip }) => {
    const env = await createEnv()
    const source = await writePlugin(env.sourceRoot, {
      id: 'com.example.linked',
    })
    const target = path.join(env.root, 'outside.js')
    await writeFile(target, defaultSource(), 'utf8')
    try {
      const { symlink } = await import('node:fs/promises')
      await symlink(target, path.join(source, 'linked.js'), 'file')
    } catch (error) {
      if (
        ['EPERM', 'EACCES', 'UNKNOWN'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        skip()
        return
      }
      throw error
    }

    await expect(
      env.manager.installFromDirectory(source),
    ).rejects.toMatchObject({
      code: 'E_UNSAFE_TREE',
    })
    expect(await readdir(env.userRoot)).toEqual([])
  })

  it('cascades disable to loaded dependents and re-enables the closure on enable', async () => {
    const env = await createEnv({
      user: [
        { manifest: { id: 'com.example.dep' } },
        {
          manifest: {
            id: 'com.example.app',
            dependencies: { 'com.example.dep': '^1.0.0' },
          },
        },
      ],
    })

    const disabled = await env.manager.disable('com.example.dep')
    expect(disabled.plugin?.state).toBe('Disabled')
    expect(disabled.restartRequired).toBe(true)
    expect((await env.manager.detail('com.example.app')).enabled).toBe(false)

    await env.manager.restart()
    expect(
      env.kernel.pluginRegistry.getLoaded('com.example.dep'),
    ).toBeUndefined()
    expect(
      env.kernel.pluginRegistry.getLoaded('com.example.app'),
    ).toBeUndefined()

    const enabled = await env.manager.enable('com.example.app')
    expect(enabled.plugin?.state).toBe('Active')
    expect((await env.manager.detail('com.example.dep')).enabled).toBe(true)
    expect(env.kernel.pluginRegistry.getLoaded('com.example.dep')).toBeDefined()
  })

  it('still reports a hard dependency that is not installed at all', async () => {
    const env = await createEnv({
      user: [
        {
          manifest: {
            id: 'com.example.orphan',
            dependencies: { 'com.example.absent': '^1.0.0' },
          },
        },
      ],
    })

    await expect(env.manager.enable('com.example.orphan')).rejects.toThrow(
      /missing hard dependency/,
    )
  })

  it('protects dependents on uninstall and preserves config and data', async () => {
    const env = await createEnv()
    await writePlugin(env.userRoot, {
      id: 'com.example.dep',
    })
    await writePlugin(env.userRoot, {
      id: 'com.example.keep',
      dependencies: { 'com.example.dep': '^1.0.0' },
    })
    await mkdir(path.join(env.userRoot, 'com.example.keep', 'config'))
    await mkdir(path.join(env.userRoot, 'com.example.keep', 'data'))
    await writeFile(
      path.join(env.userRoot, 'com.example.keep', 'config', 'settings.json'),
      '{"a":1}',
      'utf8',
    )
    await writeFile(
      path.join(env.userRoot, 'com.example.keep', 'data', 'store.json'),
      '{"b":2}',
      'utf8',
    )

    await expect(
      env.manager.uninstall('com.example.dep'),
    ).rejects.toMatchObject({
      code: 'E_DEPENDENTS',
    })
    await env.manager.uninstall('com.example.keep')
    expect(
      await readFile(
        path.join(env.dataRoot, 'com.example.keep', 'config', 'settings.json'),
        'utf8',
      ),
    ).toBe('{"a":1}')
    expect(
      await readFile(
        path.join(env.dataRoot, 'com.example.keep', 'data', 'store.json'),
        'utf8',
      ),
    ).toBe('{"b":2}')
    await expect(
      access(path.join(env.userRoot, 'com.example.keep')),
    ).rejects.toThrow()
    await env.manager.uninstall('com.example.dep')
  })

  it('keeps an uninstalled plugin listed as NotInstalled and installable', async () => {
    const env = await createEnv()
    const source = await writePlugin(env.sourceRoot, {
      id: 'com.example.removed',
    })
    await env.manager.installFromDirectory(source)
    expect((await env.manager.detail('com.example.removed')).state).toBe(
      'Active',
    )

    await env.manager.uninstall('com.example.removed')

    expect(
      (await env.manager.list()).plugins.find(
        plugin => plugin.id === 'com.example.removed',
      ),
    ).toMatchObject({
      state: 'NotInstalled',
      enabled: false,
      canUninstall: false,
      canInstall: true,
      origin: { kind: 'directory' },
    })
    expect(await env.manager.detail('com.example.removed')).toMatchObject({
      state: 'NotInstalled',
      canInstall: true,
    })
    // A directory record has no replayable path; the UI falls back to the chooser.
    await expect(
      env.manager.reinstall('com.example.removed'),
    ).rejects.toMatchObject({
      code: 'E_SOURCE_INVALID',
    })

    // Installing the same id again replaces the removed entry in the list.
    await env.manager.installFromDirectory(source)
    const matching = (await env.manager.list()).plugins.filter(
      plugin => plugin.id === 'com.example.removed',
    )
    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({ state: 'Active', canInstall: false })
  })

  it('preserves the newest config when the same plugin is uninstalled twice', async () => {
    const env = await createEnv()
    const source = await writePlugin(env.sourceRoot, {
      id: 'com.example.reinstall',
    })
    await env.manager.installFromDirectory(source)
    const installed = path.join(env.userRoot, 'com.example.reinstall')
    await mkdir(path.join(installed, 'config'), { recursive: true })
    await writeFile(
      path.join(installed, 'config', 'settings.json'),
      '{"value":"first"}',
      'utf8',
    )
    await env.manager.uninstall('com.example.reinstall')

    await env.manager.installFromDirectory(source)
    await mkdir(path.join(installed, 'config'), { recursive: true })
    await writeFile(
      path.join(installed, 'config', 'settings.json'),
      '{"value":"second"}',
      'utf8',
    )
    await env.manager.uninstall('com.example.reinstall')

    expect(
      await readFile(
        path.join(
          env.dataRoot,
          'com.example.reinstall',
          'config',
          'settings.json',
        ),
        'utf8',
      ),
    ).toBe('{"value":"second"}')
  })

  it('persists disabled intent across a kernel restart', async () => {
    const env = await createEnv({
      user: [{ manifest: { id: 'com.example.persist' } }],
    })
    await env.manager.disable('com.example.persist')
    await env.kernel.shutdown()

    const state = new PluginStateStore(env.stateFile)
    await state.load()
    expect(state.isDisabled('com.example.persist')).toBe(true)
    const restarted = new Kernel({
      roots: [env.userRoot],
      builtinRoot: env.builtinRoot,
      disabledPlugins: state.ids(),
      logLevel: 'error',
    })
    disposals.push(async () => {
      if (restarted.isStarted()) await restarted.shutdown()
    })
    await restarted.start()
    expect(
      restarted.pluginRegistry.getLoaded('com.example.persist'),
    ).toBeUndefined()
    const manager = new LocalPluginManager({
      kernel: restarted,
      userRoot: env.userRoot,
      dataRoot: env.dataRoot,
      state,
      builtinRoot: env.builtinRoot,
    })
    expect((await manager.detail('com.example.persist')).state).toBe('Disabled')
  })

  it('retains Failed and enabled intent when lifecycle start fails', async () => {
    const env = await createEnv({
      user: [
        {
          manifest: { id: 'com.example.failing' },
          source: `export default function () { return { async onStart() { throw new Error('boom') } } }`,
        },
      ],
    })

    const detail = await env.manager.detail('com.example.failing')
    expect(detail).toMatchObject({ state: 'Failed', enabled: true })
    await expect(env.manager.enable('com.example.failing')).rejects.toThrow(
      /plugin failed to start/,
    )
    expect((await env.manager.detail('com.example.failing')).state).toBe(
      'Failed',
    )
  })

  it('lists built-in plugins while protecting them from uninstall', async () => {
    const env = await createEnv({
      builtin: [{ manifest: { id: 'com.example.builtin' } }],
    })

    const builtin = await env.manager.detail('com.example.builtin')
    expect(builtin).toMatchObject({
      source: 'builtin',
      builtin: true,
      canUninstall: false,
      state: 'Active',
    })
    await expect(
      env.manager.uninstall('com.example.builtin'),
    ).rejects.toMatchObject({
      code: 'E_BUILTIN_PROTECTED',
    })
    await expect(
      env.manager.grantPermissions('com.example.builtin', ['log.sink']),
    ).rejects.toMatchObject({
      code: 'E_BUILTIN_PROTECTED',
    })
    expect(
      (await env.manager.disable('com.example.builtin')).plugin?.state,
    ).toBe('Disabled')
    expect(
      (await env.manager.enable('com.example.builtin')).plugin?.state,
    ).toBe('Active')
  })

  it('denies UI capabilities to a sandboxed plugin until the user grants them', async () => {
    const env = await createEnv({
      user: [
        {
          manifest: {
            id: 'com.example.granted',
            requires: ['ui.panel'],
          },
          source: `
export default function factory(ctx) {
  return {
    async onStart() {
      ctx.extensions.contribute('ui.panel', {
        contributionId: 'qa-granted',
        impl: {
          panelId: 'qa-granted',
          title: 'Granted Panel',
          icon: '🔓',
          region: 'main',
          order: 20,
          command: 'test.none',
        },
      })
    },
  }
}
`,
        },
      ],
    })

    const before = await env.manager.detail('com.example.granted')
    expect(before.permissions).toEqual({ granted: [], denied: ['ui.panel'] })
    expect(before.state).toBe('Failed')

    const granted = await env.manager.grantPermissions('com.example.granted', [
      'ui.panel',
    ])
    expect(granted.plugin?.permissions).toEqual({
      granted: ['ui.panel'],
      denied: [],
    })

    const persisted = JSON.parse(await readFile(env.grantsFile, 'utf8')) as {
      version: number
      entries: Record<string, string[]>
    }
    expect(persisted).toEqual({
      version: 1,
      entries: { 'com.example.granted': ['ui.panel'] },
    })

    const enabled = await env.manager.enable('com.example.granted')
    expect(enabled.plugin?.state).toBe('Active')
    expect(
      env.kernel.extensions
        .listAll<{ panelId: string }>('ui.panel')
        .some(panel => panel.panelId === 'qa-granted'),
    ).toBe(true)

    await expect(
      env.manager.grantPermissions('com.example.granted', ['ui.theme']),
    ).rejects.toMatchObject({ code: 'E_CAPABILITY_INVALID' })
  })

  it('rejects enable when the plugin changed after confirmation', async () => {
    const env = await createEnv({
      user: [{ manifest: { id: 'com.example.toctou' } }],
    })
    await env.manager.disable('com.example.toctou')
    await writeFile(
      path.join(env.userRoot, 'com.example.toctou', 'plugin.json'),
      JSON.stringify(
        makeManifest({
          id: 'com.example.toctou',
          version: '2.0.0',
          entry: 'index.js',
        }),
      ),
      'utf8',
    )

    await expect(
      env.manager.enable('com.example.toctou', { version: '1.0.0' }),
    ).rejects.toMatchObject({ code: 'E_TARGET_CHANGED' })
    expect((await env.manager.detail('com.example.toctou')).enabled).toBe(false)
  })

  it('refuses uninstall when config is a special file and leaves the plugin intact', async () => {
    const env = await createEnv({
      user: [{ manifest: { id: 'com.example.unsafe-config' } }],
    })
    const pluginDir = path.join(env.userRoot, 'com.example.unsafe-config')
    await writeFile(path.join(pluginDir, 'config'), 'not a directory', 'utf8')

    await expect(
      env.manager.uninstall('com.example.unsafe-config'),
    ).rejects.toMatchObject({
      code: 'E_UNSAFE_TREE',
    })

    await access(path.join(pluginDir, 'plugin.json'))
    expect(
      (await env.manager.detail('com.example.unsafe-config')).enabled,
    ).toBe(true)
  })

  it('keeps the plugin when grant cleanup fails during uninstall, then retries safely', async () => {
    const env = await createEnv({
      user: [
        {
          manifest: { id: 'com.example.grant-cleanup', requires: ['ui.panel'] },
        },
      ],
    })
    await env.manager.grantPermissions('com.example.grant-cleanup', [
      'ui.panel',
    ])
    const pluginDir = path.join(env.userRoot, 'com.example.grant-cleanup')
    const remove = vi
      .spyOn(env.grants, 'remove')
      .mockRejectedValueOnce(new Error('grant store locked'))

    await expect(
      env.manager.uninstall('com.example.grant-cleanup'),
    ).rejects.toThrow(/grant store locked/)

    // No code is deleted and the plugin cannot restart while cleanup is retried.
    await access(path.join(pluginDir, 'plugin.json'))
    expect(
      (await env.manager.detail('com.example.grant-cleanup')).enabled,
    ).toBe(false)
    expect(env.grants.get('com.example.grant-cleanup')).toEqual(['ui.panel'])

    remove.mockRestore()
    await env.manager.uninstall('com.example.grant-cleanup')
    await expect(access(pluginDir)).rejects.toThrow()
    expect(env.grants.get('com.example.grant-cleanup')).toEqual([])
  })
})

describe('integration · plugin management IPC boundary', () => {
  it('validates args and projects plugin DTOs without filesystem internals', async () => {
    const env = await createEnv({
      builtin: [{ manifest: { id: 'com.example.builtin' } }],
    })
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
    })
    const list = handlers[channels.pluginList]!
    const detail = handlers[channels.pluginDetail]!
    const install = handlers[channels.pluginInstallFromDirectory]!
    const enable = handlers[channels.pluginEnable]!

    const result = (await list(undefined)) as {
      plugins: Array<Record<string, unknown>>
    }
    expect(result.plugins[0]).toMatchObject({
      id: 'com.example.builtin',
      source: 'builtin',
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/rootDir|container|builtin-plugins|[A-Z]:\\/)
    expect(result.plugins[0]).not.toHaveProperty('manifest')

    expect(() => list({})).toThrow(/no arguments/)
    expect(() => detail({ pluginId: '../escape' })).toThrow(/invalid format/)
    expect(() => detail(undefined)).toThrow(/expected an object/)
    await expect(
      detail({ pluginId: 'com.example.missing' }),
    ).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    await expect(install({ sourcePath: 'C:\\untrusted' })).rejects.toThrow(
      /no arguments/,
    )
    expect(() => handlers[channels.pluginRestart]!({ force: true })).toThrow(
      /no arguments/,
    )
    await expect(
      enable({ pluginId: 'com.example.missing' }),
    ).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })

  it('uninstalls without confirmation but still confirms enable', async () => {
    const env = await createEnv({
      user: [
        { manifest: { id: 'com.example.uninstall' } },
        { manifest: { id: 'com.example.enable-confirm' } },
      ],
    })
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const confirmPluginAction = vi.fn(async () => false)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
      confirmPluginAction,
    })

    const removed = (await handlers[channels.pluginUninstall]!({
      pluginId: 'com.example.uninstall',
    })) as { ok: boolean; changed: boolean }
    expect(removed).toMatchObject({ ok: true, changed: true })
    // No banner and no dialog are part of the uninstall path any more.
    expect(confirmPluginAction).not.toHaveBeenCalled()
    await expect(
      access(path.join(env.userRoot, 'com.example.uninstall', 'plugin.json')),
    ).rejects.toThrow()

    await env.manager.disable('com.example.enable-confirm')
    await expect(
      handlers[channels.pluginEnable]!({
        pluginId: 'com.example.enable-confirm',
      }),
    ).rejects.toMatchObject({ code: 'E_CONFIRMATION_DENIED' })
    expect(
      (await env.manager.detail('com.example.enable-confirm')).enabled,
    ).toBe(false)
  })

  it('fails closed when the host cannot present a confirmation dialog', async () => {
    const env = await createEnv({
      user: [{ manifest: { id: 'com.example.no-confirm' } }],
    })
    await env.manager.disable('com.example.no-confirm')
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
    })

    await expect(
      handlers[channels.pluginEnable]!({ pluginId: 'com.example.no-confirm' }),
    ).rejects.toMatchObject({ code: 'E_CONFIRMATION_UNAVAILABLE' })
    expect((await env.manager.detail('com.example.no-confirm')).enabled).toBe(
      false,
    )
  })

  it('grants and enables through one confirmed IPC call', async () => {
    const env = await createEnv({
      user: [
        { manifest: { id: 'com.example.consent', requires: ['ui.panel'] } },
      ],
    })
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const confirmPluginAction = vi.fn(async () => true)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
      confirmPluginAction,
    })

    const result = (await handlers[channels.pluginEnable]!({
      pluginId: 'com.example.consent',
      capabilities: ['ui.panel'],
    })) as { plugin?: { state: string; permissions: unknown } }

    expect(result.plugin?.state).toBe('Active')
    expect(result.plugin?.permissions).toEqual({
      granted: ['ui.panel'],
      denied: [],
    })
    expect(env.grants.get('com.example.consent')).toEqual(['ui.panel'])
    expect(confirmPluginAction).toHaveBeenCalledTimes(1)
    expect(confirmPluginAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'enable',
        detail: expect.stringContaining('ui.panel'),
      }),
    )
  })

  it('returns changed:false when the native directory chooser is cancelled', async () => {
    const env = await createEnv()
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
      choosePluginDirectory: async () => undefined,
    })
    expect(
      await handlers[channels.pluginInstallFromDirectory]!(undefined),
    ).toEqual({
      ok: true,
      changed: false,
      restartRequired: false,
      message: 'Installation cancelled.',
    })
  })

  it('approves directory capabilities before installing and enables the plugin', async () => {
    const env = await createEnv()
    const source = await writePlugin(env.sourceRoot, {
      id: 'com.example.approved',
      requires: ['ui.panel'],
    })
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const confirmPluginAction = vi.fn(async () => true)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
      choosePluginDirectory: async () => source,
      confirmPluginAction,
    })

    const result = (await handlers[channels.pluginInstallFromDirectory]!(
      undefined,
    )) as {
      plugin?: { state: string; enabled: boolean; permissions: unknown }
    }

    expect(result.plugin).toMatchObject({ state: 'Active', enabled: true })
    expect(result.plugin?.permissions).toEqual({
      granted: ['ui.panel'],
      denied: [],
    })
    expect(env.grants.get('com.example.approved')).toEqual(['ui.panel'])
    expect(confirmPluginAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'directory-install',
        detail: expect.stringContaining('ui.panel'),
      }),
    )
  })

  it('forwards stable management error codes through the IPC bridge', async () => {
    const env = await createEnv()
    const bus = env.kernel.root.resolve<EventBus>(KernelTokens.EventBus)
    const handlers = createMethodHandlers({
      kernel: env.kernel,
      bus,
      themeRegistry: new ThemeRegistryImpl(),
      pluginManager: env.manager,
    })
    bus.respond(channels.pluginDetail, handlers[channels.pluginDetail]!)

    const responses: IpcResponse[] = []
    const bridge = new IpcBridge(bus)
    bridge.bind({
      send: (_channel, payload) => {
        responses.push(payload as IpcResponse)
      },
      on: (channel, handler) => {
        if (channel === Ipc.Invoke) {
          void handler({
            id: 'plugin-ipc-1',
            method: channels.pluginDetail,
            args: { pluginId: 'com.example.missing' },
          })
        }
        return () => undefined
      },
    })

    await waitFor(() => responses.length > 0)
    expect(responses[0]).toMatchObject({
      ok: false,
      errorCode: 'E_NOT_FOUND',
    })
    bridge.unbind()
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not met')
}
