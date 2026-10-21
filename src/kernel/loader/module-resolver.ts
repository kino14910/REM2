import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { EntryEscapeError } from '../errors.js'

/** Resolution result. */
export interface ResolvedEntry {
  /** Specifier suitable for `import()` (file URL or package name). */
  specifier: string
  /** Resolved absolute path (undefined for package names). */
  filePath?: string
}

/**
 * Resolves manifest.entry into a specifier suitable for dynamic import().
 *
 * - Absolute / relative paths (starting with ./ or ../) resolve to a file URL relative to the plugin rootDir.
 * - "Path-style" entries such as `dist/index.js` (containing `/` or a known extension) are handled the same way.
 * - Remaining bare package names are returned as-is (left to Node's resolution).
 * - Extensionless entries are completed in [.js, .mjs, .cjs, index.js, index.mjs] order (never .ts).
 *
 * Security boundary (E_ENTRY_ESCAPE): after resolution, a path-style entry must
 * still point inside rootDir, and absolute paths must also target inside rootDir.
 * Otherwise a plugin could use its manifest to make the kernel import arbitrary disk files.
 */
export function resolveEntry(
  rootDir: string,
  entry: string,
  pluginId = entry,
): ResolvedEntry {
  const isRelative = entry.startsWith('./') || entry.startsWith('../')
  const isAbsolute = path.isAbsolute(entry)
  const isFileUrl = entry.startsWith('file:')
  const looksLikePath = looksLikeFilePath(entry)

  if (!isRelative && !isAbsolute && !isFileUrl && !looksLikePath) {
    // Bare package name
    return { specifier: entry }
  }

  const root = path.resolve(rootDir)
  const base = isAbsolute ? path.resolve(entry) : path.resolve(root, entry)
  assertInsideRoot(root, base, pluginId, entry)

  if (existsSync(base)) {
    return toFileUrl(base)
  }

  // Complete the extension: only build outputs are accepted.
  const candidates = [
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      return toFileUrl(c)
    }
  }

  // If nothing matches, return the original path anyway so import() throws a diagnosable module resolution error.
  return toFileUrl(base)
}

/** Asserts the resolved path stays inside the plugin root directory. */
function assertInsideRoot(
  root: string,
  target: string,
  pluginId: string,
  entry: string,
): void {
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new EntryEscapeError(pluginId, entry)
  }
}

/**
 * Determines whether an entry is a "path-style" specifier.
 *
 * Path-style: contains a path separator (`/` or `\`), or ends with a known script extension.
 * Counter-examples: `lodash` / `@scope/pkg` (bare package names, resolved by Node).
 *
 * The `.ts` check is deliberately kept: it does not mean TS entries are allowed,
 * but routes illegal entries such as `dist/index.ts` through path resolution so
 * they are rejected during manifest validation (instead of being mistaken for
 * bare package names).
 */
function looksLikeFilePath(entry: string): boolean {
  if (entry.includes('/') || entry.includes('\\')) return true
  return /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/i.test(entry)
}

function toFileUrl(filePath: string): ResolvedEntry {
  return { specifier: pathToFileURL(filePath).href, filePath }
}

/** Normalizes a plugin root directory path (trailing separators removed). */
export function normalizeRoot(rootDir: string): string {
  return path.resolve(rootDir)
}
