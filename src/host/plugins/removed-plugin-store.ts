import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import type { PluginManifest } from '../../kernel/contracts/manifest.js'
import { validateManifest } from '../../kernel/discovery/manifest-validator.js'
import type { PluginOriginDto } from '../../shared/ipc-contract.js'
import { PluginManagementError } from './errors.js'
import { isSha256 } from './integrity.js'

/** A plugin the user uninstalled, kept so it can be listed and installed again. */
export interface RemovedPluginRecord {
  /** Manifest snapshot taken when the plugin was uninstalled. */
  manifest: PluginManifest
  /** Where it can be installed from again; absent for very old records. */
  origin?: PluginOriginDto
  removedAt: string
}

interface PersistedRemovedPlugins {
  version: 1
  entries: Record<string, RemovedPluginRecord>
}

/**
 * Durable list of uninstalled plugins.
 *
 * Removing the code must not remove the plugin from the manager UI: keeping the
 * manifest and install source lets the list project a `NotInstalled` entry with
 * an Install action. Records are host-only; the renderer never receives paths.
 */
export class PluginRemovedStore {
  private entries: Record<string, RemovedPluginRecord> = Object.create(
    null,
  ) as Record<string, RemovedPluginRecord>
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
        'removed plugin records are not valid JSON',
        { cause: error },
      )
    }
    if (!isPersistedRemovedPlugins(raw)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'removed plugin records must be { version: 1, entries: validRecords }',
      )
    }
    this.entries = Object.assign(
      Object.create(null) as Record<string, RemovedPluginRecord>,
      Object.fromEntries(
        Object.entries(raw.entries).map(([id, record]) => [
          id,
          cloneRecord(record),
        ]),
      ),
    )
    this.loaded = true
  }

  get(pluginId: string): RemovedPluginRecord | undefined {
    const record = this.entries[pluginId]
    return record === undefined ? undefined : cloneRecord(record)
  }

  entriesOf(): RemovedPluginRecord[] {
    return Object.entries(this.entries)
      .map(([, record]) => cloneRecord(record))
      .toSorted((left, right) =>
        left.manifest.id.localeCompare(right.manifest.id, 'en'),
      )
  }

  async set(pluginId: string, record: RemovedPluginRecord): Promise<void> {
    if (!isValidRecord(pluginId, record)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'invalid removed plugin record',
      )
    }
    const previous = this.entries[pluginId]
    this.entries[pluginId] = cloneRecord(record)
    try {
      await this.persist()
    } catch (error) {
      if (previous === undefined) delete this.entries[pluginId]
      else this.entries[pluginId] = previous
      throw error
    }
  }

  async remove(pluginId: string): Promise<void> {
    const previous = this.entries[pluginId]
    if (previous === undefined) return
    delete this.entries[pluginId]
    try {
      await this.persist()
    } catch (error) {
      this.entries[pluginId] = previous
      throw error
    }
  }

  private async persist(): Promise<void> {
    const state: PersistedRemovedPlugins = {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(this.entries).toSorted(([left], [right]) =>
          left.localeCompare(right, 'en'),
        ),
      ),
    }
    const dir = path.dirname(this.filePath)
    const temp = path.join(
      dir,
      `.plugin-removed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
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
        'failed to persist removed plugin records',
        { cause: error },
      )
    }
  }
}

function cloneRecord(record: RemovedPluginRecord): RemovedPluginRecord {
  return {
    manifest: structuredClone(record.manifest),
    ...(record.origin ? { origin: { ...record.origin } } : {}),
    removedAt: record.removedAt,
  }
}

function isPersistedRemovedPlugins(
  value: unknown,
): value is PersistedRemovedPlugins {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    return false
  }
  return Object.entries(value.entries).every(
    ([id, record]) => isRecord(record) && isValidRecord(id, record),
  )
}

function isValidRecord(
  pluginId: string,
  value: unknown,
): value is RemovedPluginRecord {
  if (!isRecord(value)) return false
  const manifest = value.manifest
  const validated = validateManifest(manifest)
  if (!validated.ok || !validated.value) return false
  if (validated.value.id !== pluginId) return false
  if (typeof value.removedAt !== 'string') return false
  return isOrigin(value.origin)
}

function isOrigin(value: unknown): value is PluginOriginDto | undefined {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  if (value.kind === 'directory') {
    return (
      value.url === undefined &&
      value.sha256 === undefined &&
      value.publishedAt === undefined
    )
  }
  if (value.kind !== 'remote') return false
  return (
    typeof value.url === 'string' &&
    isHttpsUrl(value.url) &&
    typeof value.sha256 === 'string' &&
    isSha256(value.sha256) &&
    (value.publishedAt === undefined || typeof value.publishedAt === 'string')
  )
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
