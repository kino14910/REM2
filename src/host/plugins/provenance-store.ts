import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isValidPluginId } from '../../kernel/discovery/manifest-validator.js'
import { PluginManagementError } from './errors.js'

export interface PluginProvenance {
  kind: 'remote'
  url: string
  sha256: string
  publishedAt?: string
  installedAt: string
}

interface PersistedProvenance {
  version: 1
  entries: Record<string, PluginProvenance>
}

export class PluginProvenanceStore {
  private provenance: Record<string, PluginProvenance> = Object.create(
    null,
  ) as Record<string, PluginProvenance>
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
        'plugin provenance is not valid JSON',
        { cause: error },
      )
    }
    if (!isPersistedProvenance(raw)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'plugin provenance must be { version: 1, entries: validProvenanceById }',
      )
    }
    this.provenance = Object.assign(
      Object.create(null) as Record<string, PluginProvenance>,
      Object.fromEntries(
        Object.entries(raw.entries).map(([id, entry]) => [id, { ...entry }]),
      ),
    )
    this.loaded = true
  }

  get(pluginId: string): PluginProvenance | undefined {
    const entry = this.provenance[pluginId]
    return entry === undefined ? undefined : { ...entry }
  }

  entries(): Readonly<Record<string, PluginProvenance>> {
    return Object.fromEntries(
      Object.entries(this.provenance).map(([id, entry]) => [id, { ...entry }]),
    )
  }

  async set(pluginId: string, entry: PluginProvenance): Promise<void> {
    if (!isValidPluginId(pluginId) || !isProvenance(entry)) {
      throw new PluginManagementError(
        'E_STATE_INVALID',
        'invalid plugin provenance entry',
      )
    }
    const previous = this.provenance[pluginId]
    this.provenance[pluginId] = { ...entry }
    try {
      await this.persist()
    } catch (error) {
      if (previous === undefined) delete this.provenance[pluginId]
      else this.provenance[pluginId] = previous
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
    const previous = this.provenance[pluginId]
    if (previous === undefined) return
    delete this.provenance[pluginId]
    try {
      await this.persist()
    } catch (error) {
      this.provenance[pluginId] = previous
      throw error
    }
  }

  private async persist(): Promise<void> {
    const state: PersistedProvenance = {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(this.provenance).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    }
    const dir = path.dirname(this.filePath)
    const temp = path.join(
      dir,
      `.plugin-provenance-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
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
        'failed to persist plugin provenance',
        { cause: error },
      )
    }
  }
}

function isPersistedProvenance(value: unknown): value is PersistedProvenance {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    return false
  }
  return Object.entries(value.entries).every(
    ([id, entry]) => isValidPluginId(id) && isProvenance(entry),
  )
}

function isProvenance(value: unknown): value is PluginProvenance {
  if (!isRecord(value)) return false
  return (
    value.kind === 'remote' &&
    typeof value.url === 'string' &&
    isHttpsUrl(value.url) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-fA-F]{64}$/.test(value.sha256) &&
    typeof value.installedAt === 'string' &&
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
