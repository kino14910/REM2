import type { Component } from 'svelte'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-svelte'
import { userEvent } from 'vitest/browser'

import type { ProxySettingsDto } from '@/shared/ipc-contract'

import SettingsView from '@/frontend/app/components/SettingsView.svelte'
import { appSettings } from '@/frontend/lib/stores/settings.svelte'
import { channels } from '@/shared/ipc-contract'

const SettingsViewComponent = SettingsView as Component<Record<string, never>>

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

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll('button')].find(
    candidate => candidate.textContent?.trim() === label,
  )
  if (!element) throw new Error(`button "${label}" not found`)
  return element as HTMLButtonElement
}

function select(): HTMLSelectElement {
  const element = document.querySelector<HTMLSelectElement>('#proxy-mode')
  if (!element) throw new Error('proxy mode select not found')
  return element
}

function addressField(): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>('#proxy-address')
  if (!element) throw new Error('proxy address field not found')
  return element
}

function saveCall(calls: Invocation[]): Invocation {
  const call = calls.find(entry => entry.method === channels.settingsProxySet)
  if (!call) throw new Error('settingsProxySet was not invoked')
  return call
}

function resetStore(): void {
  appSettings.proxy = { mode: 'system' }
  appSettings.loading = false
  appSettings.saving = false
  appSettings.error = undefined
  appSettings.notice = undefined
}

beforeEach(resetStore)

afterEach(() => {
  cleanup()
  delete window.rem2
})

describe('SettingsView · proxy validation', () => {
  it('reveals manual fields only for manual mode and gates Save on a non-empty address', async () => {
    installBridge({
      [channels.settingsProxyGet]: (): ProxySettingsDto => ({
        mode: 'system',
      }),
    })

    const screen = await render(SettingsViewComponent)
    await vi.waitFor(() => expect(select().value).toBe('system'))
    await vi.waitFor(() => expect(button('Save').disabled).toBe(false))
    expect(document.querySelector('#proxy-address')).toBeNull()

    await userEvent.selectOptions(select(), 'manual')
    await vi.waitFor(() =>
      expect(document.querySelector('#proxy-address')).not.toBeNull(),
    )

    // Empty and whitespace-only addresses are not valid manual proxies.
    expect(button('Save').disabled).toBe(true)
    await userEvent.fill(addressField(), '   ')
    expect(button('Save').disabled).toBe(true)

    await userEvent.fill(addressField(), 'http://127.0.0.1:7890')
    expect(button('Save').disabled).toBe(false)
    expect(screen.container.textContent).toContain('Proxy address')
  })

  it('sends the trimmed manual address and optional bypass list', async () => {
    const calls = installBridge({
      [channels.settingsProxyGet]: (): ProxySettingsDto => ({
        mode: 'system',
      }),
      [channels.settingsProxySet]: (args): ProxySettingsDto => ({
        ...(args as ProxySettingsDto),
      }),
    })

    await render(SettingsViewComponent)
    await vi.waitFor(() => expect(select().value).toBe('system'))

    await userEvent.selectOptions(select(), 'manual')
    await userEvent.fill(addressField(), '  http://127.0.0.1:7890  ')
    const bypass = await vi.waitFor(() => {
      const field = document.querySelector<HTMLInputElement>('#proxy-bypass')
      expect(field).toBeTruthy()
      return field!
    })
    await userEvent.fill(bypass, '  localhost,127.0.0.1  ')
    await vi.waitFor(() => expect(button('Save').disabled).toBe(false))

    await userEvent.click(button('Save'))

    const call = await vi.waitFor(() => saveCall(calls))
    expect(call.args).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
      bypass: 'localhost,127.0.0.1',
    })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Proxy settings applied.'),
    )
  })

  it('omits address and bypass for non-manual modes', async () => {
    const calls = installBridge({
      [channels.settingsProxyGet]: (): ProxySettingsDto => ({
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
      }),
      [channels.settingsProxySet]: (): ProxySettingsDto => ({ mode: 'direct' }),
    })

    await render(SettingsViewComponent)
    await vi.waitFor(() => expect(select().value).toBe('manual'))

    await userEvent.selectOptions(select(), 'direct')
    await vi.waitFor(() =>
      expect(document.querySelector('#proxy-address')).toBeNull(),
    )
    await vi.waitFor(() => expect(button('Save').disabled).toBe(false))
    await userEvent.click(button('Save'))

    const call = await vi.waitFor(() => saveCall(calls))
    expect(call.args).toEqual({ mode: 'direct' })
  })

  it('prefills manual fields and the resolved diagnostic from the host', async () => {
    installBridge({
      [channels.settingsProxyGet]: (): ProxySettingsDto => ({
        mode: 'manual',
        address: 'http://10.0.0.1:8080',
        bypass: 'localhost',
        resolved: 'PROXY 10.0.0.1:8080',
      }),
    })

    await render(SettingsViewComponent)
    await vi.waitFor(() => expect(select().value).toBe('manual'))
    await vi.waitFor(() =>
      expect(addressField().value).toBe('http://10.0.0.1:8080'),
    )
    expect(
      document.querySelector<HTMLInputElement>('#proxy-bypass')?.value,
    ).toBe('localhost')
    expect(document.body.textContent).toContain('PROXY 10.0.0.1:8080')
  })

  it('surfaces a host rejection with its stable error code', async () => {
    installBridge({
      [channels.settingsProxyGet]: (): ProxySettingsDto => ({
        mode: 'system',
      }),
      [channels.settingsProxySet]: () => {
        throw Object.assign(new Error('write failed'), {
          code: 'E_SETTINGS_WRITE',
        })
      },
    })

    await render(SettingsViewComponent)
    await vi.waitFor(() => expect(select().value).toBe('system'))

    await userEvent.selectOptions(select(), 'manual')
    await vi.waitFor(() =>
      expect(document.querySelector('#proxy-address')).not.toBeNull(),
    )
    await userEvent.fill(addressField(), 'http://127.0.0.1:7890')
    await vi.waitFor(() => expect(button('Save').disabled).toBe(false))
    await userEvent.click(button('Save'))

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'The proxy settings could not be saved. (E_SETTINGS_WRITE)',
      ),
    )
    expect(appSettings.notice).toBeUndefined()
  })
})
