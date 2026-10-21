import path from 'node:path'

/** Derives a reasonable plugin id from the plugin directory path (fallback only; normally read from the manifest). */
export function toPluginIdFromPath(dir: string): string {
  const base = path.basename(dir)
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized.length > 0 ? sanitized : 'unnamed-plugin'
}
