/**
 * 测试辅助：在临时目录中物化插件（plugin.json + index.js），用于集成测试。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MakeManifestOptions } from './make-manifest.js';
import { makeManifest } from './make-manifest.js';

/** 临时插件目录句柄。 */
export interface TmpPluginsDir {
  /** 根目录（作为 KernelOptions.roots[0]）。 */
  root: string;
  /** 写入一个插件，返回其目录。 */
  writePlugin(
    manifest: MakeManifestOptions,
    entrySource: string,
    entryFileName?: string,
  ): Promise<string>;
  /** 清理。 */
  cleanup(): Promise<void>;
}

/**
 * 创建临时插件根目录。
 */
export async function createTmpPluginsDir(
  prefix = 'rem2-plugins-',
): Promise<TmpPluginsDir> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));

  return {
    root,
    async writePlugin(
      manifestOpts: MakeManifestOptions,
      entrySource: string,
      entryFileName = 'index.js',
    ): Promise<string> {
      const dirName = manifestOpts.id.replace(/[^a-z0-9._-]/gi, '_');
      const pluginDir = path.join(root, dirName);
      await mkdir(path.join(pluginDir, path.dirname(entryFileName)), {
        recursive: true,
      });

      const manifest = makeManifest({ ...manifestOpts, entry: entryFileName });
      await writeFile(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );
      await writeFile(path.join(pluginDir, entryFileName), entrySource, 'utf8');
      return pluginDir;
    },
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}
