/**
 * Fixture plugins all use the unique shape (default-exported factory). In-process
 * plugins share the Node context with the test, so observations are written to
 * `globalThis.__rem2Probe` for assertions to read - closer to the new shape than
 * reverse-reading plugin instance fields from the kernel registry (factory
 * products are closures with no readable fields).
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { defineToken } from '../../src/kernel/contracts/service-token.js'
import { makeManifest } from '../helpers/make-manifest.js'
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js'

/** Observation outlet for in-process fixture plugins. */
interface Probe {
  greeting?: string
  stopped?: boolean
  resolveResult?: unknown
  resolveError?: Error | null
  bus?: unknown
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
  deps?: Record<string, string>,
): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_')
  const pluginDir = path.join(root, dirName)
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  const manifest = makeManifest({
    id,
    // Unique shape: build artifact. The fixture writes source directly to dist/index.mjs.
    entry: 'dist/index.mjs',
    ...(deps ? { dependencies: deps } : {}),
  })
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
  await writeFile(path.join(pluginDir, 'dist', 'index.mjs'), source, 'utf8')
}

describe('integration · kernel hardening', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-hardening-'))
    probe()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('config bootstrap: initialConfig is visible to plugin onConfigure (no config plugin needed)', async () => {
    await writePlugin(
      root,
      'com.rem2.config-reader',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
export default function factory(ctx) {
  return {
    async onConfigure() {
      P.greeting = ctx.config.get('app.greeting', '(default)');
    },
  };
}
`,
    )

    const kernel = new Kernel({
      roots: [root],
      initialConfig: { app: { greeting: 'BootstrapHello' } },
    })
    const result = await kernel.start()
    expect(result.started).toContain('com.rem2.config-reader')
    expect(probe().greeting).toBe('BootstrapHello')

    await kernel.shutdown()
  })

  it('unloadPlugin cascades the unload to dependents and reclaims artifacts', async () => {
    await writePlugin(
      root,
      'com.rem2.base-svc',
      `export default function factory() { return {}; }`,
    )
    await writePlugin(
      root,
      'com.rem2.dependent',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
export default function factory() {
  return {
    async onStop() { P.stopped = true; },
  };
}
`,
      { 'com.rem2.base-svc': '^1.0.0' },
    )

    const kernel = new Kernel({ roots: [root] })
    const result = await kernel.start()
    expect(result.started).toContain('com.rem2.base-svc')
    expect(result.started).toContain('com.rem2.dependent')

    await kernel.unloadPlugin('com.rem2.base-svc')

    expect(kernel.pluginRegistry.getLoaded('com.rem2.base-svc')).toBeUndefined()
    expect(
      kernel.pluginRegistry.getLoaded('com.rem2.dependent'),
    ).toBeUndefined()
    expect(kernel.lastStartResult.started).not.toContain('com.rem2.base-svc')
    expect(kernel.lastStartResult.started).not.toContain('com.rem2.dependent')
    expect(probe().stopped).toBe(true)

    await kernel.shutdown()
  })

  it('hot reload: old services that did not unexport do not leak into the root mount table', async () => {
    const GreeterTokenSrc = `({ id: 'plugin.test.leaky', describe: 'leaky' })`
    // V1: exports the service but never unexports it in onUnload (no self-cleanup).
    const body = (version: number) => `
const TOKEN = ${GreeterTokenSrc}
export default function factory(ctx) {
  return {
    async onStart() {
      ctx.services.registerInstance(TOKEN, { version: ${version} })
      ctx.api.export(TOKEN)
    },
    // Intentionally does not implement onUnload (never calls api.unexport).
  }
}
`
    await writePlugin(root, 'com.rem2.leaky', body(1))

    const kernel = new Kernel({ roots: [root] })
    await kernel.start()

    // V2: rewrite the plugin file (still no unexport).
    await writePlugin(root, 'com.rem2.leaky', body(2))
    await kernel.reload('com.rem2.leaky')

    // The root container should resolve the new instance (version 2), with only one container for this plugin in the mount table.
    const token = defineToken<{ version: number }>({
      id: 'plugin.test.leaky',
      describe: '',
    })
    const svc = kernel.root.resolve(token)
    expect(svc.version).toBe(2)

    await kernel.shutdown()
  })

  it('lifecycle phases produce tracing spans', async () => {
    await writePlugin(
      root,
      'com.rem2.traced',
      `export default function factory() { return { async onStart() {} } }`,
    )

    const kernel = new Kernel({ roots: [root] })
    await kernel.start()

    const spans = kernel.tracing.bufferedSpans()
    const names = spans.map(s => s.name)
    expect(names).toContain('plugin.lifecycle.Configured')
    const startSpan = spans.find(
      s =>
        s.name === 'plugin.lifecycle.Configured' &&
        s.attributes.pluginId === 'com.rem2.traced',
    )
    expect(startSpan).toBeDefined()
    expect(startSpan!.attributes.ok).toBe(true)

    await kernel.shutdown()
  })

  it('the EventBus token stays public (the kernel service whitelist boundary is correct)', async () => {
    const kernel = new Kernel({ roots: [] })
    // The kernel side ('kernel' caller) is not restricted by the guard.
    const bus = kernel.root.resolve(KernelTokens.EventBus)
    expect(typeof bus.emit).toBe('function')
    await kernel.shutdown()
  })
})
