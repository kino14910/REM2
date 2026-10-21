/**
 * Test helper: build an in-memory plugin manifest (no disk access).
 *
 * The default `entry` is `dist/index.js` (single-shape form);
 * `capabilities` is split into `requires` (what I need) + `contributes` (what I provide).
 */

import type {
  Candidate,
  CandidateSource,
} from '../../src/kernel/discovery/candidate.js'
import type {
  Compatibility,
  ManifestContribution,
  PluginManifest,
} from '../../src/kernel/contracts/manifest.js'

/** makeManifest options. */
export interface MakeManifestOptions {
  id: string
  name?: string
  version?: string
  entry?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** What I need (capability declaration). */
  requires?: string[]
  /** What I provide (extension-point contribution). */
  contributes?: ManifestContribution[]
  compatibility?: Partial<Compatibility>
  tags?: string[]
  description?: string
  isolation?: 'in-process' | 'worker'
}

/** Construct a valid PluginManifest. */
export function makeManifest(opts: MakeManifestOptions): PluginManifest {
  const manifest: PluginManifest = {
    id: opts.id,
    name: opts.name ?? opts.id,
    version: opts.version ?? '1.0.0',
    entry: opts.entry ?? 'dist/index.js',
    compatibility: {
      minKernel: opts.compatibility?.minKernel ?? '^1.0.0',
      contractVersion: opts.compatibility?.contractVersion ?? '1',
      ...(opts.compatibility?.maxKernel !== undefined
        ? { maxKernel: opts.compatibility.maxKernel }
        : {}),
    },
  }
  if (opts.dependencies) manifest.dependencies = opts.dependencies
  if (opts.optionalDependencies) {
    manifest.optionalDependencies = opts.optionalDependencies
  }
  if (opts.requires) manifest.requires = opts.requires
  if (opts.contributes) manifest.contributes = opts.contributes
  if (opts.tags) manifest.tags = opts.tags
  if (opts.description) manifest.description = opts.description
  if (opts.isolation) manifest.isolation = opts.isolation
  return manifest
}

/** Construct a Candidate. */
export function makeCandidate(
  opts: MakeManifestOptions & {
    rootDir?: string
    source?: CandidateSource
    legacy?: boolean
  },
): Candidate {
  const source = opts.source ?? 'workspace'
  return {
    manifest: makeManifest(opts),
    rootDir: opts.rootDir ?? `/virtual/${opts.id}`,
    source,
    builtin: source === 'builtin',
    legacy: opts.legacy ?? false,
  }
}
