import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { makeManifest } from '../helpers/make-manifest.js'

interface Probe {
  resolveResult?: unknown
  resolveError?: Error | null
  bus?: unknown
  resolvePathEscaped?: boolean
}

function probe(): Probe {
  const g = globalThis as unknown as { __rem2Probe?: Probe }
  g.__rem2Probe ??= {}
  return g.__rem2Probe
}

async function writePlugin(
  root: string,
  id: string,
  source: string,
): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_')
  const pluginDir = path.join(root, dirName)
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  const manifest = makeManifest({ id, entry: 'dist/index.mjs' })
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
  await writeFile(path.join(pluginDir, 'dist', 'index.mjs'), source, 'utf8')
}

describe('integration · security boundary fixes', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-sec-'))
    probe()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('entry escapes rootDir → E_ENTRY_ESCAPE', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rem2-sec-out-'))
    await writeFile(
      path.join(outsideDir, 'evil.mjs'),
      'export default function f() { return {}; }',
      'utf8',
    )

    const pluginDir = path.join(root, 'com.rem2.evil')
    await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
    const manifest = makeManifest({
      id: 'com.rem2.evil',
      entry: '../../evil.mjs',
    })
    await writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    )

    const kernel = new Kernel({ roots: [root] })
    const result = await kernel.start()
    expect(result.failed).toContain('com.rem2.evil')
    // Entry escape is blocked at load time; the plugin never enters the registry.
    expect(kernel.pluginRegistry.getLoaded('com.rem2.evil')).toBeUndefined()

    await kernel.shutdown()
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('factory inline manifest.id drift → E_MANIFEST_MISMATCH', async () => {
    // Attach a manifest inconsistent with plugin.json (simulating a wrong id in definePlugin's first argument).
    await writePlugin(
      root,
      'com.rem2.mismatch',
      `
function factory(ctx) { return {}; }
factory.manifest = { id: 'com.rem2.different-id' };
export default factory;
`,
    )

    const kernel = new Kernel({ roots: [root] })
    const result = await kernel.start()
    expect(result.failed).toContain('com.rem2.mismatch')
    await kernel.shutdown()
  })

  it('entry is not a build artifact (.ts) → rejected at registration', async () => {
    const pluginDir = path.join(root, 'com.rem2.ts-entry')
    await mkdir(path.join(pluginDir, 'src'), { recursive: true })
    const manifest = makeManifest({
      id: 'com.rem2.ts-entry',
      entry: 'src/index.ts',
    })
    await writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    )
    await writeFile(
      path.join(pluginDir, 'src', 'index.ts'),
      'export default function f() { return {}; }',
      'utf8',
    )

    const kernel = new Kernel({ roots: [root] })
    const result = await kernel.start()
    expect(result.loadOrder).not.toContain('com.rem2.ts-entry')
    expect(kernel.pluginRegistry.getLoaded('com.rem2.ts-entry')).toBeUndefined()

    await kernel.shutdown()
  })

  it('a kernel sensitive service token is blocked by CapabilityGuard', async () => {
    await writePlugin(
      root,
      'com.rem2.sensitive-probe',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
P.resolveResult = null;
P.resolveError = null;
export default function factory(ctx) {
  return {
    async onStart() {
      try {
        // The loader belongs to kernel.internals; unauthorized access must be rejected.
        P.resolveResult = ctx.services.resolve({ id: 'kernel.loader', describe: '' });
      } catch (e) {
        P.resolveError = e;
      }
    },
  };
}
`,
    )

    const kernel = new Kernel({ roots: [root] })
    const result = await kernel.start()

    // The plugin starts normally, but the resolve is denied by the guard.
    expect(result.started).toContain('com.rem2.sensitive-probe')
    expect(
      kernel.pluginRegistry.getLoaded('com.rem2.sensitive-probe'),
    ).toBeDefined()
    expect(probe().resolveResult).toBeNull()
    expect(probe().resolveError).not.toBeNull()
    expect(probe().resolveError?.message).toContain('kernel.internals')

    await kernel.shutdown()
  })

  it('public kernel services (EventBus) resolve without a capability', async () => {
    await writePlugin(
      root,
      'com.rem2.public-probe',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
P.bus = null;
export default function factory(ctx) {
  return {
    async onStart() {
      // The event bus is public and requires no capability.
      P.bus = ctx.services.resolve({ id: 'kernel.event-bus', describe: '' });
    },
  };
}
`,
    )

    const kernel = new Kernel({ roots: [root] })
    const result = await kernel.start()
    expect(result.started).toContain('com.rem2.public-probe')
    expect(probe().bus).not.toBeNull()

    await kernel.shutdown()
  })

  it('resolvePath out of bounds throws EntryEscapeError', async () => {
    await writePlugin(
      root,
      'com.rem2.escape-probe',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
P.resolvePathEscaped = false;
export default function factory(ctx) {
  return {
    async onStart() {
      try {
        ctx.resolvePath('../../outside.txt');
        P.resolvePathEscaped = true;
      } catch (e) {
        P.resolvePathEscaped = e && e.code === 'E_ENTRY_ESCAPE';
      }
    },
  };
}
`,
    )

    const kernel = new Kernel({ roots: [root] })
    await kernel.start()
    expect(probe().resolvePathEscaped).toBe(true)
    await kernel.shutdown()
  })
})
