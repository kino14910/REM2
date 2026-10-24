/**
 * Runtime path resolution (shared by CLI bootstrap and the Electron shell).
 *
 * Must support three runtime forms:
 * 1. ESM (`tsx` / native ESM): `import.meta.url` is available.
 * 2. CJS bundle (Electron main process, Vite/Rollup output
 *    `.vite/build/main.cjs`): `import.meta.url` compiles to `undefined`,
 *    so fall back to `__dirname`.
 * 3. Last resort: `process.cwd()`.
 *
 * Historical bug: an early implementation used
 * `fileURLToPath(import.meta.url)` as a default parameter; in the Electron
 * main process `import.meta.url === undefined`, so `fileURLToPath(undefined)`
 * threw `ERR_INVALID_ARG_TYPE` and the shell crashed on startup.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** Module directory in CJS (undefined in ESM). */
declare const __dirname: string | undefined

/**
 * Directory of the current module (ESM / CJS compatible).
 *
 * Every step must null-check before use: never pass `undefined` to
 * `fileURLToPath`.
 */
function moduleDir(): string | undefined {
  // 1) CJS bundle: taken by the Electron main process.
  //    The `typeof` check is equally safe under ESM (yields 'undefined' rather than throwing).
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    return __dirname
  }

  // 2) ESM: `import.meta.url`; compiled to undefined in CJS output.
  const metaUrl = (import.meta as { url?: string }).url
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      return path.dirname(fileURLToPath(metaUrl))
    } catch {
      // Invalid URL → fall through to the next strategy.
    }
  }

  return undefined
}

function findUp(start: string): string | undefined {
  let dir = path.resolve(start)
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Project root directory (the directory containing package.json).
 *
 * @param fromFile Optional explicit anchor file; when omitted, walks up from
 * the module directory, then from cwd.
 */
export function projectRoot(fromFile?: string): string {
  const anchors: string[] = []
  if (fromFile) anchors.push(path.dirname(fromFile))

  const dir = moduleDir()
  if (dir) anchors.push(dir)

  anchors.push(process.cwd())

  for (const anchor of anchors) {
    const found = findUp(anchor)
    if (found) return found
  }
  return process.cwd()
}

/**
 * Built-in plugins root directory.
 *
 * Points at `plugins-dist/` (the aggregated build-output directory), not
 * `plugins/`: the `entry` in `plugin.json` now refers exclusively to
 * `dist/index.js` (single canonical form), and `dist/index.js` exists only
 * in build output. If it pointed at `plugins/`, the kernel would look for
 * `plugins/<id>/dist/index.js`, which does not exist in development
 * (sources live in `src/`) — every plugin would then fail, and the reported
 * error ("module resolution failed") would be far from the real cause
 * (a wrong root directory).
 *
 * Priority: `plugins-dist/` (already built) > `plugins/` (unbuilt, handy for
 * manually debugging source directories).
 *
 * Packaged layout: forge's `extraResource` lands `plugins-dist` as a SIBLING
 * of the app directory (`resources/plugins-dist` next to
 * `resources/app.asar`), never inside it, so the packaged root cannot resolve
 * `<root>/plugins-dist`. Without the sibling candidate the packaged app would
 * discover an empty plugin set (no theme, no commands, no inspector panel)
 * and degrade silently - the exact blank spot docs 01 §11 recorded.
 */
export function builtinPluginsRoot(root = projectRoot()): string {
  const dist = path.join(root, 'plugins-dist')
  if (existsSync(dist)) return dist
  // Packaged layout: extraResource lands plugins-dist as a SIBLING of the app
  // directory (resources/plugins-dist next to resources/app.asar), never inside
  // it - the app root's own plugins-dist only exists in the repository.
  const packaged = path.resolve(root, '..', 'plugins-dist')
  if (existsSync(packaged)) return packaged
  return path.join(root, 'plugins')
}
