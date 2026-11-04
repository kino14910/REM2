import type { Component } from 'svelte'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-svelte'
import { userEvent } from 'vitest/browser'

import type {
  PluginDetailDto,
  PluginListDto,
  PluginOperationResultDto,
  PluginRemoteInspectionDto,
  PluginUpdateDto,
  PluginUpdateCheckDto,
} from '@/shared/ipc-contract'

import PluginManager from '@/frontend/app/components/PluginManager.svelte'
import { plugins } from '@/frontend/lib/stores/plugins.svelte'
import { channels } from '@/shared/ipc-contract'

const SHA256 = 'a'.repeat(64)
const REMOTE_URL = 'https://github.com/owner/repo/releases/tag/v2.0.0'

// `src/declarations.d.ts` types every `*.svelte` import as
// `Component<Record<string, never>>`; this component takes no props.
const PluginManagerView = PluginManager as Component<Record<string, never>>

function makePlugin(overrides: Partial<PluginDetailDto> = {}): PluginDetailDto {
  return {
    id: 'com.example.remote',
    name: 'Remote Example',
    version: '1.0.0',
    source: 'user',
    state: 'Active',
    enabled: true,
    builtin: false,
    entry: 'index.js',
    tags: [],
    dependencies: {},
    optionalDependencies: {},
    requires: ['ui.panel'],
    permissions: { granted: ['ui.panel'], denied: [] },
    compatibility: { minKernel: '1.0.0', contractVersion: 'contract-1' },
    canUninstall: true,
    canInstall: false,
    restartRequired: false,
    origin: {
      kind: 'remote',
      url: 'https://github.com/owner/repo/releases/tag/v1.0.0',
    },
    ...overrides,
  }
}

function makeList(items: PluginDetailDto[]): PluginListDto {
  return { plugins: items, issues: [], restartRequired: false }
}

function makeInspection(
  overrides: Partial<PluginRemoteInspectionDto> = {},
): PluginRemoteInspectionDto {
  return {
    url: REMOTE_URL,
    downloadUrl:
      'https://github.com/owner/repo/releases/download/v2.0.0/pkg.zip',
    id: 'com.example.remote',
    name: 'Remote Example',
    version: '2.0.0',
    requires: ['ui.panel'],
    dependencies: {},
    optionalDependencies: {},
    compatibility: { minKernel: '1.0.0', contractVersion: 'contract-1' },
    sha256: SHA256,
    ...overrides,
  }
}

function makeUpdate(overrides: Partial<PluginUpdateDto> = {}): PluginUpdateDto {
  return {
    pluginId: 'com.example.remote',
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    hasUpdate: true,
    url: REMOTE_URL,
    sha256: SHA256,
    ...overrides,
  }
}

const OPERATION_OK: PluginOperationResultDto = {
  ok: true,
  changed: true,
  restartRequired: false,
  message: 'Plugin installed.',
}

type Handler = (args: unknown) => unknown

interface Invocation {
  method: string
  args: unknown
}

function installBridge(handlers: Record<string, Handler>): Invocation[] {
  const calls: Invocation[] = []
  window.rem2 = {
    invoke: async (method, args) => {
      calls.push({ method, args })
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected invoke: ${method}`)
      return handler(args)
    },
    onEvent: () => () => undefined,
  }
  return calls
}

function bodyButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    element => element.textContent?.trim() === label,
  )
  if (!button) throw new Error(`button "${label}" not found`)
  return button as HTMLButtonElement
}

function clickable(label: string): HTMLElement {
  const element = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find(item => item.textContent?.trim() === label)
  if (!element) throw new Error(`menu item "${label}" not found`)
  return element
}

async function openActions(): Promise<void> {
  const trigger = document.querySelector<HTMLElement>(
    '[aria-label="More actions"]',
  )
  if (!trigger) throw new Error('actions trigger not found')
  await userEvent.click(trigger)
}

async function selectAction(label: string): Promise<void> {
  await openActions()
  await vi.waitFor(() => expect(clickable(label)).toBeTruthy())
  await userEvent.click(clickable(label))
}

function resetStore(): void {
  plugins.items = []
  plugins.selectedId = undefined
  plugins.loading = false
  plugins.loadError = undefined
  plugins.actionError = undefined
  plugins.notice = undefined
  plugins.issues = []
  plugins.restartRequired = false
  plugins.pending = undefined
  plugins.inspection = undefined
  plugins.progress = undefined
  plugins.remoteError = undefined
  plugins.remotePending = undefined
  plugins.cancelling = false
  plugins.updates = []
  plugins.updateError = undefined
}

beforeEach(resetStore)

afterEach(() => {
  cleanup()
  delete window.rem2
})

describe('PluginManager · install confirmation', () => {
  it('installs only after inspecting and approving the declared capabilities', async () => {
    let installed = false
    const calls = installBridge({
      [channels.pluginList]: () =>
        makeList(installed ? [makePlugin({ version: '2.0.0' })] : []),
      [channels.pluginRemoteInspect]: () => makeInspection(),
      [channels.pluginInstallFromRemote]: () => {
        installed = true
        return OPERATION_OK
      },
    })

    const screen = await render(PluginManagerView)
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain('No plugins installed.'),
    )

    await selectAction('Install from URL…')
    const url = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('#remote-url')
      expect(input).toBeTruthy()
      return input!
    })
    await userEvent.fill(url, REMOTE_URL)
    await userEvent.click(bodyButton('Inspect'))

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Package preview'),
    )
    expect(document.body.textContent).toContain('ui.panel')
    expect(bodyButton('Approve capabilities & install').disabled).toBe(false)

    await userEvent.click(bodyButton('Approve capabilities & install'))

    const installCall = await vi.waitFor(() => {
      const call = calls.find(
        entry => entry.method === channels.pluginInstallFromRemote,
      )
      expect(call).toBeTruthy()
      return call!
    })
    expect(installCall.args).toMatchObject({
      url: REMOTE_URL,
      sha256: SHA256,
      capabilities: ['ui.panel'],
    })
    expect(
      calls.filter(entry => entry.method === channels.pluginRemoteInspect),
    ).toHaveLength(1)

    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain('Package preview'),
    )
    expect(plugins.inspection).toBeUndefined()
  })

  it('blocks installation when the release publishes no digest', async () => {
    installBridge({
      [channels.pluginList]: () => makeList([]),
      [channels.pluginRemoteInspect]: () =>
        makeInspection({ sha256: undefined }),
    })

    await render(PluginManagerView)
    await selectAction('Install from URL…')
    const url = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('#remote-url')
      expect(input).toBeTruthy()
      return input!
    })
    await userEvent.fill(url, REMOTE_URL)
    await userEvent.click(bodyButton('Inspect'))

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Package preview'),
    )
    expect(document.body.textContent).toContain(
      'The publisher did not provide a SHA-256 digest',
    )
    expect(bodyButton('Approve capabilities & install').disabled).toBe(true)
  })
})

describe('PluginManager · update confirmation', () => {
  it('applies the update only after the user confirms the pending version', async () => {
    const installed = makePlugin()
    const calls = installBridge({
      [channels.pluginList]: () => makeList([installed]),
      [channels.pluginUpdateCheck]: (): PluginUpdateCheckDto => ({
        updates: [makeUpdate()],
        issues: [],
      }),
      [channels.pluginUpdateInstall]: () => OPERATION_OK,
    })

    const screen = await render(PluginManagerView)
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain('Remote Example'),
    )

    await selectAction('Check for updates')
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Plugin updates'),
    )

    await vi.waitFor(() => expect(bodyButton('Update')).toBeTruthy())
    await userEvent.click(bodyButton('Update'))

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Update plugin'),
    )
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('1.0.0')
    expect(dialogText).toContain('2.0.0')
    expect(bodyButton('Confirm update').disabled).toBe(false)

    await userEvent.click(bodyButton('Confirm update'))

    const updateCall = await vi.waitFor(() => {
      const call = calls.find(
        entry => entry.method === channels.pluginUpdateInstall,
      )
      expect(call).toBeTruthy()
      return call!
    })
    expect(updateCall.args).toMatchObject({
      pluginId: installed.id,
      expectedVersion: '2.0.0',
      expectedSha256: SHA256,
    })
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain('Confirm update'),
    )
    expect(plugins.updates).toEqual([])
  })

  it('disables confirmation when the checked release has no digest', async () => {
    installBridge({
      [channels.pluginList]: () => makeList([makePlugin()]),
      [channels.pluginUpdateCheck]: () => ({
        updates: [makeUpdate({ sha256: undefined })],
        issues: [],
      }),
      [channels.pluginUpdateInstall]: () => OPERATION_OK,
    })

    await render(PluginManagerView)
    await selectAction('Check for updates')
    await vi.waitFor(() => expect(bodyButton('Update')).toBeTruthy())
    await userEvent.click(bodyButton('Update'))

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Update plugin'),
    )
    expect(document.body.textContent).toContain(
      'Not published — update blocked',
    )
    expect(bodyButton('Confirm update').disabled).toBe(true)
  })
})
