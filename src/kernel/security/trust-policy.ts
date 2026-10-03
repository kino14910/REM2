/**
 * 信任策略（docs/02 §J.3）。
 *
 * 本期不做签名验证（附录 B #4）：`trusted` 仅按 `source === 'builtin'` 判定；
 * 其余为 `sandboxed`，敏感能力需显式授予。
 */

import type { TrustLevel, TrustPolicy } from '../contracts/permission.js';
import type { CandidateSource } from '../discovery/candidate.js';

/** 默认信任策略。 */
export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  defaults: {
    // 可信（内建）：默认授予常规能力，但 net.listen / fs.write / process.spawn 仍需显式授予。
    trusted: [
      'log.sink',
      'config.provider',
      'metrics.sink',
      'command.provide',
      'health.expose',
      'ui.theme',
    ],
    // 沙箱（用户插件）：默认只授予最小能力。
    sandboxed: ['log.sink'],
  },
  warnOn: {
    trusted: ['net.', 'fs.write', 'process.', 'kernel.'],
    sandboxed: ['net.', 'fs.', 'process.', 'config.', 'command.', 'kernel.'],
  },
};

/**
 * 依据候选来源判定信任级别。
 */
export function trustLevelFor(source: CandidateSource): TrustLevel {
  return source === 'builtin' ? 'trusted' : 'sandboxed';
}

/** 匹配能力是否落在某个前缀集合（支持 'net.' 前缀与精确匹配）。 */
export function matchesAny(
  capability: string,
  patterns: readonly string[],
): boolean {
  for (const p of patterns) {
    if (p.endsWith('*')) {
      if (capability.startsWith(p.slice(0, -1))) return true;
    } else if (p.endsWith('.')) {
      if (capability.startsWith(p)) return true;
    } else if (capability === p || capability.startsWith(`${p}.`)) {
      return true;
    }
  }
  return false;
}
