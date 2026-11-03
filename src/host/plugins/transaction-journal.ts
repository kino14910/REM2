import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isValidPluginId } from '@/kernel/discovery/manifest-validator.js'
import type { PluginProvenance } from './provenance-store.js'

export type UpdateTransactionStage =
  | 'prepared'
  | 'backed-up'
  | 'installed'
  | 'committed'

export interface UpdateTransactionRecord {
  version: 1
  pluginId: string
  stage: UpdateTransactionStage
  backupName: string
  workName: string
  previousDisabled: boolean
  previousProvenance?: PluginProvenance
  nextProvenance: PluginProvenance
}

const STAGES = new Set<UpdateTransactionStage>([
  'prepared',
  'backed-up',
  'installed',
  'committed',
])

/**
 * Durable intent for a directory-swapping update.
 *
 * A crash between `rename(target, backup)` and the provenance write leaves the
 * plugin either missing or half-updated. This journal is written before the
 * first destructive rename and removed only after the transaction is committed
 * (or fully rolled back), so startup can finish the job.
 */
export class PluginUpdateJournal {
  constructor(private readonly directory: string) {}

  async record(record: UpdateTransactionRecord): Promise<void> {
    this.assertValid(record)
    await mkdir(this.directory, { recursive: true })
    const file = this.fileFor(record.pluginId)
    const temporary = path.join(
      this.directory,
      `.${record.pluginId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    )
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async clear(pluginId: string): Promise<void> {
    if (!isValidPluginId(pluginId)) {
      throw new Error('invalid plugin id for update journal')
    }
    await rm(this.fileFor(pluginId), { force: true })
  }

  async list(): Promise<UpdateTransactionRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: UpdateTransactionRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const raw = JSON.parse(
          await readFile(path.join(this.directory, entry), 'utf8'),
        ) as unknown
        this.assertValid(raw)
        records.push(raw)
      } catch {
        // A corrupt journal must not prevent startup. Orphan recovery below
        // still handles backups; the corrupt file is left for diagnostics.
      }
    }
    return records
  }

  private fileFor(pluginId: string): string {
    return path.join(this.directory, `${pluginId}.json`)
  }

  private assertValid(
    value: unknown,
  ): asserts value is UpdateTransactionRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('invalid update journal')
    }
    const record = value as Record<string, unknown>
    if (
      record.version !== 1 ||
      typeof record.pluginId !== 'string' ||
      !isValidPluginId(record.pluginId) ||
      typeof record.stage !== 'string' ||
      !STAGES.has(record.stage as UpdateTransactionStage) ||
      typeof record.backupName !== 'string' ||
      !/^\.backup-[A-Za-z0-9._-]+$/.test(record.backupName) ||
      typeof record.workName !== 'string' ||
      !/^\.update-[A-Za-z0-9._-]+$/.test(record.workName) ||
      typeof record.previousDisabled !== 'boolean' ||
      !isProvenance(record.nextProvenance) ||
      (record.previousProvenance !== undefined &&
        !isProvenance(record.previousProvenance))
    ) {
      throw new Error('invalid update journal')
    }
  }
}

function isProvenance(value: unknown): value is PluginProvenance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entry = value as Record<string, unknown>
  return (
    entry.kind === 'remote' &&
    typeof entry.url === 'string' &&
    isHttpsUrl(entry.url) &&
    typeof entry.sha256 === 'string' &&
    /^[0-9a-fA-F]{64}$/.test(entry.sha256) &&
    typeof entry.installedAt === 'string' &&
    (entry.publishedAt === undefined || typeof entry.publishedAt === 'string')
  )
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
