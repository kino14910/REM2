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
import { LocalPluginManager } from '../../src/host/plugins/local-plugin-manager.js'
import { PluginStateStore } from '../../src/host/plugins/state-store.js'
import { ThemeRegistryImpl } from '../../src/host/electron/theme-registry.js'
import { createMethodHandlers } from '../../src/host/ipc/method-handlers.js'
import { IpcBridge } from '../../src/host/ipc/bridge.js'
import {
  Ipc,
  channels,
  type IpcResponse,
} from '../../src/shared/ipc-contract.js'
import type { copyDirectorySafe } from '../../src/host/plugins/safe-fs.js'
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
  state: PluginStateStore
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
  const kernel = new Kernel({
    id: 'rem2-plugin-manager-test',
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
    ...(options.copyDirectory ? { copyDirectory: options.copyDirectory } : {}),
  })
  const env: Env = {
    root,
    userRoot,
    builtinRoot,
    dataRoot,
    sourceRoot,
    stateFile,
    state,
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
  it('installs disabled without executing code, then enables and disables it', async () => {
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
      state: 'Disabled',
      enabled: false,
      canUninstall: true,
    })
    await expect(access(marker)).rejects.toThrow()
    await access(
      path.join(env.userRoot, 'com.example.installed', 'plugin.json'),
    )

    const enabled = await env.manager.enable('com.example.installed')
    expect(enabled.plugin?.state).toBe('Active')
    expect(await readFile(marker, 'utf8')).toBe('executed')

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
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
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

  it('manages the real built-in catalog without allowing uninstall', async ({
    skip,
  }) => {
    const builtinRoot = path.join(process.cwd(), 'plugins-dist')
    try {
      await access(path.join(builtinRoot, 'plugin-inspector', 'plugin.json'))
    } catch {
      skip()
      return
    }
    const env = await createEnv({ builtinRoot })
    const builtin = await env.manager.detail('com.rem2.plugin-inspector')
    expect(builtin).toMatchObject({
      source: 'builtin',
      builtin: true,
      canUninstall: false,
      state: 'Active',
    })
    expect(
      (await env.manager.disable('com.rem2.plugin-inspector')).plugin?.state,
    ).toBe('Disabled')
    expect(
      (await env.manager.enable('com.rem2.plugin-inspector')).plugin?.state,
    ).toBe('Active')
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
    expect(
      (await env.manager.disable('com.example.builtin')).plugin?.state,
    ).toBe('Disabled')
    expect(
      (await env.manager.enable('com.example.builtin')).plugin?.state,
    ).toBe('Active')
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
    expect(serialized).not.toMatch(
      /rootDir|container|permissions|builtin-plugins|[A-Z]:\\/,
    )
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
