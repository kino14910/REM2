/**
 * Theme tokens mapped to CSS variables.
 *
 * Values are injected with `document.documentElement.style.setProperty`,
 * a CSSOM write that is not subject to the CSP `style-src` restriction,
 * so switching themes needs no CSP relaxation or `unsafe-eval`.
 */

import type { ThemeDto } from '../bridge-types.js'

const COLOR_KEYS = [
  'background',
  'surface',
  'text',
  'textMuted',
  'accent',
  'border',
] as const

const FONT_KEYS = ['ui', 'mono'] as const

const SPACING_KEYS = ['xs', 'sm', 'md', 'lg'] as const

/** `textMuted` -> `text-muted` (CSS variable names are kebab-case). */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
}

/** ThemeDto -> CSS variable name/value pairs. Missing keys produce nothing (fallbacks live in `global.css`). */
export function themeToCssVars(theme: ThemeDto): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const k of COLOR_KEYS) {
    const v = theme.colors[k]
    if (v !== undefined) out.push([`--rem2-color-${kebab(k)}`, v])
  }
  for (const k of FONT_KEYS) {
    const v = theme.fonts[k]
    if (v !== undefined) out.push([`--rem2-font-${k}`, v])
  }
  for (const k of SPACING_KEYS) {
    const v = theme.spacing[k]
    if (v !== undefined) out.push([`--rem2-space-${k}`, v])
  }
  return out
}

export function applyTheme(theme: ThemeDto): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const [name, value] of themeToCssVars(theme)) {
    root.style.setProperty(name, value)
  }
  // Native widgets (scrollbars, inputs, selection) follow the mode, not the palette.
  root.style.setProperty('color-scheme', theme.mode)
}
