#!/usr/bin/env node
/**
 * Plugin build: walk every plugin under plugins/, call the esbuild API one by one,
 * aggregate artifacts into plugins-dist/<plugin-name>/.
 *
 * This is build-time code (never enters src/), so it does not violate the
 * kernel-zero-third-party-dependency red line.
 *
 * Why artifacts are aggregated instead of left next to each plugin:
 * forge.config.mts's extraResource needs a clean directory — plugins/ also contains
 * source dirs, tsconfig.json and package.json, which would bloat the package and
 * leak sources into the installer.
 *
 * Usage: node scripts/build-plugins.mjs [--out-dir <dir>]
 */

import { build } from 'esbuild'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..')
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins')

/** esbuild target: Node 20 (aligned with `engines.node: '>=20'`). */
const ESBUILD_TARGET = 'node20'

/** Take `--out-dir` from argv, defaulting to plugins-dist. */
function parseOutDir(argv) {
  const i = argv.indexOf('--out-dir')
  return i >= 0 && argv[i + 1]
    ? path.resolve(PROJECT_ROOT, argv[i + 1])
    : path.join(PROJECT_ROOT, 'plugins-dist')
}

/** Locate a plugin's entry source: prefer plugin.json's entry, fall back to src/index.ts / src/index.mjs. */
async function resolveEntrySource(pluginDir) {
  const manifestPath = path.join(pluginDir, 'plugin.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const entry = typeof manifest.entry === 'string' ? manifest.entry : ''
    // `dist/index.js` -> `src/index.ts` (sources in src, artifacts in dist — that is the entry's semantics).
    const srcCandidate = entry
      .replace(/^dist\//, 'src/')
      .replace(/\.js$/, '.ts')
    if (
      entry.startsWith('dist/') &&
      existsSync(path.join(pluginDir, srcCandidate))
    ) {
      return srcCandidate
    }
    if (entry && existsSync(path.join(pluginDir, entry))) return entry
  }
  for (const candidate of ['src/index.ts', 'src/index.mjs', 'src/index.js']) {
    if (existsSync(path.join(pluginDir, candidate))) return candidate
  }
  return undefined
}

async function main() {
  const outDir = parseOutDir(process.argv.slice(2))
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  let entries
  try {
    entries = (await readdir(PLUGINS_DIR, { withFileTypes: true }))
      .filter(
        e =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          e.name !== 'node_modules',
      )
      .map(e => e.name)
      .sort()
  } catch {
    process.stderr.write(`Plugin directory not found: ${PLUGINS_DIR}\n`)
    process.exitCode = 1
    return
  }

  let built = 0
  const failures = []

  for (const name of entries) {
    const pluginDir = path.join(PLUGINS_DIR, name)
    const source = await resolveEntrySource(pluginDir)
    if (!source) {
      failures.push(`${name}: entry source not found (src/index.ts)`)
      continue
    }

    const outPluginDir = path.join(outDir, name)
    await mkdir(path.join(outPluginDir, 'dist'), { recursive: true })

    try {
      await build({
        entryPoints: [path.join(pluginDir, source)],
        outfile: path.join(outPluginDir, 'dist', 'index.js'),
        bundle: true,
        // ESM: consistent with the kernel's `type: module` and the `.js` shape of entry.
        format: 'esm',
        platform: 'node',
        target: ESBUILD_TARGET,
        // node:* stays external; plugins must not pull third-party deps (contract test R4
        // enforces it), so there is deliberately NO external allowlist here — if a plugin
        // really imported a third-party package, the contract layer should reject it first.
        sourcemap: true,
        logLevel: 'silent',
      })

      // plugin.json ships with the artifact: the kernel reads manifests from plugin dirs,
      // without it the plugin is undiscoverable.
      await cp(
        path.join(pluginDir, 'plugin.json'),
        path.join(outPluginDir, 'plugin.json'),
      )

      // A minimal package.json so Node resolves the artifact as ESM (type: module).
      await writeFile(
        path.join(outPluginDir, 'package.json'),
        `${JSON.stringify({ name: `rem2-plugin-${name}`, private: true, type: 'module', main: './dist/index.js' }, null, 2)}\n`,
        'utf8',
      )

      built += 1
      process.stdout.write(
        `  ✓ ${name} → ${path.relative(PROJECT_ROOT, outPluginDir)}\n`,
      )
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
    }
  }

  process.stdout.write(`Plugin build complete: ${built}/${entries.length}\n`)
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  ✗ ${f}\n`)
    process.exitCode = 1
  }
}

await main()
