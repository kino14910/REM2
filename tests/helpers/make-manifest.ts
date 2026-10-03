/**
 * 测试辅助：构造内存中的插件 manifest（无需触碰磁盘）。
 */

import type {
  Candidate,
  CandidateSource,
} from '../../src/kernel/discovery/candidate.js';
import type {
  Compatibility,
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
  capabilities?: string[];
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
    entry: opts.entry ?? 'src/index.ts',
    compatibility: {
      minKernel: opts.compatibility?.minKernel ?? '^1.0.0',
      contractVersion: opts.compatibility?.contractVersion ?? '1',
      ...(opts.compatibility?.maxKernel !== undefined
        ? { maxKernel: opts.compatibility.maxKernel }
        : {}),
    },
  };
  if (opts.dependencies) manifest.dependencies = opts.dependencies;
  if (opts.optionalDependencies)
    manifest.optionalDependencies = opts.optionalDependencies;
  if (opts.capabilities) manifest.capabilities = opts.capabilities;
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
