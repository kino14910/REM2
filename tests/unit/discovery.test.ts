import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PluginDiscovery } from '@/kernel/discovery/discovery.js'

import { makeManifest } from '../helpers/make-manifest.js'

async function writePlugin(
  root: string,
  dirName: string,
  manifest: unknown,
  fileName = 'plugin.json',
): Promise<void> {
  const dir = path.join(root, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, fileName),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
}

describe('discovery · root handling', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-discovery-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('skips a root that does not exist', async () => {
    const discovery = new PluginDiscovery()

    const result = await discovery.discoverDetailed({
      roots: [path.join(root, 'absent')],
    })

    expect(result.candidates).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('skips a root that is a regular file', async () => {
    const file = path.join(root, 'loose.txt')
    await writeFile(file, 'x', 'utf8')

    const discovery = new PluginDiscovery()

    expect(await discovery.discover({ roots: [file] })).toEqual([])
  })

  it('ignores hidden dirs, node_modules and stray files', async () => {
    await writePlugin(root, '.hidden', makeManifest({ id: 'com.rem2.hidden' }))
    await writePlugin(root, 'node_modules', makeManifest({ id: 'com.rem2.nm' }))
    await writePlugin(root, 'real', makeManifest({ id: 'com.rem2.real' }))

    const discovery = new PluginDiscovery()
    const found = await discovery.discover({ roots: [root] })

    expect(found.map(c => c.manifest.id)).toEqual(['com.rem2.real'])
  })
})

describe('discovery · manifest reading', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-discovery-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a valid manifest and records its root directory', async () => {
    await writePlugin(root, 'a', makeManifest({ id: 'com.rem2.a' }))

    const discovery = new PluginDiscovery()
    const found = await discovery.discover({ roots: [root] })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      source: 'user',
      builtin: false,
      legacy: false,
    })
    expect(found[0]?.rootDir).toBe(path.join(root, 'a'))
  })

  it('labels candidates under builtinRoot as builtin', async () => {
    await writePlugin(root, 'a', makeManifest({ id: 'com.rem2.a' }))

    const discovery = new PluginDiscovery()
    const found = await discovery.discover({ roots: [], builtinRoot: root })

    expect(found[0]?.source).toBe('builtin')
    expect(found[0]?.builtin).toBe(true)
  })

  it('records an unparsable plugin.json and skips the directory', async () => {
    const dir = path.join(root, 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'plugin.json'), '{ not json', 'utf8')

    const discovery = new PluginDiscovery()
    const result = await discovery.discoverDetailed({ roots: [root] })

    expect(result.candidates).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.dir).toBe(dir)
    expect(result.issues[0]?.message).toMatch(/plugin\.json parse failed/)
  })

  it('records a schema validation failure and skips the directory', async () => {
    await writePlugin(root, 'invalid', { id: '' })

    const discovery = new PluginDiscovery()
    const result = await discovery.discoverDetailed({ roots: [root] })

    expect(result.candidates).toEqual([])
    expect(result.issues[0]?.message).toMatch(/validation failed/)
  })

  it('silently ignores a directory with no manifest at all', async () => {
    await mkdir(path.join(root, 'empty'), { recursive: true })

    const discovery = new PluginDiscovery()
    const result = await discovery.discoverDetailed({ roots: [root] })

    expect(result.candidates).toEqual([])
    expect(result.issues).toEqual([])
  })
})

describe('discovery · legacy manifest fallback', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-discovery-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('falls back to manifest.json when enabled', async () => {
    await writePlugin(
      root,
      'legacy',
      makeManifest({ id: 'com.rem2.legacy' }),
      'manifest.json',
    )

    const discovery = new PluginDiscovery()
    const found = await discovery.discover({
      roots: [root],
      legacyFallback: true,
    })

    expect(found[0]?.legacy).toBe(true)
    expect(found[0]?.manifest.id).toBe('com.rem2.legacy')
  })

  it('ignores manifest.json when the fallback is off', async () => {
    await writePlugin(
      root,
      'legacy',
      makeManifest({ id: 'com.rem2.legacy' }),
      'manifest.json',
    )

    const discovery = new PluginDiscovery()

    expect(await discovery.discover({ roots: [root] })).toEqual([])
  })

  it('does not fall back when plugin.json exists but is broken', async () => {
    const dir = path.join(root, 'mixed')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'plugin.json'), '{ bad', 'utf8')
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify(makeManifest({ id: 'com.rem2.mixed' })),
      'utf8',
    )

    const discovery = new PluginDiscovery()
    const result = await discovery.discoverDetailed({
      roots: [root],
      legacyFallback: true,
    })

    expect(result.candidates).toEqual([])
    expect(result.issues[0]?.message).toMatch(/plugin\.json parse failed/)
  })

  it('reports a legacy validation failure', async () => {
    await writePlugin(root, 'legacy', { id: '' }, 'manifest.json')

    const discovery = new PluginDiscovery()
    const result = await discovery.discoverDetailed({
      roots: [root],
      legacyFallback: true,
    })

    expect(result.candidates).toEqual([])
    expect(result.issues[0]?.message).toMatch(
      /manifest\.json validation failed/,
    )
  })

  it('scanLegacyManifests reads legacy directories directly', async () => {
    await writePlugin(
      root,
      'legacy',
      makeManifest({ id: 'com.rem2.legacy' }),
      'manifest.json',
    )

    const found = await new PluginDiscovery().scanLegacyManifests(root)

    expect(found[0]?.legacy).toBe(true)
  })
})

describe('discovery · ordering and cache', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-discovery-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('orders builtin, then workspace, then user; by id within a source', async () => {
    const builtinRoot = path.join(root, 'builtin')
    const workspaceRoot = path.join(root, 'workspace')
    const userRoot = path.join(root, 'user')
    await writePlugin(builtinRoot, 'z', makeManifest({ id: 'com.rem2.z' }))
    await writePlugin(workspaceRoot, 'b', makeManifest({ id: 'com.rem2.b' }))
    await writePlugin(userRoot, 'a', makeManifest({ id: 'com.rem2.a' }))
    await writePlugin(userRoot, 'a2', makeManifest({ id: 'com.rem2.a0' }))

    const discovery = new PluginDiscovery()
    const found = await discovery.discover({
      roots: [userRoot],
      builtinRoot,
      workspaceRoot,
    })

    expect(found.map(c => c.manifest.id)).toEqual([
      'com.rem2.z',
      'com.rem2.b',
      'com.rem2.a',
      'com.rem2.a0',
    ])
  })

  it('reuses the cached scan while the root mtime is unchanged', async () => {
    await writePlugin(root, 'a', makeManifest({ id: 'com.rem2.a' }))

    const discovery = new PluginDiscovery()
    const first = await discovery.discover({ roots: [root] })
    const second = await discovery.discover({ roots: [root] })

    expect(second.map(c => c.manifest.id)).toEqual(
      first.map(c => c.manifest.id),
    )
  })

  it('rescans once the root mtime moves', async () => {
    await writePlugin(root, 'a', makeManifest({ id: 'com.rem2.a' }))
    const discovery = new PluginDiscovery()
    await discovery.discover({ roots: [root] })

    await writePlugin(root, 'b', makeManifest({ id: 'com.rem2.b' }))
    const future = new Date(Date.now() + 2000)
    await utimes(root, future, future)

    const found = await discovery.discover({ roots: [root] })

    expect(found.map(c => c.manifest.id).toSorted()).toEqual([
      'com.rem2.a',
      'com.rem2.b',
    ])
  })

  it('re-labels cached entries when the same root is scanned as another source', async () => {
    await writePlugin(root, 'a', makeManifest({ id: 'com.rem2.a' }))

    const discovery = new PluginDiscovery()
    const asUser = await discovery.discover({ roots: [root] })
    const asBuiltin = await discovery.discover({ roots: [], builtinRoot: root })

    expect(asUser[0]?.source).toBe('user')
    expect(asBuiltin[0]?.source).toBe('builtin')
    expect(asBuiltin[0]?.builtin).toBe(true)
  })

  it('rescans after clearCache', async () => {
    await writePlugin(root, 'a', makeManifest({ id: 'com.rem2.a' }))

    const discovery = new PluginDiscovery()
    await discovery.discover({ roots: [root] })
    discovery.clearCache()

    expect(await discovery.discover({ roots: [root] })).toHaveLength(1)
  })

  it('exposes the most recent scan through candidates', async () => {
    await writePlugin(root, 'a', makeManifest({ id: 'com.rem2.a' }))

    const discovery = new PluginDiscovery()
    await discovery.discover({ roots: [root] })

    expect(discovery.candidates.map(c => c.manifest.id)).toEqual(['com.rem2.a'])
  })
})
