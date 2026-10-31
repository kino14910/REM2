import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isValidPluginId } from '../../kernel/discovery/manifest-validator.js'
import { PluginManagementError } from './errors.js'

/** Capability names use the same grammar as `manifest.requires`. */
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/
const MAX_CAPABILITIES_PER_PLUGIN = 64

interface PersistedGrants {
  version: 1
  entries: Record<string, string[]>
}

/**
 * Explicit capability grants for sandboxed (user-installed) plugins.
 *
 * The kernel derives its default decision from the trust policy; a grant here
 * only lifts the sandbox denial for capabilities the manifest already declares.
 * Built-in plugins are trusted and never need entries.
 */
export class PluginGrantStore {
  private grants = Object.create(null) as Record<string, string[]>
  private loaded = false

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'plugin grants are not valid JSON',
        { cause: error },
      )
    }
    if (!isPersistedGrants(raw)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'plugin grants must be { version: 1, entries: validGrantsById }',
      )
    }
    this.grants = Object.assign(
      Object.create(null) as Record<string, string[]>,
      Object.fromEntries(
        Object.entries(raw.entries).map(([id, capabilities]) => [
          id,
          [...capabilities],
        ]),
      ),
    )
    this.loaded = true
  }

  /** Granted capabilities for one plugin (empty when nothing was granted). */
  get(pluginId: string): readonly string[] {
    return this.grants[pluginId] ?? []
  }

  entries(): Readonly<Record<string, readonly string[]>> {
    return Object.fromEntries(
      Object.entries(this.grants).map(([id, capabilities]) => [
        id,
        [...capabilities],
      ]),
    )
  }

  /** Add capabilities to a plugin's grant set (idempotent, additive). */
  async set(pluginId: string, capabilities: readonly string[]): Promise<void> {
    if (!isValidPluginId(pluginId)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        `invalid plugin id: ${pluginId}`,
      )
    }
    if (
      capabilities.length === 0 ||
      capabilities.length > MAX_CAPABILITIES_PER_PLUGIN ||
      !capabilities.every(capability => CAPABILITY_RE.test(capability)) ||
      new Set(capabilities).size !== capabilities.length
    ) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'capabilities must be 1..64 unique capability names',
      )
    }
    const previous = this.grants[pluginId]
    const merged = [...new Set([...(previous ?? []), ...capabilities])].toSorted(
      (a, b) => a.localeCompare(b, 'en'),
    )
    this.grants[pluginId] = merged
    try {
      await this.persist()
    } catch (error) {
      if (previous === undefined) delete this.grants[pluginId]
      else this.grants[pluginId] = previous
      throw error
    }
  }

  async remove(pluginId: string): Promise<void> {
    if (!isValidPluginId(pluginId)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        `invalid plugin id: ${pluginId}`,
      )
    }
    const previous = this.grants[pluginId]
    if (previous === undefined) return
    delete this.grants[pluginId]
    try {
      await this.persist()
    } catch (error) {
      this.grants[pluginId] = previous
      throw error
    }
  }

  private async persist(): Promise<void> {
    const state: PersistedGrants = {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(this.grants).toSorted(([left], [right]) =>
          left.localeCompare(right, 'en'),
        ),
      ),
    }
    const dir = path.dirname(this.filePath)
    const temp = path.join(
      dir,
      `.plugin-grants-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    )
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      await rename(temp, this.filePath)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new PluginManagementError(
        'E_STATE_WRITE',
        'failed to persist plugin grants',
        { cause: error },
      )
    }
  }
}

function isPersistedGrants(value: unknown): value is PersistedGrants {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as PersistedGrants).version !== 1 ||
    typeof (value as PersistedGrants).entries !== 'object' ||
    (value as PersistedGrants).entries === null ||
    Array.isArray((value as PersistedGrants).entries)
  ) {
    return false
  }
  return Object.entries(
    (value as PersistedGrants).entries as Record<string, unknown>,
  ).every(
    ([id, capabilities]) =>
      isValidPluginId(id) &&
      Array.isArray(capabilities) &&
      capabilities.length > 0 &&
      capabilities.length <= MAX_CAPABILITIES_PER_PLUGIN &&
      capabilities.every(
        capability =>
          typeof capability === 'string' && CAPABILITY_RE.test(capability),
      ) &&
      new Set(capabilities).size === capabilities.length,
  )
}
