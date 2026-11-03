import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ThemeCatalogDto, ThemeDto } from '@/frontend/lib/bridge-types'
import type { Rem2Bridge } from '@/frontend/lib/ipc-client'

import { theme } from '@/frontend/lib/stores/theme.svelte'
import {
  applyTheme,
  clearTheme,
  themeToCssVars,
} from '@/frontend/lib/theme/vars'
import { channels } from '@/shared/ipc-contract'

const DARK: ThemeDto = {
  id: 'dark',
  mode: 'dark',
  colors: { background: '#0f1115', accent: '#4f8cff' },
  fonts: { ui: 'Inter, sans-serif' },
  spacing: { md: '18px' },
}

const LIGHT: ThemeDto = {
  id: 'light',
  mode: 'light',
  colors: { background: '#f5f6f8' },
  fonts: {},
  spacing: {},
}

const CATALOG: ThemeCatalogDto = {
  themes: [DARK, LIGHT],
  activeId: 'dark',
}

const root = document.documentElement

function installBridge(invoke: Rem2Bridge['invoke']): void {
  window.rem2 = { invoke, onEvent: () => () => undefined }
}

beforeEach(() => {
  clearTheme()
  root.removeAttribute('data-mode')
  root.style.colorScheme = ''
  theme.list = []
  theme.activeId = undefined
  theme.colorMode = 'system'
  theme.error = undefined
})

afterEach(() => {
  delete window.rem2
  clearTheme()
})

describe('theme · CSS variable application', () => {
  it('maps tokens to kebab-case CSS variables', () => {
    expect(themeToCssVars(DARK)).toEqual([
      ['--rem2-color-background', '#0f1115'],
      ['--rem2-color-accent', '#4f8cff'],
      ['--rem2-font-ui', 'Inter, sans-serif'],
      ['--rem2-space-md', '18px'],
    ])
  })

  it('applies palette and mode to the document root', () => {
    applyTheme(DARK)

    expect(root.style.getPropertyValue('--rem2-color-background')).toBe(
      '#0f1115',
    )
    expect(root.style.getPropertyValue('--color-brand-dark')).toBe('#4f8cff')
    expect(root.style.getPropertyValue('--color-root-bg-dark')).toBe('#0f1115')
    expect(root.dataset.mode).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
  })

  it('retracts tokens the next theme does not define', () => {
    applyTheme(DARK)
    applyTheme(LIGHT)

    expect(root.style.getPropertyValue('--rem2-color-accent')).toBe('')
    expect(root.style.getPropertyValue('--rem2-font-ui')).toBe('')
    expect(root.style.getPropertyValue('--color-brand-dark')).toBe('')
    expect(root.style.getPropertyValue('--color-root-bg-dark')).toBe('')
    expect(root.style.getPropertyValue('--color-root-bg-light')).toBe('#f5f6f8')
    expect(root.dataset.mode).toBe('light')
  })

  it('clears every injected variable when the catalog disappears', () => {
    theme.applyCatalog(CATALOG)
    expect(root.style.getPropertyValue('--rem2-color-accent')).toBe('#4f8cff')

    theme.applyCatalog({ themes: [], activeId: undefined })

    expect(root.style.getPropertyValue('--rem2-color-accent')).toBe('')
    expect(root.style.getPropertyValue('--rem2-color-background')).toBe('')
    expect(theme.activeId).toBeUndefined()
  })
})

describe('theme · switch and failure recovery', () => {
  it('applies the selected theme and writes the host selection', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    installBridge(invoke)
    theme.applyCatalog(CATALOG)

    await theme.setActive(LIGHT)

    expect(theme.activeId).toBe('light')
    expect(theme.colorMode).toBe('light')
    expect(root.style.getPropertyValue('--rem2-color-background')).toBe(
      '#f5f6f8',
    )
    expect(invoke).toHaveBeenCalledWith(channels.themeSet, { themeId: 'light' })
  })

  it('rolls back when the host answers { ok: false }', async () => {
    installBridge(async () => ({ ok: false }))
    theme.applyCatalog(CATALOG)

    await theme.setActive(LIGHT)

    expect(theme.activeId).toBe('dark')
    expect(theme.colorMode).toBe('dark')
    expect(theme.error).toContain('not accepted')
    expect(root.style.getPropertyValue('--rem2-color-background')).toBe(
      '#0f1115',
    )
    expect(root.dataset.mode).toBe('dark')
  })

  it('rolls back when the IPC request rejects', async () => {
    installBridge(async () => {
      throw new Error('bridge unavailable')
    })
    theme.applyCatalog(CATALOG)

    await theme.setActive(LIGHT)

    expect(theme.activeId).toBe('dark')
    expect(theme.error).toBe('bridge unavailable')
    expect(root.style.getPropertyValue('--rem2-font-ui')).toBe(
      'Inter, sans-serif',
    )
  })

  it('ignores a stale failure after a newer switch succeeded', async () => {
    let rejectFirst: ((error: Error) => void) | undefined
    const invoke = vi
      .fn<Rem2Bridge['invoke']>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockResolvedValueOnce({ ok: true })
    installBridge(invoke)
    theme.applyCatalog(CATALOG)

    const first = theme.setActive(LIGHT)
    await theme.setActive(DARK)
    rejectFirst?.(new Error('late failure'))
    await first

    expect(theme.activeId).toBe('dark')
    expect(theme.error).toBeUndefined()
  })
})
