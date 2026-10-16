/**
 * 主题 token → CSS 变量映射（纯函数，便于单测）。
 *
 * 注入方式：`document.documentElement.style.setProperty(k, v)`。
 * 这是 **CSSOM 写入**，不受 CSP `style-src` 约束（docs/04 §6.4）——
 * 所以主题切换不需要放宽 CSP，也不需要 `unsafe-eval`。
 */

import type { ThemeDto } from '../bridge-types.js';

const COLOR_KEYS = [
  'background',
  'surface',
  'text',
  'textMuted',
  'accent',
  'border',
] as const;

const FONT_KEYS = ['ui', 'mono'] as const;

const SPACING_KEYS = ['xs', 'sm', 'md', 'lg'] as const;

/** `textMuted` → `text-muted`（CSS 变量名用 kebab-case）。 */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** ThemeDto → CSS 变量名值对。缺失的键不产出（`global.css` 里有 fallback）。 */
export function themeToCssVars(theme: ThemeDto): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of COLOR_KEYS) {
    const v = theme.colors[k];
    if (v !== undefined) out.push([`--rem2-color-${kebab(k)}`, v]);
  }
  for (const k of FONT_KEYS) {
    const v = theme.fonts[k];
    if (v !== undefined) out.push([`--rem2-font-${k}`, v]);
  }
  for (const k of SPACING_KEYS) {
    const v = theme.spacing[k];
    if (v !== undefined) out.push([`--rem2-space-${k}`, v]);
  }
  return out;
}

/** 把主题写入 `:root`。 */
export function applyTheme(theme: ThemeDto): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [name, value] of themeToCssVars(theme)) {
    root.style.setProperty(name, value);
  }
}
