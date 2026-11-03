import type { Component, Snippet } from 'svelte'

import { createRawSnippet } from 'svelte'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'

import type { BadgeTone } from '@/frontend/lib/ui/types'

import Badge from '@/frontend/lib/ui/Badge.svelte'

/**
 * `src/declarations.d.ts` types every `*.svelte` import as
 * `Component<Record<string, never>>` (tsc cannot read Svelte sources), so the
 * real prop surface has to be asserted here before it can be passed.
 */
const BadgeComponent = Badge as unknown as Component<{
  tone?: BadgeTone
  class?: string
  children?: Snippet
}>

function text(value: string): Snippet {
  return createRawSnippet(() => ({ render: () => `<span>${value}</span>` }))
}

function badgeClass(container: HTMLElement): string {
  return container.querySelector('.badge')?.className ?? ''
}

describe('Badge', () => {
  it('renders its children', async () => {
    const screen = await render(BadgeComponent, { children: text('active') })

    expect(screen.container.textContent).toContain('active')
  })

  it('renders without children', async () => {
    const screen = await render(BadgeComponent, {})

    expect(badgeClass(screen.container)).toContain('badge')
    expect(screen.container.textContent?.trim()).toBe('')
  })

  it('applies the class of the given tone', async () => {
    const screen = await render(BadgeComponent, {
      tone: 'success',
      children: text('ok'),
    })

    expect(badgeClass(screen.container)).toContain('preset-tonal-success')
  })

  it('falls back to the neutral tone', async () => {
    const screen = await render(BadgeComponent, { children: text('x') })

    expect(badgeClass(screen.container)).toContain('preset-tonal')
    expect(badgeClass(screen.container)).not.toContain('preset-tonal-success')
  })

  it('keeps a caller-supplied class alongside the tone class', async () => {
    const screen = await render(BadgeComponent, {
      tone: 'error',
      class: 'ml-2',
      children: text('x'),
    })

    const classes = badgeClass(screen.container)
    expect(classes).toContain('preset-tonal-error')
    expect(classes).toContain('ml-2')
  })
})
