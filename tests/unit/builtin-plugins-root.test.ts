/**
 * Unit test: builtinPluginsRoot layout resolution.
 *
 * Covers the packaged-layout defect: forge's `extraResource` lands
 * `plugins-dist` as a sibling of the app directory
 * (`resources/plugins-dist` next to `resources/app.asar`), so a packaged
 * root must fall back to the sibling candidate. Without it the packaged app
 * discovers an empty plugin set and degrades silently.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinPluginsRoot } from '../../src/host/cli/paths.js'

describe('unit · builtinPluginsRoot layout resolution', () => {
  let cleanup: () => Promise<void>
  afterEach(async () => {
    await cleanup()
  })

  it('the repo layout wins over an existing sibling plugins-dist (dev priority)', async () => {
    // A sibling plugins-dist must NOT hijack resolution when the root's own
    // plugins-dist exists: dev always hits <root>/plugins-dist first.
    const root = await mkdtemp(path.join(tmpdir(), 'rem2-bpr-repo-'))
    const sibling = path.resolve(root, '..')
    cleanup = async () => {
      await rm(root, { recursive: true, force: true })
      await rm(path.join(sibling, 'plugins-dist'), {
        recursive: true,
        force: true,
      })
    }
    await mkdir(path.join(root, 'plugins-dist'), { recursive: true })
    await mkdir(path.join(sibling, 'plugins-dist'), { recursive: true })

    expect(builtinPluginsRoot(root)).toBe(path.join(root, 'plugins-dist'))
  })

  it('the packaged layout resolves the sibling plugins-dist (negative guard: the old logic returned <root>/plugins)', async () => {
    // Negative criterion for the sibling-candidate fix: reverting to the old
    // implementation (no sibling candidate) makes this case fail.
    const root = await mkdtemp(path.join(tmpdir(), 'rem2-bpr-pack-'))
    const sibling = path.resolve(root, '..')
    cleanup = async () => {
      await rm(root, { recursive: true, force: true })
      await rm(path.join(sibling, 'plugins-dist'), {
        recursive: true,
        force: true,
      })
    }
    await mkdir(path.join(sibling, 'plugins-dist'), { recursive: true })

    expect(builtinPluginsRoot(root)).toBe(path.join(sibling, 'plugins-dist'))
  })

  it('no plugins-dist anywhere falls back to <root>/plugins', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rem2-bpr-none-'))
    cleanup = async () => {
      await rm(root, { recursive: true, force: true })
    }

    expect(builtinPluginsRoot(root)).toBe(path.join(root, 'plugins'))
  })

  it('an empty root still falls back to plugins without throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'rem2-bpr-empty-'))
    cleanup = async () => {
      await rm(root, { recursive: true, force: true })
    }

    expect(() => builtinPluginsRoot(root)).not.toThrow()
    expect(builtinPluginsRoot(root)).toBe(path.join(root, 'plugins'))
  })
})
