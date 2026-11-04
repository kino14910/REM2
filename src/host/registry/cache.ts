import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import type { RegistryIndex } from './types.js'

import { RegistryClientError } from './errors.js'
import { parseRegistryIndex } from './parser.js'

const CACHE_VERSION = 1
const MAX_CACHE_BYTES = 4 * 1024 * 1024

interface PersistedRegistryCache {
  version: 1
  sourceUrl: string
  fetchedAt: string
  index: RegistryIndex
}

export interface RegistryCacheEntry {
  sourceUrl: string
  /** Time the index was last fetched successfully from the registry. */
  fetchedAt: string
  index: RegistryIndex
}

export type RegistryCacheReadResult =
  | { status: 'miss' }
  | { status: 'hit'; entry: RegistryCacheEntry }
  | { status: 'invalid'; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}

function normalizeUrl(value: string): string | null {
  try {
    return new URL(value).href
  } catch {
    return null
  }
}

/**
 * Last known good registry index.
 *
 * A corrupt or foreign cache entry is never used and never deleted: preserving
 * it keeps diagnostics possible, and the next successful fetch replaces it.
 */
export class RegistryCache {
  constructor(readonly filePath: string) {}

  async read(sourceUrl: string): Promise<RegistryCacheReadResult> {
    const requestedUrl = normalizeUrl(sourceUrl)
    if (requestedUrl === null) {
      throw new RegistryClientError(
        'E_REGISTRY_CACHE',
        `invalid registry URL: ${sourceUrl}`,
      )
    }

    let stats
    try {
      stats = await lstat(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'miss' }
      }
      throw new RegistryClientError(
        'E_REGISTRY_CACHE',
        `cannot read registry cache: ${this.filePath}`,
        { cause: error },
      )
    }
    if (!stats.isFile() || stats.size > MAX_CACHE_BYTES) {
      return {
        status: 'invalid',
        reason: 'cache is not a valid registry cache file',
      }
    }

    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      throw new RegistryClientError(
        'E_REGISTRY_CACHE',
        `cannot read registry cache: ${this.filePath}`,
        { cause: error },
      )
    }
    if (text.length > MAX_CACHE_BYTES) {
      return { status: 'invalid', reason: 'cache exceeds the size limit' }
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return {
        status: 'invalid',
        reason: `cache is not valid JSON: ${(error as Error).message}`,
      }
    }
    if (!isPlainObject(raw) || raw.version !== CACHE_VERSION) {
      return {
        status: 'invalid',
        reason: `cache must be { version: ${CACHE_VERSION}, sourceUrl, fetchedAt, index }`,
      }
    }
    if (typeof raw.sourceUrl !== 'string') {
      return { status: 'invalid', reason: 'cache sourceUrl must be a string' }
    }
    const cachedUrl = normalizeUrl(raw.sourceUrl)
    if (cachedUrl === null) {
      return { status: 'invalid', reason: 'cache sourceUrl is not a valid URL' }
    }
    if (cachedUrl !== requestedUrl) {
      return { status: 'miss' }
    }
    if (
      typeof raw.fetchedAt !== 'string' ||
      Number.isNaN(Date.parse(raw.fetchedAt))
    ) {
      return {
        status: 'invalid',
        reason: 'cache fetchedAt must be an ISO-8601 timestamp',
      }
    }

    let index: RegistryIndex
    try {
      index = parseRegistryIndex(raw.index)
    } catch (error) {
      const code = error instanceof RegistryClientError ? `${error.code}: ` : ''
      return {
        status: 'invalid',
        reason: `cache index is invalid: ${code}${(error as Error).message}`,
      }
    }

    return {
      status: 'hit',
      entry: {
        sourceUrl: cachedUrl,
        fetchedAt: raw.fetchedAt,
        index,
      },
    }
  }

  async write(entry: RegistryCacheEntry): Promise<void> {
    const sourceUrl = normalizeUrl(entry.sourceUrl)
    if (sourceUrl === null) {
      throw new RegistryClientError(
        'E_REGISTRY_CACHE',
        `invalid registry cache source URL: ${entry.sourceUrl}`,
      )
    }
    if (Number.isNaN(Date.parse(entry.fetchedAt))) {
      throw new RegistryClientError(
        'E_REGISTRY_CACHE',
        `invalid registry cache timestamp: ${entry.fetchedAt}`,
      )
    }

    const file: PersistedRegistryCache = {
      version: CACHE_VERSION,
      sourceUrl,
      fetchedAt: entry.fetchedAt,
      index: entry.index,
    }
    const dir = path.dirname(this.filePath)
    const temp = path.join(
      dir,
      `.registry-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    )
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      await rename(temp, this.filePath)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new RegistryClientError(
        'E_REGISTRY_CACHE',
        `failed to persist registry cache: ${this.filePath}`,
        { cause: error },
      )
    }
  }
}
