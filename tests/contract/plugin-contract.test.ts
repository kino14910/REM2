/**
 * Contract tests: public interface constraints for plugins and the frontend.
 *
 * Cases:
 * - R4-1 plugins only import from `rem2-kernel` / `node:*` / relative paths.
 * - R4-2 the `rem2-kernel/` prefix is forbidden (deep-linking kernel
 *   internals); with the root tsconfig wildcard removed this is already a
 *   type-level constraint; this is the second line of defense.
 * - R6 frontend stays away from the kernel: `src/frontend/**` must not import
 *   `rem2-kernel` / `src/kernel` / `src/host`.
 * - R7 manifest shape: every plugin.json entry must be a build artifact
 *   (.js or .mjs).
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Topics } from '../../src/kernel/topics.js'
import {
  ALLOWED_EVENTS,
  ALLOWED_EVENT_SET,
  ALLOWED_METHODS,
  ALLOWED_METHOD_SET,
} from '../../src/shared/ipc-contract.js'
import { EVENT_FORWARD_MAP } from '../../src/host/ipc/forward-map.js'
import { collectSourceFiles, extractSpecifiers } from './helpers/source-scan.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')

describe('contract · plugin public interface constraints', () => {
  it('R4-1 · plugins/*/src only imports from rem2-kernel and node:/relative paths', async () => {
    // Scan scope is strictly `plugins/*/src/**`: dist is a build artifact and
    // does not participate in source boundary checks.
    const files: string[] = []
    let pluginDirs: string[] = []
    try {
      pluginDirs = (
        await readdir(path.join(PROJECT_ROOT, 'plugins'), {
          withFileTypes: true,
        })
      )
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch {
      pluginDirs = []
    }
    for (const d of pluginDirs) {
      files.push(
        ...(await collectSourceFiles(
          path.join(PROJECT_ROOT, 'plugins', d, 'src'),
        )),
      )
    }
    expect(files.length).toBeGreaterThan(0)

    const violations: Array<{ file: string; spec: string }> = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        const ok =
          spec === 'rem2-kernel' ||
          spec.startsWith('node:') ||
          spec.startsWith('.') ||
          spec.startsWith('/')
        if (!ok) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec })
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('R4-2 · plugins must not deep-link kernel internals (the rem2-kernel/ prefix is forbidden)', async () => {
    const files: string[] = []
    const pluginDirs = (
      await readdir(path.join(PROJECT_ROOT, 'plugins'), { withFileTypes: true })
    )
      .filter(e => e.isDirectory())
      .map(e => e.name)

    const violations: Array<{ file: string; spec: string }> = []
    for (const d of pluginDirs) {
      files.push(
        ...(await collectSourceFiles(
          path.join(PROJECT_ROOT, 'plugins', d, 'src'),
        )),
      )
    }

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        if (spec.startsWith('rem2-kernel/') || spec.includes('src/kernel')) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec })
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('R7 · plugins/*/plugin.json entry ends with .js or .mjs', async () => {
    const pluginRoot = path.join(PROJECT_ROOT, 'plugins')
    const dirs = (await readdir(pluginRoot, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
    expect(dirs.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const d of dirs) {
      const manifestPath = path.join(pluginRoot, d, 'plugin.json')
      let manifest: { entry?: string }
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          entry?: string
        }
      } catch {
        violations.push(`${d}: plugin.json missing or unparseable`)
        continue
      }
      const entry = manifest.entry ?? ''
      if (!/\.(js|mjs)$/.test(entry)) {
        violations.push(`${d}: entry is not a build artifact → ${entry}`)
      }
    }
    expect(violations).toEqual([])
  })
})

describe('contract · the frontend does not touch the kernel', () => {
  it('R6 · src/frontend must not import rem2-kernel / src/kernel / src/host', async () => {
    const files = await collectSourceFiles(
      path.join(PROJECT_ROOT, 'src', 'frontend'),
    )
    expect(files.length).toBeGreaterThan(5)

    const violations: Array<{ file: string; spec: string }> = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const spec of extractSpecifiers(source)) {
        const normalized = `/${spec.replace(/\\/g, '/')}/`
        if (
          spec === 'rem2-kernel' ||
          spec.startsWith('rem2-kernel/') ||
          normalized.includes('/src/kernel/') ||
          normalized.includes('/src/host/')
        ) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec })
        }
      }
    }
    expect(violations).toEqual([])
  })
})

/**
 * Third criterion: match kernel topic truth values against the IPC allowlist.
 *
 * Why this group must exist (it really failed before): if the allowlist in
 * `shared/ipc-contract.ts` and the forward map / host implementation table are
 * each hand-copied, comparing them pairwise only proves "they are identical",
 * not "they are correct": changing both wrongly still leaves tests green.
 * Once the allowlist converged to a single source, copy/omit errors are caught
 * by types (missing key = compile error); what remains here is what types
 * cannot catch: key-set equality, topics are `Topics` truth values, no
 * duplicates.
 */
describe('contract · kernel topics match the IPC allowlist', () => {
  it('ALLOWED_METHODS and ALLOWED_METHOD_SET agree with no duplicates', () => {
    expect(ALLOWED_METHOD_SET.size).toBe(ALLOWED_METHODS.length)
    expect(new Set(ALLOWED_METHODS).size).toBe(ALLOWED_METHODS.length)
  })

  it('ALLOWED_EVENTS and ALLOWED_EVENT_SET agree with no duplicates', () => {
    expect(ALLOWED_EVENT_SET.size).toBe(ALLOWED_EVENTS.length)
    expect(new Set(ALLOWED_EVENTS).size).toBe(ALLOWED_EVENTS.length)
  })

  it('the command method name must equal the kernel Topics.CommandExecute value', () => {
    // This is the criterion for the command.execute self-recursion defect: the
    // bridge uses the allowlist name to request; if it differs from the kernel
    // topic, the call gets "no responder" or (worse) recurses into itself.
    expect(ALLOWED_METHOD_SET.has(Topics.CommandExecute)).toBe(true)
  })

  it('every topic in EVENT_FORWARD_MAP is a Topics value', () => {
    const known = new Set<string>(Object.values(Topics))
    for (const f of Object.values(EVENT_FORWARD_MAP)) {
      expect(
        known.has(f.topic),
        `forward-map topic "${f.topic}" is not a Topics value (hand-copied strings drift)`,
      ).toBe(true)
    }
  })

  it('the EVENT_FORWARD_MAP key set matches ALLOWED_EVENTS exactly (no more, no less)', () => {
    // The forward map's keys are the external event names (`Record<AllowedEvent, ...>`),
    // so a missing event shows up as a missing key (compile error); runtime
    // consistency is asserted again here.
    const mapped = Object.keys(EVENT_FORWARD_MAP).toSorted()
    expect(mapped).toEqual([...ALLOWED_EVENTS].toSorted())
  })

  it('EVENT_FORWARD_MAP has no duplicate topics', () => {
    const topics = Object.values(EVENT_FORWARD_MAP).map(f => f.topic)
    expect(new Set(topics).size).toBe(topics.length)
  })
})
