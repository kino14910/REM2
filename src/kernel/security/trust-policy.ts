/**
 * Trust policy.
 *
 * Signature verification is out of scope for this iteration: `trusted` is decided
 * solely by `source === 'builtin'`; everything else is `sandboxed`, where sensitive
 * capabilities require explicit grants.
 */

import {
  Capabilities,
  type TrustLevel,
  type TrustPolicy,
} from '../contracts/permission.js'
import type { CandidateSource } from '../discovery/candidate.js'

export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  defaults: {
    // Trusted (builtin): regular capabilities are granted by default, but net.listen / fs.write / process.spawn still require explicit grants.
    trusted: [
      Capabilities.LogSink,
      Capabilities.MetricsSink,
      Capabilities.TraceExporter,
      Capabilities.ConfigProvider,
      Capabilities.CommandProvide,
      Capabilities.HealthExpose,
      Capabilities.UiTheme,
      Capabilities.UiPanel,
      Capabilities.UiRoute,
    ],
    // Sandboxed (user plugins): only the minimal capability is granted by default (log sink only).
    sandboxed: [Capabilities.LogSink],
  },
  warnOn: {
    trusted: ['net.', 'fs.write', 'process.', 'kernel.'],
    sandboxed: [
      'net.',
      'fs.',
      'process.',
      'config.',
      'command.',
      'ui.',
      'kernel.',
    ],
  },
}

export function trustLevelFor(source: CandidateSource): TrustLevel {
  return source === 'builtin' ? 'trusted' : 'sandboxed'
}

export function matchesAny(
  capability: string,
  patterns: readonly string[],
): boolean {
  for (const p of patterns) {
    if (p.endsWith('*')) {
      if (capability.startsWith(p.slice(0, -1))) return true
    } else if (p.endsWith('.')) {
      if (capability.startsWith(p)) return true
    } else if (capability === p || capability.startsWith(`${p}.`)) {
      return true
    }
  }
  return false
}
