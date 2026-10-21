/**
 * Contract tests: zero third-party runtime dependencies in the kernel and
 * one-way dependency direction.
 *
 * Cases:
 * - R1 zero third-party: every import under `src/kernel/**` + `src/host/**`
 *   (excluding `host/electron/**`) must be `node:*` or a relative path.
 * - R2 no reverse dependency: `src/kernel/**` must not import `host` /
 *   `frontend` / `plugins`.
 * - R5 `dependencies` is empty.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')

/** Allowed node built-in module prefixes. */
const ALLOWED_NODE_BUILTINS = [
  'node:path',
  'node:fs',
  'node:fs/promises',
  'node:events',
  'node:worker_threads',
  'node:url',
  'node:process',
  'node:os',
  'node:module',
  'node:assert',
  'node:http',
  'node:net',
  'node:stream',
  'node:crypto',
  'node:util',
]

/**
 * Recursively collect `.ts` files under a directory.
 *
 * Note: this deliberately does not use "does the name contain a dot" to decide
 * whether to recurse into a subdirectory; that check would silently skip any
 * directory whose name contains a dot (e.g. a future `v1.0/`), so the scan
 * would find no files and pass silently. Only explicit non-source directory
 * names are excluded.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.vite',
  'plugins-dist',
])

async function collectTsFiles(dir: string): Promise<string[]> {
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
    if (entry.endsWith('.ts')) {
      out.push(full)
    } else {
      // Directory (no extension) -> recurse.
      out.push(...(await collectTsFiles(full)))
    }
  }
  return out
}

/**
 * Strip comments and the contents of template literals (templates become
 * empty strings).
 *
 * Why template literals must be stripped: `buildPluginSource()` in
 * `scaffold-plugin.ts` contains a template string that generates plugin
 * source code, including `from 'rem2-kernel'` text, which is string content,
 * not an import. Without stripping, compliant generated code would be
 * misjudged as importing a bare package name.
 *
 * Why single/double-quoted strings must NOT be stripped: import specifiers
 * themselves live inside quotes. Clearing their contents to `''` would make
 * `extractSpecifiers()` return an empty array for every file, silently
 * disabling the whole red line (this really happened: injecting `zod` into
 * `src/kernel/**` still left all tests green).
 */
function stripLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

/** Extract import/export-from specifiers from a file. */
function extractSpecifiers(source: string): string[] {
  const specs: string[] = []
  const code = stripLiterals(source)
  const re =
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (spec) specs.push(spec)
  }
  return specs
}

/** Whether a specifier is allowed (node: built-in or relative path). */
function isAllowed(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return true
  if (spec.startsWith('node:')) {
    return ALLOWED_NODE_BUILTINS.some(
      b => spec === b || spec.startsWith(`${b}/`),
    )
  }
  const bareBuiltins = [
    'path',
    'fs',
    'events',
    'process',
    'os',
    'url',
    'assert',
    'module',
    'http',
    'net',
    'stream',
    'crypto',
    'util',
  ]
  if (bareBuiltins.includes(spec)) return true
  return false
}

/** Collect all .ts under `src/host` except `electron/` (electron may import electron). */
async function collectHostNonElectronFiles(): Promise<string[]> {
  const all = await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'host'))
  return all.filter(
    f =>
      !path
        .relative(PROJECT_ROOT, f)
        .includes(`host${path.sep}electron${path.sep}`),
  )
}

describe('contract · kernel has zero third-party runtime dependencies', () => {
  it('R1 · src/kernel and src/host (except electron) contain no third-party imports', async () => {
    const files = [
      ...(await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'kernel'))),
      ...(await collectHostNonElectronFiles()),
    ]
    // Self-check: the scanned file count must exceed a threshold, otherwise the
    // path is wrong and the red line silently fails.
    expect(files.length).toBeGreaterThan(30)

    const violations: Array<{ file: string; spec: string }> = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        if (!isAllowed(spec)) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec })
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('R5 · package.json dependencies is empty', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
  })
})

describe('contract · dependency direction is one-way', () => {
  it('R2 · src/kernel must not reverse-depend on host / frontend / plugins', async () => {
    const files = await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'kernel'))
    expect(files.length).toBeGreaterThan(30)

    const FORBIDDEN = ['/host/', '/frontend/', '/plugins/']
    const violations: Array<{ file: string; spec: string }> = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        const normalized = `/${spec.replace(/\\/g, '/')}/`
        // Only cross-top-level-directory references (`../host/...`); same-level `./x.js` is unaffected.
        if (
          spec.startsWith('.') &&
          FORBIDDEN.some(f => normalized.includes(f))
        ) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec })
        }
      }
    }

    expect(violations).toEqual([])
  })
})

/**
 * Meta-test: self-check of the extractor's effectiveness.
 *
 * Why this group is required: R1/R2 assert "violations is empty", which also
 * holds when the extractor always returns an empty array, so the red line
 * would silently fail (this really happened: `stripLiterals()` cleared quoted
 * strings to `''`, so injecting `zod` into `src/kernel/**` still left all
 * tests green).
 *
 * So instead of asserting "the source has no violations", these tests assert
 * that the extractor actually extracts specifiers from a known input. If the
 * extractor breaks, this group fails immediately and the red line cannot fail
 * silently again.
 */
describe('contract · extractor self-check (meta-test)', () => {
  it('extractSpecifiers extracts import ... from specifiers', () => {
    expect(extractSpecifiers("import x from 'zod';")).toEqual(['zod'])
    expect(extractSpecifiers('import x from "zod";')).toEqual(['zod'])
  })

  it('covers type-only / side-effect / dynamic import / export-from forms', () => {
    expect(extractSpecifiers("import type { A } from './a.js';")).toEqual([
      './a.js',
    ])
    expect(extractSpecifiers("import './side-effect.js';")).toEqual([
      './side-effect.js',
    ])
    expect(extractSpecifiers("const m = await import('node:path');")).toEqual([
      'node:path',
    ])
    expect(extractSpecifiers("export { a } from './a.js';")).toEqual(['./a.js'])
  })

  it('strips comments and template literals but not quoted strings', () => {
    const source = [
      "// import a from 'zod';",
      "/* import b from 'zod'; */",
      "const t = `import c from 'zod';`;",
      "import d from 'zod';",
    ].join('\n')
    // Only the real one should be seen
    expect(extractSpecifiers(source)).toEqual(['zod'])
  })

  it('isAllowed identifies legal and illegal specifiers', () => {
    for (const ok of ['node:path', './a.js', '../b.js', 'node:fs/promises']) {
      expect(isAllowed(ok)).toBe(true)
    }
    for (const bad of ['zod', 'svelte', 'rem2-kernel', 'electron']) {
      expect(isAllowed(bad)).toBe(false)
    }
  })
})
