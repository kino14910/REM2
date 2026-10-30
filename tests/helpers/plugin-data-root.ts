/**
 * Isolated writable plugin data per kernel instance.
 *
 * Tests run multiple kernels (and Vitest runs files in parallel); a shared data
 * root would let one case's persisted theme selection leak into another, while
 * pointing it at `plugins-dist` would write into build artifacts.
 */

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const roots: string[] = []
let sequence = 0

export function createTestPluginDataRoot(label: string): string {
  sequence += 1
  const root = path.join(
    tmpdir(),
    'rem2-test-plugin-data',
    `${label}-${process.pid}-${Date.now()}-${sequence}`,
  )
  roots.push(root)
  return root
}

export async function cleanupTestPluginDataRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
}
