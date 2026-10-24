<a href="./README.md">English</a>

# rem2 — 极小内核 + 一切皆插件

> **Kernel + Everything-as-Plugin** 的独立从零实现。
> 内核只做 7 件事，其余一切（日志、配置、业务、运维、UI）都是插件。

[![tests](https://img.shields.io/badge/tests-327%20passing-brightgreen)](#测试)
[![kernel deps](https://img.shields.io/badge/kernel%20deps-0-blue)](#内核边界)
[![typescript](https://img.shields.io/badge/TypeScript-strict-blue)](#)

---

## 这是什么

一个**插件优先（plugin-first）**的运行时内核。与常见"宿主 + 扩展"架构不同，这里**内核不持有任何业务能力**——连依赖解析器和调度器都可以被插件替换。

| 内核职责（只有这 7 件） | 不是内核的事      |
| ----------------------- | ----------------- |
| Bootstrap 引导          | 解析业务配置      |
| Discovery 发现          | 认识任何具体插件  |
| Load / Unload           | 内置日志/指标落地 |
| Lifecycle 编排          | 实现任何业务能力  |
| 依赖解析                | 假设依赖图结构    |
| 核心抽象 / 契约         | 含业务类型        |
| 最小共享设施            | 含 UI             |

**验收判据**：新增任何能力都不需要修改 `src/kernel/**`。

---

## 快速开始

本项目有**两种运行形态**：终端内核（主形态）与可选的 Electron 桌面外壳。

### 一、终端内核（推荐先跑这个）

```bash
pnpm install

# 启动内核（tsx 直跑 TS，无需构建）
pnpm dev

# 冒烟：启动后立即退出
pnpm dev --exit-after-start

# 调试日志
pnpm dev --log-level debug
```

预期输出：

```
──── rem2 kernel started ────
loadOrder : com.rem2.config-json -> com.rem2.hello-command -> com.rem2.logger-console -> com.rem2.health-http -> com.rem2.notify-worker -> com.rem2.plugin-inspector -> com.rem2.theme-dark
started   : com.rem2.config-json, com.rem2.hello-command, com.rem2.logger-console, com.rem2.health-http, com.rem2.notify-worker, com.rem2.plugin-inspector, com.rem2.theme-dark
degraded  : (none)
failed    : (none)
health    : healthy
  - com.rem2.config-json [Active] healthy
  - com.rem2.health-http [Active] healthy
  - com.rem2.hello-command [Active] healthy
  - com.rem2.logger-console [Active] healthy
  - com.rem2.notify-worker [Active] healthy
  - com.rem2.plugin-inspector [Active] healthy
  - com.rem2.theme-dark [Active] healthy
─────────────────────────────
```

### 二、Electron 桌面外壳（可选）

外壳是**插件载体**，内核不依赖它。它会把内核当库启动，并提供一个命令输入框。

```bash
# 打开桌面应用（开发模式，带热重载）
pnpm start
```

窗口里输入命令（默认 `hello`）点「执行」，命令会经 IPC 桥转发到内核事件总线。

> **为什么宿主用 tsx 跑 TypeScript**：宿主自身的入口（终端形态 `src/host/cli/run.ts`、桌面外壳 `src/host/electron/main.ts`）用 TypeScript 编写，开发期由 tsx 直接执行。但**插件运行时并不以原始 `.ts` 加载**——每个插件已由 esbuild 预编译为自包含 ESM bundle，落在 `dist/index.js`（及 `plugins-dist/<id>/dist/index.js`），内核用动态 `import()` 加载。`tsx` 属 `devDependencies`：内核与 `dependencies` 仍零第三方依赖。打包产物若需加载 `.ts` 插件，需自行把 tsx 提为运行时依赖。

> **无 GPU / 虚拟机 / 远程桌面环境**：Chromium 的 GPU 进程可能崩溃
> （`GPU process isn't usable. Goodbye.`），此时关闭硬件加速再启动：
>
> ```bash
> # Git Bash / macOS / Linux
> REM2_DISABLE_GPU=1 pnpm start
> ```
>
> ```powershell
> # Windows PowerShell
> $env:REM2_DISABLE_GPU=1; pnpm start
> ```
>
> 默认不开启，以免影响正常机器上的渲染性能。
>
> 该 opt-in 路径会一并禁用 Chromium **进程沙箱**（`--no-sandbox`）：此类主机上沙箱的虚拟化后端同样失败
> （`Failed to create shared context for virtualization`），每个渲染进程都会以访问冲突崩溃——表现为空白窗口，
> `loadFile` 随后报 ERR_FAILED。仅该 opt-in 路径被削弱；默认启动保留进程沙箱，renderer 仍运行在
> `contextIsolation` + IPC 白名单 + 内核 CapabilityGuard 之下。

> 打包安装包：`pnpm package`（产出可执行目录）/ `pnpm make`（产出安装器）。

---

## 开发者 CLI

```bash
pnpm cli scaffold com.example.my-plugin --name "My Plugin"   # 生成插件骨架
pnpm cli validate plugins/my-plugin                          # 校验 manifest
pnpm cli validate plugins                                    # 批量校验
pnpm cli list                                                # 列出内建插件
```

---

## 写一个插件

```ts
// plugins/com.example.my-plugin/src/index.ts
import { definePlugin } from 'rem2-kernel'
import type { PluginContext } from 'rem2-kernel'

export default definePlugin(
  {
    id: 'com.example.my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    entry: 'dist/index.js',
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
  },
  (ctx: PluginContext) => {
    return {
      async onStart(): Promise<void> {
        ctx.log.info('started')
      },
    }
  },
)
```

```json
// plugins/com.example.my-plugin/plugin.json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "entry": "dist/index.js",
  "compatibility": { "minKernel": "^1.0.0", "contractVersion": "1" }
}
```

7 阶段生命周期（全部可选）：`onDiscover` → `onLoad` → `onConfigure` → `onStart` → `onStop` → `onUnload` → `onDispose`

完整 API 参考见 **[docs/02-plugin-api.md](docs/02-plugin-api.md)**（英文版：
**[docs/en/02-plugin-api.md](docs/en/02-plugin-api.md)**）。

---

## 示例插件（7 类扩展点）

| 插件                                           | 证明什么                                                                | 依赖                  |
| ---------------------------------------------- | ----------------------------------------------------------------------- | --------------------- |
| [`logger-console`](plugins/logger-console)     | **可观测性是插件** — 提供 `log.sink`                                    | —                     |
| [`config-json`](plugins/config-json)           | **配置来源是插件** — 提供 `config.provider`                             | —                     |
| [`hello-command`](plugins/hello-command)       | **业务功能是插件** — 提供 `command.provide`                             | 软依赖 config-json    |
| [`health-http`](plugins/health-http)           | **运维是插件** — 暴露 `/health` 端点                                    | 硬依赖 logger-console |
| [`theme-dark`](plugins/theme-dark)             | **UI 是插件** — 无 UI 外壳时优雅降级                                    | —                     |
| [`plugin-inspector`](plugins/plugin-inspector) | **检查器自身也是插件** — 贡献 `ui.panel` + `ui.route`，提供实时插件表格 | —                     |
| [`notify-worker`](plugins/notify-worker)       | **Worker 线程隔离** — 崩溃不影响内核（故障隔离）                        | —                     |

---

## 内核边界

内核**零第三方运行时依赖**，只用 4 个 Node 内置模块：

```
$ grep -rhoP "from '\K[^']+" src/kernel --include=*.ts | grep -v "^\.\|^node:" | sort -u
（空）
```

用到的内置模块：`node:fs` · `node:fs/promises` · `node:path` · `node:url`

插件**只能**从公共出口 `rem2-kernel` 导入，禁止深链 `src/kernel/**` 内部实现——由契约测试强制。

---

## 测试

```bash
pnpm test:run        # 全量测试
pnpm test:coverage   # 覆盖率
pnpm typecheck:all   # 内核 + Electron + 前端三份类型检查
```

| 层次     | 文件数                 | 覆盖内容                                                                                                                                       |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元     | 19                     | semver / 拓扑排序 / 环检测 / DI 容器 / 容器隔离 / 事件总线 / 生命周期 / manifest 校验 / 权限 / 配置服务 / 健康服务 / **命令分发器** / **DTO 校验** / **路由→面板决议** / **插件根路径解析** |
| 集成     | 17                     | 启动顺序 / 软依赖降级 / 硬依赖级联 / 故障隔离 / 配置插件 / 可观测性 / 热重载 / 卸载级联 / 安全边界 / Worker 隔离 / **命令链路** / **主题链路** / **UI 链路** / **inspector 数据链** |
| 契约     | 5                      | 插件导入边界 / 内核依赖白名单 / 扩展点清单一致性 / **构建产物为浏览器版 svelte** / **IPC 白名单与内核 Topics 一致**                            |
| **合计** | **41 文件 / 327 用例** |                                                                                                                                                |

---

## 文档

文档按**阅读顺序**编号（`01` 最先读），完整索引见 **[docs/INDEX.md](docs/INDEX.md)**（英文索引：**[docs/en/INDEX.md](docs/en/INDEX.md)**）。

| #   | 文档                                                                | 内容                                                                                                                                                  |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | **[docs/INDEX.md](docs/INDEX.md)**                                  | **文档索引与阅读路径**（从这里开始）                                                                                                                  |
| 01  | **[01-architecture-overview.md](docs/01-architecture-overview.md)** | **架构（权威）**：分层与依赖方向、全量文件职责、生命周期两层模型、12 个扩展点、隔离与权限、调用链路、数据通路、构建产物、9 条决策、扩展流程、已知限制 |
| 02  | **[02-plugin-api.md](docs/02-plugin-api.md)**                       | **插件开发指南**：`definePlugin`、`plugin.json` 字段、生命周期钩子、`PluginContext`、扩展点表、服务令牌、命令链路、隔离模式、错误码                   |
| 03  | **[03-frontend-ipc.md](docs/03-frontend-ipc.md)**                   | **前端与 IPC 契约**：进程/构建边界、8 方法 + 5 事件白名单、DTO、store↔事件桥、主题通路、vite/CSP 约束                                                 |
| 04  | **[04-development-guide.md](docs/04-development-guide.md)**         | **开发指南**：环境、命令矩阵、构建与打包规格、tsconfig 边界、扩展流程、调试、已知坑、代码约定                                                         |

架构图：[class-diagram-v2.mermaid](docs/class-diagram-v2.mermaid) · [sequence-diagram-v2.mermaid](docs/sequence-diagram-v2.mermaid)
（英文架构图：[docs/en/class-diagram-v2.mermaid](docs/en/class-diagram-v2.mermaid) · [docs/en/sequence-diagram-v2.mermaid](docs/en/sequence-diagram-v2.mermaid)）。

---

## 目录结构

```
src/
├── kernel/               # 极小内核（零第三方运行时依赖，契约测试硬断言）
│   ├── contracts/        # 纯类型契约 + defineToken / definePlugin 工厂
│   ├── extensions/       # 12 个扩展点的声明与槽位（唯一挂载面）
│   ├── di/               # DI 容器（父引用藏模块私有 WeakMap）
│   ├── discovery/        # 候选发现 + manifest 校验
│   ├── dependency/       # 依赖图 / 拓扑排序 / 环检测
│   ├── lifecycle/        # 阶段定义 + 管理器 + 物理管线 + 回滚
│   ├── loader/           # 动态 import（唯一 definePlugin 形态）
│   ├── isolation/        # Worker 故障隔离（RPC 白名单）
│   ├── security/         # 权限 + 能力守卫
│   ├── observability/    # 日志 / 指标 / 追踪 / 健康 + 扩展点 sink（宿主默认实现）
│   ├── config/           # 配置服务（provider 可插拔）
│   ├── events/           # 事件总线（通配 + RPC）
│   ├── scheduler/        # 调度器（可被插件替换）
│   ├── semver/           # 独立实现的 semver
│   ├── bootstrap/        # 内核选项与核心服务注册
│   ├── registry/         # 插件注册表
│   ├── context/          # PluginContext 与 PluginApi 构造
│   ├── util/
│   ├── composition.ts    # KernelDeps 唯一装配点（Kernel 不 new 实现类）
│   ├── state-machine.ts  # 7 阶段逻辑状态机
│   ├── define-plugin.ts  # 唯一插件形态入口
│   └── index.ts          # 唯一公共出口（rem2-kernel）
├── host/                 # 宿主适配层（内核之外，与内核并列）
│   ├── electron/         # main / preload / window / theme-registry
│   ├── ipc/              # IpcBridge + 通道白名单 + 事件降维映射
│   └── cli/              # run / args / paths / cli / scaffold / validate
├── frontend/             # Svelte 5 渲染层（唯一跑 Svelte 的地方）
│   ├── app/              # App / Shell / PanelHost / RouteHost + components
│   └── lib/              # ipc-client / bridge-types / nav-link / dto-guards / stores / theme
├── main.ts               # Electron Forge 主进程入口（转发壳）
└── preload.ts            # Forge preload 入口（转发壳）
plugins/                  # 7 个示例插件（源码 + plugin.json + 独立 tsconfig）
plugins-dist/             # 插件构建产物（esbuild ESM bundle，进 extraResource）
dist/                     # 内核产物（tsc，含 .d.ts）
tests/                    # 单元 / 集成 / 契约测试
docs/                     # 架构与 API 文档（入口见 docs/INDEX.md；英文见 docs/en/）
examples/                 # 示例配置与说明
```

---

## 许可

MIT
