/**
 * 插件发现（见 docs/01）。
 *
 * 扫描 roots 目录下的插件子目录，读取并校验 `plugin.json`；
 * 可选旧式 `manifest.json` 兼容（默认关闭，`legacyFallback`）。
 *
 * 零依赖：仅使用 node:fs/promises 与 node:path。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate, CandidateSource } from './candidate.js';
import { validateManifest } from './manifest-validator.js';
import { MANIFEST_FILENAME, LEGACY_MANIFEST_FILENAME } from '../version.js';

/** 发现选项。 */
export interface DiscoverOptions {
  /** 扫描根目录（绝对路径）。 */
  roots: string[];
  /** 是否扫描内建 `plugins/` 目录（映射为 source=builtin）。 */
  builtinRoot?: string;
  /** 是否尝试旧式 manifest.json 兼容。 */
  legacyFallback?: boolean;
  /** 当前工作区插件根（source=workspace）。 */
  workspaceRoot?: string;
}

/** 单个扫描失败记录（不致命）。 */
export interface DiscoverIssue {
  dir: string;
  message: string;
}

/** 发现结果。 */
export interface DiscoverResult {
  candidates: Candidate[];
  issues: DiscoverIssue[];
}

/**
 * 插件发现器。
 */
export class PluginDiscovery {
  private lastCandidates: Candidate[] = [];
  private readonly issues: DiscoverIssue[] = [];
  /**
   * 轻量扫描缓存（docs/09 O17）：key = 根目录 + 根 mtime。
   *
   * 根目录 mtime 会在其下任一子项被增删改时变化，因此它足以作为
   * 「该根下插件集合是否可能变化」的判据 —— 换来的是热重载路径上
   * 避免重复 readdir + 逐个 readFile plugin.json。
   */
  private readonly scanCache = new Map<
    string,
    { rootMtimeMs: number; found: Candidate[] }
  >();

  get candidates(): Candidate[] {
    return this.lastCandidates;
  }

  get issuesReadonly(): ReadonlyArray<DiscoverIssue> {
    return this.issues;
  }

  /**
   * 执行发现。结果按「来源 → id」稳定排序，保证确定性。
   */
  async discover(opts: DiscoverOptions): Promise<Candidate[]> {
    const result = await this.discoverDetailed(opts);
    this.lastCandidates = result.candidates;
    return result.candidates;
  }

  /** 详细版发现（含 issues）。 */
  async discoverDetailed(opts: DiscoverOptions): Promise<DiscoverResult> {
    const collected: Candidate[] = [];
    const issues: DiscoverIssue[] = [];

    const roots: Array<{ dir: string; source: CandidateSource }> = [];
    if (opts.builtinRoot)
      roots.push({ dir: opts.builtinRoot, source: 'builtin' });
    if (opts.workspaceRoot)
      roots.push({ dir: opts.workspaceRoot, source: 'workspace' });
    for (const r of opts.roots) {
      // 显式 roots 默认视为用户插件（除非已由 builtinRoot/workspaceRoot 指定同一路径）
      if (!roots.some((x) => path.resolve(x.dir) === path.resolve(r))) {
        roots.push({ dir: r, source: 'user' });
      }
    }

    for (const { dir, source } of roots) {
      const found = await this.scanRoot(
        dir,
        source,
        !!opts.legacyFallback,
        issues,
      );
      collected.push(...found);
    }

    // 稳定排序：source rank → id
    collected.sort((a, b) => {
      const ra = sourceRank(a.source);
      const rb = sourceRank(b.source);
      if (ra !== rb) return ra - rb;
      return a.manifest.id.localeCompare(b.manifest.id, 'en');
    });

    return { candidates: collected, issues };
  }

  /** 扫描单个根目录（带 mtime 缓存）。 */
  async scanRoot(
    root: string,
    source: CandidateSource,
    legacyFallback: boolean,
    issues: DiscoverIssue[],
  ): Promise<Candidate[]> {
    const out: Candidate[] = [];

    let entries: string[];
    let rootMtimeMs = 0;
    try {
      const st = await stat(root);
      if (!st.isDirectory()) return out;
      rootMtimeMs = st.mtimeMs;
      const cached = this.scanCache.get(root);
      if (cached && cached.rootMtimeMs === rootMtimeMs) {
        // 命中缓存：按当前 source 重标 source 后返回（source 是扫描参数，非缓存内容）。
        for (const c of cached.found) {
          out.push({ ...c, source, builtin: source === 'builtin' });
        }
        return out;
      }
      entries = await readdir(root);
    } catch {
      // 根目录不存在 → 静默跳过（可选根）。
      return out;
    }

    for (const entry of entries.sort((a, b) => a.localeCompare(b, 'en'))) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const dir = path.join(root, entry);

      let dirStat;
      try {
        dirStat = await stat(dir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      const candidate = await this.readManifest(
        dir,
        source,
        legacyFallback,
        issues,
      );
      if (candidate) out.push(candidate);
    }

    this.scanCache.set(root, { rootMtimeMs, found: out.slice() });
    return out;
  }

  /** 清空扫描缓存（测试用；生产路径靠 mtime 自然失效）。 */
  clearCache(): void {
    this.scanCache.clear();
  }

  /** 从插件目录读取清单。 */
  async readManifest(
    dir: string,
    source: CandidateSource,
    legacyFallback: boolean,
    issues: DiscoverIssue[],
  ): Promise<Candidate | null> {
    const primary = path.join(dir, MANIFEST_FILENAME);

    const primaryRaw = await tryReadJson(primary);
    if (primaryRaw.ok) {
      const validation = validateManifest(primaryRaw.value);
      if (!validation.ok || !validation.value) {
        issues.push({
          dir,
          message: `plugin.json 校验失败：${validation.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
        });
        return null;
      }
      return {
        manifest: validation.value,
        rootDir: dir,
        source,
        builtin: source === 'builtin',
        legacy: false,
      };
    }

    // 主清单存在但读取/解析失败 → 记录 issue，不再回退。
    if (primaryRaw.exists) {
      issues.push({
        dir,
        message: `plugin.json 解析失败：${primaryRaw.error}`,
      });
      return null;
    }

    // 旧式兼容
    if (legacyFallback) {
      const legacyPath = path.join(dir, LEGACY_MANIFEST_FILENAME);
      const legacyRaw = await tryReadJson(legacyPath);
      if (legacyRaw.ok) {
        const validation = validateManifest(legacyRaw.value);
        if (!validation.ok || !validation.value) {
          issues.push({
            dir,
            message: `manifest.json 校验失败：${validation.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
          });
          return null;
        }
        return {
          manifest: validation.value,
          rootDir: dir,
          source,
          builtin: source === 'builtin',
          legacy: true,
        };
      }
    }

    return null;
  }

  /** 旧式清单扫描入口（对外保留，见类图）。 */
  async scanLegacyManifests(root: string): Promise<Candidate[]> {
    const issues: DiscoverIssue[] = [];
    return await this.scanRoot(root, 'user', true, issues);
  }
}

function sourceRank(source: CandidateSource): number {
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

interface ReadJsonResult {
  ok: boolean;
  exists: boolean;
  value?: unknown;
  error?: string;
}

async function tryReadJson(file: string): Promise<ReadJsonResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    return { ok: false, exists: false, error: (e as Error).message };
  }
  try {
    const value = JSON.parse(text) as unknown;
    return { ok: true, exists: true, value };
  } catch (e) {
    return { ok: false, exists: true, error: (e as Error).message };
  }
}
