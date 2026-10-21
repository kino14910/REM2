/**
 * Source-scanning helpers for contract tests (shared by
 * `plugin-contract.test.ts` and `ipc-contract.test.ts`).
 *
 * Why extracted: the stripping rules themselves are tricky (see the
 * `stripLiterals` comment); duplicating them means duplicating criteria that
 * can fail silently.
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'

/** Directories skipped while scanning. */
export const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.vite',
  'plugins-dist',
])

/** Recursively collect `.ts` / `.svelte` files. */
export async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    if (entry.endsWith('.ts') || entry.endsWith('.svelte')) {
      out.push(full)
    } else {
      out.push(...(await collectSourceFiles(full)))
    }
  }
  return out
}

/**
 * Strip comments and the contents of template literals.
 *
 * `.svelte` files often contain template strings (e.g. inline JS examples)
 * where `rem2-kernel` appears as text content, not an import; not stripping
 * them would misjudge R6.
 *
 * Why single/double-quoted strings cannot be stripped: import specifiers live
 * inside quotes, and clearing their contents would make `extractSpecifiers()`
 * return `[]` for every file, silently disabling R4/R6.
 */
export function stripLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

/** Extract import specifiers (including .svelte's from './X.svelte'). */
export function extractSpecifiers(source: string): string[] {
  const specs: string[] = []
  const code = stripLiterals(source)
  const re =
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (spec) specs.push(spec)
  }
  return specs
}

/**
 * Extract string literals appearing in source (excluding comments and
 * template strings).
 *
 * Purpose: determine whether a contract string is defined in exactly one
 * place in the repo. Quotes are required in the match: `health.report?.status`
 * is a store property access, not the method name `'health.report'`.
 */
export function extractStringLiterals(source: string): string[] {
  const code = stripLiterals(source)
  const out: string[] = []
  const re = /'([^'\n]*)'|"([^"\n]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const value = m[1] ?? m[2]
    if (value !== undefined) out.push(value)
  }
  return out
}
