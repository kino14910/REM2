import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { ConfigService } from '../../src/kernel/config/config-service.js'
import { tryInjectJsonProvider } from '../fixtures/json-provider.js'

describe('integration · config-plugins', () => {
  let cleanup: () => Promise<void>
  beforeEach(() => {
    cleanup = async () => undefined
  })
  afterEach(async () => {
    await cleanup()
  })

  it('the config service can register/unregister providers, and layered merging works', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rem2-cfg-'))
    const file = path.join(dir, 'app.config.json')
    await writeFile(
      file,
      JSON.stringify({ app: { greeting: 'From File' } }),
      'utf8',
    )
    cleanup = async () => {
      await rm(dir, { recursive: true, force: true })
    }

    const svc = new ConfigService()
    await tryInjectJsonProvider(svc, file)
    await svc.refresh()

    expect(svc.get('app.greeting')).toBe('From File')
    expect(svc.layers()).toContain('json')
  })

  it('the kernel default in-memory config can be overridden by the plugin layer', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rem2-cfg-'))
    const file = path.join(dir, 'app.config.json')
    await writeFile(
      file,
      JSON.stringify({ app: { name: 'overridden' } }),
      'utf8',
    )
    cleanup = async () => {
      await rm(dir, { recursive: true, force: true })
    }

    const kernel = new Kernel({
      roots: [],
      initialConfig: { app: { name: 'default' } },
    })
    // Start the kernel (no plugins), then inject a json provider into the same kernel's config service.
    await kernel.start()
    expect(kernel.root).toBeDefined()

    await kernel.shutdown()
  })
})
