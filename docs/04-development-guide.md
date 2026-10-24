# 04 · 开发指南

> 环境、命令、构建与打包规格、扩展流程、排障。架构背景见 [`01-architecture-overview.md`](01-architecture-overview.md)，插件契约见 [`02-plugin-api.md`](02-plugin-api.md)，IPC 见 [`03-frontend-ipc.md`](03-frontend-ipc.md)。
>
> English: [`en/04-development-guide.md`](en/04-development-guide.md)

---

## 1. 环境

| 项       | 要求                                                              |
| -------- | ----------------------------------------------------------------- |
| Node     | >= 20（`package.json` → `engines`）                               |
| pnpm     | >= 9，仓库固定 `pnpm@12.8.1`（Corepack 管理）                     |
| 平台     | Windows / macOS / Linux 均可；Windows 下测试并发必须受限（见 §6） |
| 第三方包 | 只有 devDependencies。`dependencies` 恒为 `{}`（硬红线）          |

```bash
pnpm install
```

---

## 2. 命令矩阵

| 命令                          | 作用                                                               | 何时用                   |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `pnpm dev`                    | 终端形态启动内核（`tsx src/host/cli/run.ts`），`predev` 会先 build | 内核 / 插件开发主形态    |
| `pnpm dev --exit-after-start` | 启动后立刻退出，打印 loadOrder / started / degraded / failed       | 冒烟                     |
| `pnpm dev --log-level debug`  | 调日志级别                                                         | 排查加载 / 生命周期问题  |
| `pnpm start`                  | Electron 桌面应用（`electron-forge start`）                        | 宿主 / 前端 / IPC 开发   |
| `pnpm build`                  | `build:kernel` + `build:plugins`                                   | 改内核或插件后           |
| `pnpm build:kernel`           | `tsc -p tsconfig.build.json` → `dist/kernel/**`                    | 只要 `.d.ts` 或内核产物  |
| `pnpm build:plugins`          | esbuild 逐插件 → `plugins-dist/<id>/dist/index.js`                 | 改插件源码后（**必须**） |
| `pnpm build:renderer`         | 单独构建 renderer                                                  | 调试前端产物             |
| `pnpm typecheck:all`          | `typecheck` + `typecheck:electron` + `typecheck:frontend`          | 提交前                   |
| `pnpm test:run`               | 全量测试（一次）                                                   | 提交前                   |
| `pnpm test:watch`             | 监听模式                                                           | 开发中                   |
| `pnpm lint` / `pnpm lint:fix` | oxlint + oxfmt 检查 / 修复                                         | 提交前                   |
| `pnpm cli scaffold <id>`      | 生成插件骨架                                                       | 新建插件                 |
| `pnpm cli validate <path>`    | 校验 `plugin.json`                                                 | 新建 / 改清单后          |
| `pnpm cli list`               | 列出发现的插件                                                     | 确认发现结果             |
| `pnpm verify:render`          | 用 Electron 离屏跑一次 renderer 验证挂载                           | renderer 白屏时          |
| `pnpm package` / `pnpm make`  | 打包 / 出安装包（`premake` 会先 build）                            | 分发                     |

终态验证基线（当前代码）：

```
pnpm typecheck:all    → 0 错误（3 份 tsconfig）
pnpm test:run         → 41 文件 / 327 用例全绿（约 15s）
pnpm dev --exit-after-start → started=7 failed=0
```

---

## 3. 构建与打包规格

### 3.1 三条产线与产物路径

| 产线 | 输入                                                              | 执行                                     | 输出                                                                                       |
| ---- | ----------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| 内核 | `src/kernel/**`                                                   | `tsc -p tsconfig.build.json`             | `dist/kernel/**`（`.js` + `.d.ts` + `.map`）                                               |
| 插件 | `plugins/<id>/src/index.ts`                                       | `esbuild`（`scripts/build-plugins.mjs`） | `plugins-dist/<id>/{dist/index.js, plugin.json, package.json}`                             |
| 外壳 | `src/main.ts` / `src/preload.ts` / `src/frontend/entry-client.ts` | forge 的 VitePlugin                      | `.vite/build/main.cjs`、`.vite/build/preload.cjs`、`.vite/renderer/main_window/index.html` |

打包（`electron-forge package`）：

```
.vite/build + .vite/renderer  →  app.asar（OnlyLoadAppFromAsar=true）
plugins-dist                  →  resources/plugins-dist/（extraResource，★ asar 之外）
```

### 3.2 「产物 ↔ 路径 ↔ 解析规则」对照

| 产物                 | 磁盘位置                                | 谁解析                                                     | 解析规则 / 约束                                                                |
| -------------------- | --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 内核库               | `dist/kernel/index.js` + `.d.ts`        | `package.json` → `exports["."]`                            | `types` → `.d.ts`，`default` → `.js`。`./src` 子路径导出仅供本仓库开发期使用   |
| 内核（开发期裸包名） | `src/kernel/index.ts`                   | `package.json` → `imports` + tsconfig `paths` + vite alias | 三处必须指向同一文件；插件 tsconfig 的 `paths` 单独声明一次                    |
| 插件入口             | `plugins-dist/<id>/dist/index.js`       | 内核 `loader` 的 `import()`                                | `entry` 恒为 `dist/index.js`；只允许 `.js` / `.mjs`；`assertInsideRoot` 防逃逸 |
| 主进程               | `.vite/build/main.cjs`                  | `package.json` → `main`                                    | CJS；`import.meta.url` 为 `undefined`，路径解析要回退 `__dirname`              |
| preload              | `.vite/build/preload.cjs`               | `host/electron/window.ts` 硬编码文件名                     | 必须是 CJS 且必须叫 `preload.cjs`                                              |
| renderer             | `.vite/renderer/main_window/index.html` | `window.ts` 的 `loadFile`                                  | 目录名来自渲染进程名大写化（`MAIN_WINDOW_VITE_NAME`）                          |
| 插件（打包态）       | `resources/plugins-dist/`               | `builtinPluginsRoot()`                                     | `extraResource` 目标名取路径末段，**不是** `rem2-plugins/`                     |

### 3.3 tsconfig 职责

五份配置 = 一份基线 + 三份特化 + 一份转发壳，`strict` / `noUnused*` 全局一致。

| 配置                     | `include`                                                                                 | `lib` / `types`                                      | `moduleResolution` | 为什么这样切                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.json`（基线）  | `src/kernel/**`、`src/host/{cli,ipc}/**`、`plugins/*/src/**`、`tests/**`、`*.ts`、`*.mts` | `ESNext` + `types: ["node"]`                         | `NodeNext`         | 内核与 CLI / IPC 是纯 Node 库，不需要 DOM；同时覆盖插件与测试，保证三者对同一份契约的类型判断一致                                                           |
| `tsconfig.electron.json` | `src/{main,preload}.ts`、`src/host/electron/**`、`src/declarations.d.ts`                  | `ESNext` + `DOM` + `DOM.Iterable`，`types: ["node"]` | `NodeNext`（继承） | 主进程与 preload 需要 DOM（`BrowserWindow`）与 node 同时在场                                                                                                |
| `tsconfig.frontend.json` | `src/frontend/**`、`src/declarations.d.ts`                                                | `ESNext` + `DOM`，**`types: []`**                    | **`Bundler`**      | ① 刻意不给 node 类型：renderer 在 `contextIsolation + sandbox` 下本就无 Node 能力，把约束落到类型层；② `Bundler` 是 svelte 插件解析 `./X.svelte` 的必要条件 |
| `tsconfig.build.json`    | 仅 `src/kernel/**`                                                                        | 同基线                                               | `NodeNext`         | **唯一 `noEmit: false`**：`declaration: true` + `outDir: dist` + `rootDir: src`；host 与 frontend 不进 dist                                                 |
| `tsconfig.shell.json`    | —                                                                                         | —                                                    | —                  | 转发壳（`extends: ./tsconfig.electron.json`），保留是为了不破坏既有验收脚本                                                                                 |

插件侧 `plugins/*/tsconfig.json` 独立，只声明 `paths: { "rem2-kernel": ["../../src/kernel/index.ts"] }`，不继承根配置。

### 3.4 构建期红线

1. `ssr.noExternal: ['rem2-kernel']` 缺失 → 主进程产物留下 `require('rem2-kernel')`，打包态解析到 `.ts` → `ERR_UNKNOWN_FILE_EXTENSION`。**这个错误只在打包后出现。**
2. renderer 的 `resolve.conditions` 缺 `browser` → 解析到 svelte 的 `index-server.js` → 白屏。
3. `index.html` 的入口必须是 `/src/frontend/entry-client.ts`；`index.html` 里不得写内联样式。
4. 改渲染进程名 → 必须同步 `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` 的常量名。
5. 插件 `entry` 不得指回 `src/index.ts`：运行期 `import()` 不认 `.js` → `.ts` 映射，且根目录指错会让全部插件以「模块解析失败」Failed。

---

## 4. 扩展流程

### 4.1 新增插件

```bash
pnpm cli scaffold com.example.my-plugin
# 写 plugins/my-plugin/src/index.ts（见 02）
pnpm build:plugins
pnpm cli validate plugins/my-plugin/plugin.json
pnpm dev --exit-after-start
```

不需要改内核 / 宿主 / 前端任何文件。若必须改，说明这项能力没被建模成扩展点 —— 补扩展点，别开特例。

### 4.2 新增扩展点 / 新增 IPC 方法

见 [`01-architecture-overview.md`](01-architecture-overview.md) §10。两处强制点：`tests/contract/extension-points.test.ts` 的 `EXPECTED_IDS`、`Record<AllowedMethod, …>` / `Record<AllowedEvent, …>` 的键齐全 —— 漏一个即编译或测试报错。

### 4.3 提交前检查

```bash
pnpm lint
pnpm typecheck:all
pnpm test:run
pnpm dev --exit-after-start
```

---

## 5. 调试

| 场景                  | 手段                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内核加载了什么        | `pnpm dev`，看 `loadOrder` / `started` / `degraded` / `failed` 三段输出                                                                                                                                     |
| 插件为什么 Failed     | 提高日志级别 `--log-level debug`；错误落在 `KernelStartResult` 的 `failed[].error`                                                                                                                          |
| 生命周期 / 依赖问题   | `tests/unit/lifecycle.test.ts` 与 `tests/unit/resolver-boundary.test.ts` 是行为规格，先读测试再看代码                                                                                                       |
| 命令无响应            | ① 白名单是否含该方法（`src/shared/ipc-contract.ts`）② 是否有插件向 `command.provide` 贡献且 contributionId 与命令名一致（内核 `CommandDispatcher` 按 id 查槽，未命中返回 `unknown command`）③ 见 §6 第 3 条 |
| 主题不生效            | ① 插件是否 contribute 了 `ui.theme` ② `ui.theme.list` 是否返回非空 ③ 页面底色是否被内联样式压过                                                                                                             |
| renderer 白屏         | `pnpm verify:render`；再查 §3.4 第 2 条与 CSP 告警                                                                                                                                                          |
| Electron 主进程无日志 | Windows GUI 子系统抓不到 stdout。诊断手法：在 `startKernel()` 里把 health 结果 `fs.writeFileSync` 到临时文件再看                                                                                            |
| 打包后插件找不到      | 确认 `resources/plugins-dist/` 是否落盘，以及 `builtinPluginsRoot()` 的优先级                                                                                                                               |

---

## 6. 已知坑

1. **vitest 并发必须受限**（`vitest.config.ts`：`maxWorkers: 4` + `testTimeout/hookTimeout`）。默认并发（= CPU 核数）会让重型集成测试互相饿死，表现为 `Hook timed out` —— 不是真实缺陷。
2. **`electron-forge start` 会删 `.vite`**。本机 safe-delete shim 会 FAIL_CLOSED 中止，先 `rm -rf .vite`（Git Bash 的 `rm` 可用）。
3. **`command.execute` 的宿主实现必须是 `null`**。分发只走内核 `CommandDispatcher`（`start()` 开头注册，直读 `command.provide` 槽，不请求同名 topic，结构上不可能递归）。宿主若注册同名 topic 的转发 responder，`Topics.CommandExecute` 的值就是 `'command.execute'`，请求会命中自己 → 无限递归 `RangeError`。触发前提是宿主在 `kernel.start()` **之前**注册（seq 更小，`pickResponder` 优先）。回归哨兵在 `tests/integration/command-chain.test.ts`。
4. **跑 GUI 前 `unset ELECTRON_RUN_AS_NODE`**，否则 electron 退化成纯 node。
5. **验收多文件产物先清空输出目录**，同时核对文件名 + 体积 + `index.html` 引用。同 hash 的陈旧产物会被误判为成功。
6. **`grep -c pattern *.js` 是逐文件输出**，不会因为某个文件干净就整体变 0。
7. **内核零依赖红线由 `tests/contract/kernel-deps.test.ts` 硬断言**，因此 `tsx` 必须留在 devDependencies；提进 `dependencies` 立即变红。
8. **`git reset` 后大面积 modified 但 `git diff --cached` 为空**，是 racily-clean 伪差异（索引与 mtime 同秒），`git add -A <dir>` 刷新即可，别误判成丢改动。
9. **打包链路已实机验证（2026-10-24）**：`pnpm package` 完整跑通；Windows 上 squirrel maker 产出 `Setup.exe` 且包内 `resources/plugins-dist/` 齐全（deb/rpm maker 仅 Linux 可用，属平台限制）。若 `out/` 内残留被其他进程占用的文件，packager 的清理步骤会被本机 safe-delete shim FAIL_CLOSED 阻断（报 `trash` 失败）——先清空 `out/` 再跑 `package` / `make`。
10. **Node 原生 TS 支持（strip-only）不能用于插件**：不支持参数属性（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），也不把 `.js` 说明符重映射到 `.ts`（`ERR_MODULE_NOT_FOUND`）。改插件修不好，只能预编译。
11. **`REM2_DISABLE_GPU=1` 必须与 `--no-sandbox` 配套**（`main.ts` 里两者同属该 opt-in 块）。无 GPU / 虚拟化主机上 Chromium 进程沙箱的虚拟化后端同样失败（`Failed to create shared context for virtualization`），只禁 GPU 不禁沙箱会让每个渲染进程访问冲突崩溃：症状是**空白窗口** + `render-process-gone` (crashed) + `loadFile` 报 `ERR_FAILED`。判据：`scripts/verify-render.cjs` 的 5 开关组合含 `--no-sandbox` 所以能渲染，而漏掉它的 4 开关组合必崩。

---

## 7. 代码约定

| 约定              | 内容                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| 语言 / 模块       | TypeScript strict + Node ESM；源码里相对导入写 `.js` 后缀（指向 `.ts` 文件）             |
| 风格              | 不加分号，单引号（oxfmt 强制）                                                           |
| 注释              | 只写代码无法直观表达的意图与陷阱，不写模块说明式大段注释                                 |
| 内核依赖          | `src/kernel/**` 只用 `node:` 内置与相对导入；不得 import `host` / `frontend` / `plugins` |
| 契约先行          | `contracts/*` 是纯类型与纯函数，不含逻辑、不含 IO                                        |
| topic 与 IPC 名字 | 一律引用常量（`Topics` / `channels` / `events`），禁止手抄字符串                         |
| 新增判据          | 断言「违例为空」的测试必须配元测试证明它能失败，否则红线会静默失效                       |
| 文档              | 引用符号名而不是行号；行号只在「撰写时快照」语境下出现                                   |
