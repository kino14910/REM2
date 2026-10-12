/**
 * renderer 白屏验证脚本：用真实 Electron 加载**构建产物**，
 * 抓 renderer console 输出与 #app 的实际 DOM，直接证伪/证实「白屏」。
 *
 * 用途（勿删）：`tests/contract/build-artifact.test.ts` 只做**静态**判据
 * （sourcemap 里不含 server 版 svelte），成本低、可进 CI，但无法证明
 * 「真的渲染出来了」。本脚本补上运行期这一环。
 * 两者互补：静态判据防回归，本脚本证最终结果。
 *
 * 前置：`pnpm build:renderer`（产物需已生成）。
 * 用法：unset ELECTRON_RUN_AS_NODE && pnpm verify:render
 *
 * 本机踩过的环境坑（都已处理）：
 *   1. 必须 .cjs —— electron 主进程内置模块只在 CJS 入口注入，
 *      ESM 入口里 require('electron') 拿到的是路径字符串。
 *   2. 必须 unset ELECTRON_RUN_AS_NODE —— 本机设了它，electron 会退化成普通 node。
 *   3. 必须关 GPU —— 否则 "GPU process isn't usable. Goodbye." 直接 FATAL 退出；
 *      只调 disableHardwareAcceleration() 不够，要配commandLine 开关。
 *   4. 产物 html 用的是**绝对路径** /assets/...，file:// 下解析不到会 ERR_FAILED；
 *      故复制到临时目录并改写成相对路径。
 *
 * ⚠️ headless CI 上会失败（需要桌面会话与 GPU）。CI 场景请依赖
 * tests/contract/build-artifact.test.ts 的静态判据。
 *
 * 判据：console 出现 lifecycle_function_unavailable 或 #app 子节点数为 0 → 白屏。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve('.vite/renderer/main_window');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');

const errors = [];
const logs = [];

/** 把产物复制到临时目录并把 /assets/... 改写为 ./assets/...，供 file:// 加载。 */
function stageBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem2-verify-'));
  fs.cpSync(ROOT, dir, { recursive: true });
  const htmlPath = path.join(dir, 'index.html');
  const html = fs
    .readFileSync(htmlPath, 'utf8')
    .replace(/(src|href)="\/(?!\/)/g, '$1="./');
  fs.writeFileSync(htmlPath, html);
  return dir;
}

/**
 * 只检查 index.html **实际引用**的那个 chunk。
 *
 * 为什么要逐文件：vite 的 outDir 里可能残留**上一次构建的旧 chunk**（文件名带内容 hash），
 * 而 index.html 只引用其中一个。`grep -c pattern *.js` 会把所有文件一起数进来，
 * 于是「一个干净、一个陈旧」会被读成「修复失败」—— 实际运行时加载的可能一直是干净的那个。
 * 反过来若index.html 引用的正是陈旧那个，才是真的坏了。
 */
function assertReferencedChunkIsClean(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+\.js)"/g)].map((m) => m[1]);
  if (refs.length === 0) {
    console.log('⚠ index.html 未引用任何 js chunk，跳过静态判据');
    return true;
  }
  const chunks = fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js'));
  let clean = true;
  for (const f of chunks) {
    const code = fs.readFileSync(path.join(dir, 'assets', f), 'utf8');
    const isServer = code.includes('index-server') || code.includes('lifecycle_function_unavailable');
    const isReferenced = refs.includes(`assets/${f}`);
    const tag = isReferenced ? '← index.html 正在加载' : '（陈旧残留，未被引用）';
    console.log(
      `  ${f}: ${isServer ? '❌含 server 版 svelte' : '✅ client 版'}  ${tag}`,
    );
    // 只有「被引用 且 含 server 特征」才算真的坏了。
    if (isReferenced && isServer) clean = false;
  }
  return clean;
}

app.whenReady().then(async () => {
  const dir = stageBuild();
  const page = `file:///${path.join(dir, 'index.html').replace(/\\/g, '/')}`;

  console.log('=== 静态判据：逐个 chunk 检查（只认index.html 实际引用的那个）===');
  const staticOk = assertReferencedChunkIsClean(dir);
  if (!staticOk) console.log('❌ 被引用的 chunk 含 server 版 svelte');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    logs.push(message);
    if (level >= 2) errors.push(`[level=${level}] ${message}`); // 2=warning 3=error
  });
  win.webContents.on('render-process-gone', (_e, d) =>
    errors.push('render-process-gone: ' + d.reason),
  );
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    errors.push(`did-fail-load code=${code} desc=${desc} url=${url}`),
  );

  try {
    await win.loadURL(page);
  } catch (e) {
    console.log('loadURL 抛错:', e.message);
  }
  await new Promise((r) => setTimeout(r, 4000)); // 等挂载与首屏渲染

  let probe;
  try {
    probe = await Promise.race([
      win.webContents.executeJavaScript(`
        (() => {
          const el = document.getElementById('app');
          return {
            exists: !!el,
            childCount: el ? el.children.length : 0,
            html: el ? el.innerHTML.slice(0, 300) : '',
            textLen: el ? el.innerText.trim().length : 0,
            title: document.title,
          };
        })()
      `),
      new Promise((_, rej) => setTimeout(() => rej(new Error('executeJavaScript 超时')), 15000)),
    ]);
  } catch (e) {
    probe = { error: e.message };
  }

  console.log('=== renderer console (warning/error) ===');
  console.log(errors.length ? errors.join('\n') : '(无)');
  console.log('=== 挂载结果 ===');
  console.log(JSON.stringify(probe, null, 2));
  const lifecycle = logs.filter((l) => l.includes('lifecycle_function_unavailable')).length;
  console.log('=== 判定 ===');
  console.log('lifecycle_function_unavailable 次数:', lifecycle);
  // 运行时判据与静态判据都要过：静态抓「被引用的 chunk 是 server 版」，
  // 运行时抓「真的抛错/白屏」，两者互为补充。
  const ok = probe && probe.childCount > 0 && lifecycle === 0 && staticOk;
  console.log(ok ? '✅ 渲染成功，非白屏' : '❌ 仍然白屏');

  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
});