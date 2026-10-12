/**
 * vite 共享配置（`docs/10` 决策 11 / `docs/12` §7.2）：alias 与 build/ssr 策略的**单一来源**。
 *
 * 三个 vite config 与 `vitest.config.ts` 都从这里派生，消除「同一 alias 声明三遍」
 * 的漂移风险（`docs/09` O21）。
 *
 * ★ 注意：`resolve.conditions` **不在**共享段里 —— 它按目标环境分化（Node vs 浏览器），
 * 详见 `KERNEL_RESOLVE` 的注释。
 *
 * ★ 最关键的一项是 `ssr.noExternal: ['rem2-kernel']`：
 * Vite 默认会把裸包名 externalize，于是主进程产物里留下 `require('rem2-kernel')`；
 * 打包态解析到 `exports` 指向的 `.ts` 入口 → `ERR_UNKNOWN_FILE_EXTENSION`。
 * **这个错误只在打包后出现，开发态（内存 bundle）看不出来。**
 */

import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';

/** 内核公共出口的绝对路径（各 config 共用同一个目标）。 */
export const KERNEL_ALIAS = fileURLToPath(
  new URL('./src/kernel/index.ts', import.meta.url),
);

/**
 * 共享的 resolve 段：内核按**源码**处理，`.js` → `.ts` 由 Vite 8 内建回退（E1 实测）。
 *
 * ★ 这里**只有 alias，没有 conditions**。
 * `resolve.conditions` 在 Vite 8 里是**整体替换**而非合并进默认集
 * （`mergeWithDefaultsRecursively`：非对象值直接 `merged[key] = value`），
 * 所以一旦在此声明，renderer 就会丢掉 `DEFAULT_CLIENT_CONDITIONS` 里的 `browser`。
 * 而 `node` 按 Node 规范**隐含 `worker`**，于是 svelte 的 exports 会先命中 `worker` 键
 * → `index-server.js` → `mount()` 抛 `lifecycle_function_unavailable`，renderer 白屏。
 * 条件集按目标环境分化，见 `NODE_CONDITIONS` 与 renderer config。
 */
export const KERNEL_RESOLVE = {
  alias: {
    'rem2-kernel': KERNEL_ALIAS,
  },
} satisfies UserConfig['resolve'];

/**
 * Node 侧（main / preload）的解析条件。
 *
 * 显式写出而非依赖 `DEFAULT_SERVER_CONDITIONS`：内核走 `exports` 条件导出时需要
 * 确定的 Node 语义，不受 Vite 默认值变动影响。
 */
export const NODE_CONDITIONS = ['node', 'import', 'module'];

/** 共享的 build 段。`target` 由各 config 覆盖（main/preload=node20，renderer=chrome120）。 */
export const KERNEL_BUILD = {
  sourcemap: true,
  minify: false,
} satisfies UserConfig['build'];

/** 共享的 ssr 段（main / preload 用）。 */
export const KERNEL_SSR = {
  noExternal: ['rem2-kernel'],
} satisfies UserConfig['ssr'];

/** Node 侧共享片段（main / preload）。 */
export const NODE_SHARED = {
  resolve: {
    ...KERNEL_RESOLVE,
    conditions: NODE_CONDITIONS,
  },
  ssr: KERNEL_SSR,
  build: {
    ...KERNEL_BUILD,
    target: 'node20' as const,
  },
} satisfies UserConfig;
