/**
 * Plugin discovery: scans plugin subdirectories under roots, reads and
 * validates `plugin.json`; optional legacy `manifest.json` compatibility
 * (off by default, `legacyFallback`).
 *
 * Zero-dependency: uses only node:fs/promises and node:path.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Candidate, CandidateSource } from './candidate.js'
import { validateManifest } from './manifest-validator.js'
import { MANIFEST_FILENAME, LEGACY_MANIFEST_FILENAME } from '../version.js'

export interface DiscoverOptions {
  /** Scan roots (absolute paths). */
  roots: string[]
  /** Built-in plugins directory to scan (mapped to source=builtin). */
  builtinRoot?: string
  /** Whether to try legacy manifest.json compatibility. */
  legacyFallback?: boolean
  /** Current workspace plugin root (source=workspace). */
  workspaceRoot?: string
}

/** A single scan failure record (non-fatal). */
export interface DiscoverIssue {
  dir: string
  message: string
}

export interface DiscoverResult {
  candidates: Candidate[]
  issues: DiscoverIssue[]
}

export class PluginDiscovery {
  private lastCandidates: Candidate[] = []
  private readonly issues: DiscoverIssue[] = []
  /**
   * Lightweight scan cache: key = root directory + root mtime.
   *
   * A root's mtime changes whenever any child entry is added, removed, or
   * modified, so it suffices as a signal for "the plugin set under this
   * root may have changed" - avoiding repeated readdir + per-plugin
   * readFile of plugin.json on the hot-reload path.
   */
  private readonly scanCache = new Map<
    string,
    { rootMtimeMs: number; found: Candidate[] }
  >()

  get candidates(): Candidate[] {
    return this.lastCandidates
  }

  get issuesReadonly(): ReadonlyArray<DiscoverIssue> {
    return this.issues
  }

  /**
   * Run discovery. Results are stably sorted by "source, then id" for
   * determinism.
   */
  async discover(opts: DiscoverOptions): Promise<Candidate[]> {
    const result = await this.discoverDetailed(opts)
    this.lastCandidates = result.candidates
    return result.candidates
  }

  /** Detailed discovery (includes issues). */
  async discoverDetailed(opts: DiscoverOptions): Promise<DiscoverResult> {
    const collected: Candidate[] = []
    const issues: DiscoverIssue[] = []

    const roots: Array<{ dir: string; source: CandidateSource }> = []
    if (opts.builtinRoot)
      roots.push({ dir: opts.builtinRoot, source: 'builtin' })
    if (opts.workspaceRoot)
      roots.push({ dir: opts.workspaceRoot, source: 'workspace' })
    for (const r of opts.roots) {
      // Explicit roots default to user plugins (unless already specified as builtinRoot/workspaceRoot).
      if (!roots.some(x => path.resolve(x.dir) === path.resolve(r))) {
        roots.push({ dir: r, source: 'user' })
      }
    }

    for (const { dir, source } of roots) {
      const found = await this.scanRoot(
        dir,
        source,
        !!opts.legacyFallback,
        issues,
      )
      collected.push(...found)
    }

    // Stable sort: source rank, then id.
    collected.sort((a, b) => {
      const ra = sourceRank(a.source)
      const rb = sourceRank(b.source)
      if (ra !== rb) return ra - rb
      return a.manifest.id.localeCompare(b.manifest.id, 'en')
    })

    return { candidates: collected, issues }
  }

  /** Scan a single root directory (with mtime caching). */
  async scanRoot(
    root: string,
    source: CandidateSource,
    legacyFallback: boolean,
    issues: DiscoverIssue[],
  ): Promise<Candidate[]> {
    const out: Candidate[] = []

    let entries: string[]
    let rootMtimeMs = 0
    try {
      const st = await stat(root)
      if (!st.isDirectory()) return out
      rootMtimeMs = st.mtimeMs
      const cached = this.scanCache.get(root)
      if (cached && cached.rootMtimeMs === rootMtimeMs) {
        // Cache hit: re-label cached entries with the current source (source is a scan parameter, not cached content).
        for (const c of cached.found) {
          out.push({ ...c, source, builtin: source === 'builtin' })
        }
        return out
      }
      entries = await readdir(root)
    } catch {
      // Root does not exist -> silently skipped (optional root).
      return out
    }

    for (const entry of entries.sort((a, b) => a.localeCompare(b, 'en'))) {
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const dir = path.join(root, entry)

      let dirStat
      try {
        dirStat = await stat(dir)
      } catch {
        continue
      }
      if (!dirStat.isDirectory()) continue

      const candidate = await this.readManifest(
        dir,
        source,
        legacyFallback,
        issues,
      )
      if (candidate) out.push(candidate)
    }

    this.scanCache.set(root, { rootMtimeMs, found: out.slice() })
    return out
  }

  /** Clear the scan cache (tests only; production relies on natural mtime expiry). */
  clearCache(): void {
    this.scanCache.clear()
  }

  /** Read the manifest from a plugin directory. */
  async readManifest(
    dir: string,
    source: CandidateSource,
    legacyFallback: boolean,
    issues: DiscoverIssue[],
  ): Promise<Candidate | null> {
    const primary = path.join(dir, MANIFEST_FILENAME)

    const primaryRaw = await tryReadJson(primary)
    if (primaryRaw.ok) {
      const validation = validateManifest(primaryRaw.value)
      if (!validation.ok || !validation.value) {
        issues.push({
          dir,
          message: `plugin.json validation failed: ${validation.issues.map(i => `${i.path} ${i.message}`).join('; ')}`,
        })
        return null
      }
      return {
        manifest: validation.value,
        rootDir: dir,
        source,
        builtin: source === 'builtin',
        legacy: false,
      }
    }

    // Primary manifest exists but failed to read/parse -> record an issue, no fallback.
    if (primaryRaw.exists) {
      issues.push({
        dir,
        message: `plugin.json parse failed: ${primaryRaw.error}`,
      })
      return null
    }

    // Legacy compatibility
    if (legacyFallback) {
      const legacyPath = path.join(dir, LEGACY_MANIFEST_FILENAME)
      const legacyRaw = await tryReadJson(legacyPath)
      if (legacyRaw.ok) {
        const validation = validateManifest(legacyRaw.value)
        if (!validation.ok || !validation.value) {
          issues.push({
            dir,
            message: `manifest.json validation failed: ${validation.issues.map(i => `${i.path} ${i.message}`).join('; ')}`,
          })
          return null
        }
        return {
          manifest: validation.value,
          rootDir: dir,
          source,
          builtin: source === 'builtin',
          legacy: true,
        }
      }
    }

    return null
  }

  /** Legacy manifest scan entry (kept for external callers). */
  async scanLegacyManifests(root: string): Promise<Candidate[]> {
    const issues: DiscoverIssue[] = []
    return await this.scanRoot(root, 'user', true, issues)
  }
}

function sourceRank(source: CandidateSource): number {
  switch (source) {
    case 'builtin':
      return 0
    case 'workspace':
      return 1
    case 'user':
      return 2
    default:
      return 3
  }
}

interface ReadJsonResult {
  ok: boolean
  exists: boolean
  value?: unknown
  error?: string
}

async function tryReadJson(file: string): Promise<ReadJsonResult> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    return { ok: false, exists: false, error: (e as Error).message }
  }
  try {
    const value = JSON.parse(text) as unknown
    return { ok: true, exists: true, value }
  } catch (e) {
    return { ok: false, exists: true, error: (e as Error).message }
  }
}
