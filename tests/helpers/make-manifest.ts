/**
 * 测试辅助：构造内存中的插件 manifest（无需触碰磁盘）。
 *
 * 默认 `entry` 改为 `dist/index.js`（唯一形态，docs/06 §7 #7）；
 * `capabilities` 已拆为 `requires`（我需要什么）+ `contributes`（我提供什么）。
 */

import type {
  Candidate,
  CandidateSource,
} from '../../src/kernel/discovery/candidate.js';
import type {
  Compatibility,
  ManifestContribution,
  PluginManifest,
} from '../../src/kernel/contracts/manifest.js';

/** makeManifest 选项。 */
export interface MakeManifestOptions {
  id: string;
  name?: string;
  version?: string;
  entry?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** 我需要什么（能力声明）。 */
  requires?: string[];
  /** 我提供什么（扩展点贡献）。 */
  contributes?: ManifestContribution[];
  compatibility?: Partial<Compatibility>;
  tags?: string[];
  description?: string;
  isolation?: 'in-process' | 'worker';
}

/** 构造一个合法 PluginManifest。 */
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
  };
  if (opts.dependencies) manifest.dependencies = opts.dependencies;
  if (opts.optionalDependencies) {
    manifest.optionalDependencies = opts.optionalDependencies;
  }
  if (opts.requires) manifest.requires = opts.requires;
  if (opts.contributes) manifest.contributes = opts.contributes;
  if (opts.tags) manifest.tags = opts.tags;
  if (opts.description) manifest.description = opts.description;
  if (opts.isolation) manifest.isolation = opts.isolation;
  return manifest;
}

/** 构造 Candidate。 */
export function makeCandidate(
  opts: MakeManifestOptions & {
    rootDir?: string;
    source?: CandidateSource;
    legacy?: boolean;
  },
): Candidate {
  const source = opts.source ?? 'workspace';
  return {
    manifest: makeManifest(opts),
    rootDir: opts.rootDir ?? `/virtual/${opts.id}`,
    source,
    builtin: source === 'builtin',
    legacy: opts.legacy ?? false,
  };
}
