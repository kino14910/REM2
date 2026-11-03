/**
 * Contract test: electron-store is confined to the main-process settings adapter.
 *
 * Kernel, renderer, preload, shared contracts and plugins must stay free of the
 * Electron persistence dependency; only `host/electron` may import it, exactly
 * once, so the storage engine cannot leak into the plugin API surface.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { collectSourceFiles, extractSpecifiers } from './helpers/source-scan.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const ALLOWED = path.join(
  PROJECT_ROOT,
  'src',
  'host',
  'electron',
  'app-settings-store.ts',
)

describe('contract · electron-store stays inside the main-process adapter', () => {
  it('only the dedicated Main adapter imports electron-store', async () => {
    const files: string[] = []
    for (const root of [
      path.join(PROJECT_ROOT, 'src'),
      path.join(PROJECT_ROOT, 'plugins'),
    ]) {
      files.push(...(await collectSourceFiles(root)))
    }

    const importers: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (extractSpecifiers(source).includes('electron-store')) {
        importers.push(file)
      }
    }

    expect(importers).toEqual([ALLOWED])
  })
})
