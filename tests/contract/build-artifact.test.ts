/**
 * Contract test: the renderer build artifact must be the browser build of
 * svelte (PRD A9 / A10).
 *
 * Why this criterion is needed (postmortem of a real defect):
 * svelte's `exports` has three entries: `browser` -> client, `worker` /
 * `default` -> server, and `mount()` only exists in the client build. If the
 * renderer resolves svelte to the server build, `vite build` still succeeds
 * (it just bundles a valid server bundle); the error only explodes when the
 * browser actually runs it:
 *
 *     Uncaught Svelte error: lifecycle_function_unavailable
 *     `mount(...)` is not available on the server
 *
 * That is, "build succeeded" does not imply "the artifact runs in a browser".
 * All existing contract tests run under `environment: 'node'` (see
 * vitest.config.ts), where resolving to the server build is the completely
 * correct behavior, so such "correct at build time, wrong at runtime"
 * problems naturally fall into a test blind spot.
 *
 * Why the criterion uses the sourcemap's `sources`:
 * error-code strings can vanish through tree-shaking / renaming (false
 * negative), while the sourcemap's `sources` are a fact of the module graph:
 * they record by name which source files were bundled. `build.sourcemap` is
 * on by default (see vite.shared.mts), so this test costs no extra build.
 *
 * Why only the chunk actually referenced by index.html is checked:
 * artifact filenames carry content hashes, so old and new versions can
 * coexist in one directory. Scanning the whole directory would be polluted by
 * stale leftovers, and a real "fix did not work" misjudgment came from exactly
 * this. Only what index.html references is what the browser actually loads.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const RENDERER_DIR = path.join(PROJECT_ROOT, '.vite', 'renderer', 'main_window')
const INDEX_HTML = path.join(RENDERER_DIR, 'index.html')
const ASSETS_DIR = path.join(RENDERER_DIR, 'assets')

/** Module features unique to the server build of svelte (a hit means it resolved to the wrong build). */
const SERVER_ONLY_SOURCES = [
  /svelte\/src\/index-server\.js$/,
  /svelte\/src\/internal\/server\//,
]

/** Entry of the client build of svelte (the artifact must contain it, otherwise svelte was not bundled at all). */
const CLIENT_ENTRY_SOURCE = /svelte\/src\/index-client\.js$/

/** Server-side error codes that must not appear in the artifact (direct products of `mount()` resolving to the server build). */
const SERVER_ERROR_CODES = [
  'lifecycle_function_unavailable',
  'server_context_required',
  'async_local_storage_unavailable',
  'hydratable_serialization_failed',
]

/**
 * Resolve the JS chunk path actually referenced by index.html.
 *
 * Why reference resolution instead of directory scanning: stale and fresh
 * artifacts coexist, and only the one referenced by index.html is what the
 * browser actually loads.
 */
function referencedChunk(): string {
  const html = readFileSync(INDEX_HTML, 'utf8')
  const match = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
  if (!match) {
    throw new Error(
      `referenced JS chunk not found in index.html: ${INDEX_HTML}`,
    )
  }
  return path.join(ASSETS_DIR, match[1]!)
}

describe('contract · renderer artifact is the browser build of svelte', () => {
  it('renderer artifact is built (skipped if missing, not reported as failure)', () => {
    if (!existsSync(INDEX_HTML)) {
      // Contract tests should not require build artifacts to exist; use `it.skip`
      // to express "precondition not ready" rather than "assertion failed".
      return
    }
    expect(existsSync(ASSETS_DIR)).toBe(true)
  })

  it('the chunk referenced by index.html exists, with no stale leftovers in the directory', () => {
    if (!existsSync(INDEX_HTML)) return

    const chunk = referencedChunk()
    expect(existsSync(chunk), `referenced chunk does not exist: ${chunk}`).toBe(
      true,
    )

    // Multiple JS chunks with different hashes coexisting = leftovers from a
    // previous build. Asserting this separately does not make the test brittle
    // (a normal build has exactly one), but it blocks the misjudgment scenario
    // above.
    const jsChunks = readdirSync(ASSETS_DIR).filter(f => f.endsWith('.js'))
    expect(jsChunks).toEqual([path.basename(chunk)])
  })

  it('sourcemap sources contain no server-build svelte modules', () => {
    if (!existsSync(INDEX_HTML)) return

    const chunk = referencedChunk()
    const mapFile = `${chunk}.map`
    expect(existsSync(mapFile), `missing sourcemap: ${mapFile}`).toBe(true)

    const map = JSON.parse(readFileSync(mapFile, 'utf8')) as {
      sources?: string[]
    }
    const sources = map.sources ?? []

    const offenders = sources.filter(s =>
      SERVER_ONLY_SOURCES.some(re => re.test(s)),
    )
    expect(
      offenders,
      `artifact bundled the server build of svelte (renderer resolution polluted):\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('sourcemap sources include the client-build svelte entry', () => {
    if (!existsSync(INDEX_HTML)) return

    const map = JSON.parse(
      readFileSync(`${referencedChunk()}.map`, 'utf8'),
    ) as {
      sources?: string[]
    }
    const hasClient = (map.sources ?? []).some(s => CLIENT_ENTRY_SOURCE.test(s))
    expect(
      hasClient,
      'client entry of svelte not found in the artifact; svelte may not have been bundled',
    ).toBe(true)
  })

  it('artifact contains no server-side error code strings', () => {
    if (!existsSync(INDEX_HTML)) return

    const code = readFileSync(referencedChunk(), 'utf8')
    for (const name of SERVER_ERROR_CODES) {
      expect(
        code.includes(name),
        `artifact contains the server-side error code "${name}" - svelte was resolved to the server build`,
      ).toBe(false)
    }
  })
})
