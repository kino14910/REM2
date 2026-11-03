/**
 * Theme bridge between the host `ThemeDefinition` and the Skeleton design system.
 *
 * The renderer is driven by two independent theme dimensions:
 *   - palette: `data-theme` on `<html>` selects the registered Skeleton theme.
 *   - mode: `data-mode` / `color-scheme` selects light or dark.
 *
 * Values are injected with `document.documentElement.style.setProperty`, a
 * CSSOM write that is not subject to the CSP `style-src` restriction, so
 * switching themes needs no CSP relaxation or `unsafe-eval`.
 */

import type { ThemeDto } from '@/frontend/lib/bridge-types.js'

import { ipc } from '@/frontend/lib/ipc-client'
import { channels, type ColorModeDto } from '@/shared/ipc-contract'

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

export type ColorMode = ColorModeDto

let requestedMode: ColorMode = 'system'
let listening = false
/**
 * Variables written by the last `applyTheme` call. Removing them before the
 * next theme is what prevents a palette from leaking tokens the new theme does
 * not define (e.g. an accent or font from the previous catalog entry).
 */
let appliedThemeVars = new Set<string>()

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

/** Resolve `system` against the OS preference; explicit modes pass through. */
export function resolveColorMode(mode: ColorMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

/**
 * Push the title bar's resolved colors to the host.
 *
 * The window-controls overlay (Windows/Linux) is OS-painted and cannot read the
 * bar's CSS variables. Measuring the rendered bar makes the native buttons follow
 * whatever theme is currently applied - host themes, the local light/dark
 * fallback, and OS light/dark changes alike.
 */
function syncTitleBarColors(): void {
  if (typeof document === 'undefined' || !ipc.available) return
  const bar = document.querySelector<HTMLElement>('[data-titlebar]')
  if (!bar) return
  const style = getComputedStyle(bar)
  const color = toHexColor(style.backgroundColor)
  const symbolColor = toHexColor(style.color)
  if (color === undefined || symbolColor === undefined) return
  void ipc
    .request(channels.titleBarColors, { color, symbolColor })
    .catch(() => {
      // Closing window / no overlay on this host: the bar itself is unaffected.
    })
}

let colorRaster: CanvasRenderingContext2D | null | undefined

/**
 * Serialize any computed CSS color as `#RRGGBBAA`.
 *
 * Electron's `setTitleBarOverlay` only accepts `#RRGGBBAA`, `rgba()` and
 * `hsla()`, while `getComputedStyle` returns the color in its authored space
 * (Skeleton stores tokens in `oklch`), so rasterizing a pixel converts it to
 * sRGB bytes the overlay understands.
 */
function toHexColor(cssColor: string): string | undefined {
  if (colorRaster === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    colorRaster = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (!colorRaster) return undefined
  colorRaster.fillStyle = '#000000'
  colorRaster.fillStyle = cssColor
  colorRaster.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = colorRaster.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b, a].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Apply the light/dark mode.
 *
 * `data-mode` drives the `dark` variant (see `global.css`) and `color-scheme`
 * makes `light-dark()` color pairings resolve to the same branch. Setting both
 * keeps Skeleton tokens and native widgets in sync.
 */
export function applyColorMode(mode: ColorMode): void {
  if (typeof document === 'undefined') return
  requestedMode = mode
  const resolved = resolveColorMode(mode)
  const root = document.documentElement
  root.dataset.mode = resolved
  root.style.colorScheme = resolved
  // Last step: the bar's colors are final only after `data-mode` / `color-scheme`.
  syncTitleBarColors()
}

/**
 * Start following the OS preference until a theme with an explicit mode arrives.
 * The listener is installed once; it only re-applies while `system` is requested.
 */
export function initThemeMode(): void {
  applyColorMode('system')
  if (listening || typeof window === 'undefined') return
  listening = true
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (requestedMode === 'system') applyColorMode('system')
    })
}

/**
 * Apply a theme pushed by the host or selected locally.
 *
 * A `ThemeDefinition` only carries a few semantic colors, so the accent is
 * projected onto the Skeleton brand tokens (the documented accent hook), and
 * the background onto the root background of the theme's own mode. The legacy
 * `--rem2-*` variables are written as well so plugin-authored panel markup
 * keeps working.
 */
export function applyTheme(theme: ThemeDto): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const next = new Map(themeToCssVars(theme))

  const accent = theme.colors.accent
  if (accent !== undefined) {
    next.set('--color-brand-light', accent)
    next.set('--color-brand-dark', accent)
  }

  const background = theme.colors.background
  if (background !== undefined) {
    const resolved = resolveColorMode(theme.mode)
    next.set(
      resolved === 'dark' ? '--color-root-bg-dark' : '--color-root-bg-light',
      background,
    )
  }

  // Retract the previous theme before writing: a partial theme (no accent,
  // no custom font) must fall back to the stylesheet defaults instead of
  // inheriting tokens from the theme it replaced.
  for (const name of appliedThemeVars) {
    if (!next.has(name)) root.style.removeProperty(name)
  }
  for (const [name, value] of next) root.style.setProperty(name, value)
  appliedThemeVars = new Set(next.keys())

  applyColorMode(theme.mode)
}

/** Remove every variable injected by `applyTheme` (e.g. the theme catalog became empty). */
export function clearTheme(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const name of appliedThemeVars) root.style.removeProperty(name)
  appliedThemeVars.clear()
  syncTitleBarColors()
}
