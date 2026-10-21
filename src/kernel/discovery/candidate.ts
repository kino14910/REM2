import type { PluginManifest } from '../contracts/manifest.js'

export type CandidateSource = 'builtin' | 'user' | 'workspace'

export interface Candidate {
  manifest: PluginManifest
  /** Plugin root directory (absolute path). */
  rootDir: string
  source: CandidateSource
  /** Whether built-in (source === 'builtin'). */
  builtin: boolean
  /** Whether it comes from the legacy manifest compatibility escape hatch. */
  legacy: boolean
}

/** Source priority (sort key): builtin(0) < workspace(1) < user(2). */
export function sourcePriorityRank(source: CandidateSource): number {
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
