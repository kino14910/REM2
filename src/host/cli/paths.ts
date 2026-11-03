/**
 * Runtime path resolution (shared by CLI bootstrap and the Electron shell).
 *
 * Both runtime forms are native ESM:
 * 1. Electron main bundle: `import.meta.url` points at `.vite/build/main.mjs`.
 * 2. CLI (`tsx` / compiled kernel): `import.meta.url` points at the executing module.
 *
 * The old `__dirname` fallback was removed together with the CJS main bundle. Keep
 * the module-directory calculation centralized here instead of scattering
 * `import.meta.url` handling across host modules.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Directory of the current module.
 *
 * Under the bundled Electron main process this resolves to `.vite/build`, which is
 * where `preload.cjs` and the sibling `renderer/` output live.
 */
export function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url))
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

  anchors.push(moduleDirectory())
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
