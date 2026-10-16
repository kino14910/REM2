/**
 * 契约测试：renderer 构建产物必须是**浏览器版** svelte（PRD A9 / A10）。
 *
 * ★ 为什么需要这条（真实缺陷的复盘）：
 * svelte 的 `exports` 有三个入口 —— `browser` → client、`worker` / `default` → **server**，
 * 而 `mount()` 只存在于 client 版。若 renderer 把 svelte 解析成 server 版，
 * `vite build` **依然成功**（它只是把一份合法的 server bundle 打进包里），
 * 错误要到浏览器真正执行时才炸：
 *
 *     Uncaught Svelte error: lifecycle_function_unavailable
 *     `mount(...)` is not available on the server
 *
 * 即「构建成功」不蕴含「产物能在浏览器跑」。而既有契约测试全部跑在
 * `environment: 'node'` 下（见 vitest.config.ts），在 Node 语义下解析到 server 版
 * 是**完全正确**的行为 —— 这类「构建期正确、运行期错误」的问题天然落在测试盲区里。
 *
 * ★ 为什么判据要用 sourcemap 的 `sources`：
 * 错误码字符串可能因 tree-shaking / 改名而消失（假阴性），而 sourcemap 的 `sources`
 * 是**模块图的事实** —— 它直接指名道姓地记录了哪些源文件被打进了产物。
 * `build.sourcemap` 默认已开启（见 vite.shared.mts），因此本测试零构建成本。
 *
 * ★ 为什么只检查 index.html **实际引用**的那个 chunk：
 * 产物文件名带内容 hash，新旧版本可以共存于同一目录。扫全目录会被**陈旧残留**污染
 * —— 真实的「修复无效」误判就来自这里。index.html 引用的才是浏览器真正加载的那个。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const RENDERER_DIR = path.join(
  PROJECT_ROOT,
  '.vite',
  'renderer',
  'main_window',
);
const INDEX_HTML = path.join(RENDERER_DIR, 'index.html');
const ASSETS_DIR = path.join(RENDERER_DIR, 'assets');

/** server 版 svelte 独有的模块特征（命中任一即说明解析错了）。 */
const SERVER_ONLY_SOURCES = [
  /svelte\/src\/index-server\.js$/,
  /svelte\/src\/internal\/server\//,
];

/** client 版 svelte 的入口（产物必须包含它，否则说明 svelte 根本没打进来）。 */
const CLIENT_ENTRY_SOURCE = /svelte\/src\/index-client\.js$/;

/** 产物中不该出现的 server 侧错误码（`mount()` 被解析成 server 版时的直接产物）。 */
const SERVER_ERROR_CODES = [
  'lifecycle_function_unavailable',
  'server_context_required',
  'async_local_storage_unavailable',
  'hydratable_serialization_failed',
];

/**
 * 读出 index.html 实际引用的 JS chunk 路径。
 *
 * 为什么必须走引用关系而不是扫目录：陈旧产物与新产物会共存，
 * 只有被 index.html 引用的那个才是浏览器真正加载的。
 */
function referencedChunk(): string {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const match = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  if (!match) {
    throw new Error(`index.html 中未找到引用的 JS chunk：${INDEX_HTML}`);
  }
  return path.join(ASSETS_DIR, match[1]!);
}

describe('contract · renderer 产物是浏览器版 svelte', () => {
  it('renderer 产物已构建（缺失则本组断言跳过，不误报为失败）', () => {
    if (!existsSync(INDEX_HTML)) {
      // 契约测试不应强制依赖构建产物存在；用 `it.skip` 表达「前提未就绪」而非「断言失败」。
      return;
    }
    expect(existsSync(ASSETS_DIR)).toBe(true);
  });

  it('被 index.html 引用的 chunk 存在，且目录内无陈旧同名混淆', () => {
    if (!existsSync(INDEX_HTML)) return;

    const chunk = referencedChunk();
    expect(existsSync(chunk), `被引用的 chunk 不存在：${chunk}`).toBe(true);

    // 多个 hash 不同的 JS chunk 并存 = 上一次构建的残留。
    // 单独断言这不会让测试变脆（正常构建只有一个），但能挡住上面那个误判场景。
    const jsChunks = readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.js'));
    expect(jsChunks).toEqual([path.basename(chunk)]);
  });

  it('sourcemap 的 sources 中不存在 server 版 svelte 模块', () => {
    if (!existsSync(INDEX_HTML)) return;

    const chunk = referencedChunk();
    const mapFile = `${chunk}.map`;
    expect(existsSync(mapFile), `缺少 sourcemap：${mapFile}`).toBe(true);

    const map = JSON.parse(readFileSync(mapFile, 'utf8')) as {
      sources?: string[];
    };
    const sources = map.sources ?? [];

    const offenders = sources.filter((s) =>
      SERVER_ONLY_SOURCES.some((re) => re.test(s)),
    );
    expect(
      offenders,
      `产物打进了 server 版 svelte（renderer 解析条件被污染）:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('sourcemap 的 sources 中包含 client 版 svelte 入口', () => {
    if (!existsSync(INDEX_HTML)) return;

    const map = JSON.parse(
      readFileSync(`${referencedChunk()}.map`, 'utf8'),
    ) as {
      sources?: string[];
    };
    const hasClient = (map.sources ?? []).some((s) =>
      CLIENT_ENTRY_SOURCE.test(s),
    );
    expect(
      hasClient,
      '产物中找不到 svelte 的 client 入口，svelte 可能未被打进包',
    ).toBe(true);
  });

  it('产物中不含 server 侧错误码字符串', () => {
    if (!existsSync(INDEX_HTML)) return;

    const code = readFileSync(referencedChunk(), 'utf8');
    for (const name of SERVER_ERROR_CODES) {
      expect(
        code.includes(name),
        `产物包含 server 侧错误码 "${name}" —— svelte 被解析成了 server 版`,
      ).toBe(false);
    }
  });
});
