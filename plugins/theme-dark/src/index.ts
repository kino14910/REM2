/**
 * theme-dark plugin -- UI/themes are plugins.
 *
 * Contributes a light/dark pair into the `ui.theme` extension point (a multi slot:
 * the catalog of resident themes). Which one is applied is host UI state, so both
 * token sets must live in the slot for the shell to offer a mode switch; a plugin
 * contributing a single mode simply gives the shell nothing to switch to.
 *
 * The kernel has no concept of "color" at all; the frontend maps tokens to CSS
 * variables and uses `mode` for `color-scheme`.
 */

import { definePlugin } from 'rem2-kernel'
import type { PluginContext, ThemeDefinition } from 'rem2-kernel'

const FONTS = {
  ui: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", "Fira Code", monospace',
} as const

const SPACING = { xs: '4px', sm: '8px', md: '16px', lg: '24px' } as const

const DARK_THEME: ThemeDefinition = {
  id: 'dark',
  mode: 'dark',
  colors: {
    background: '#0f1115',
    surface: '#161922',
    text: '#e6e6e6',
    textMuted: '#9aa4b2',
    accent: '#4f9cf9',
    border: '#232838',
  },
  fonts: FONTS,
  spacing: SPACING,
}

const LIGHT_THEME: ThemeDefinition = {
  id: 'light',
  mode: 'light',
  colors: {
    background: '#f5f6f8',
    surface: '#ffffff',
    text: '#1b1f27',
    textMuted: '#5b6472',
    accent: '#2563eb',
    border: '#d9dee7',
  },
  fonts: FONTS,
  spacing: SPACING,
}

/** Dark first: it is the shell's default and matches the CSS fallbacks in `global.css`. */
const THEMES: readonly ThemeDefinition[] = [DARK_THEME, LIGHT_THEME]

export default definePlugin(
  { id: 'com.rem2.theme-dark', name: 'Light + Dark Themes', version: '1.0.0' },
  (ctx: PluginContext) => {
    let contributed = 0

    return {
      async onStart(): Promise<void> {
        for (const theme of THEMES) {
          // contributionId = theme.id: the kernel's multi-slot duplicate check is what
          // stops two themes from claiming the same id, no extra bookkeeping needed.
          ctx.extensions.contribute<ThemeDefinition>('ui.theme', {
            contributionId: theme.id,
            impl: theme,
          })
          contributed += 1
        }
        ctx.log.info(
          `Themes contributed (ui.theme): ${THEMES.map(t => t.id).join(', ')}`,
        )
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        // The kernel force-reclaims contributions at unload time by pluginId.
        contributed = 0
        hookCtx.log.info(`Themes deactivated (${reason})`)
      },

      onHealthCheck(): 'healthy' | 'degraded' {
        return contributed === THEMES.length ? 'healthy' : 'degraded'
      },

      /** Contributed themes (for tests). */
      getThemes(): readonly ThemeDefinition[] {
        return contributed === THEMES.length ? THEMES : []
      },
    }
  },
)
