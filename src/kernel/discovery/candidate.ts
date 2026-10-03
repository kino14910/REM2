/**
 * 候选插件模型（docs/02 §D.1）。
 */

import type { PluginManifest } from '../contracts/manifest.js';

/** 候选来源。 */
export type CandidateSource = 'builtin' | 'user' | 'workspace';

/** 插件候选。 */
export interface Candidate {
  manifest: PluginManifest;
  /** 插件根目录（绝对路径）。 */
  rootDir: string;
  source: CandidateSource;
  /** 是否内建（source === 'builtin'）。 */
  builtin: boolean;
  /** 是否来自旧式清单兼容逃生舱。 */
  legacy: boolean;
}

/** 来源优先级（排序键）：builtin(0) < workspace(1) < user(2)。 */
export function sourcePriorityRank(source: CandidateSource): number {
  switch (source) {
    case 'builtin':
      return 0;
    case 'workspace':
      return 1;
    case 'user':
      return 2;
    default:
      return 3;
  }
}
