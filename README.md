# rem2 — 极小内核 + 一切皆插件

> **Kernel + Everything-as-Plugin** 的独立从零实现。
> 内核只做 7 件事，其余一切（日志、配置、业务、运维、UI）都是插件。

[![tests](https://img.shields.io/badge/tests-222%20passing-brightgreen)](#测试)
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
[..] INFO  (plugin:com.rem2.logger-console) 控制台日志 sink 已注册
[..] WARN  (plugin:com.rem2.health-http) 权限告警：net.listen - 敏感能力需显式授予
[..] INFO  (plugin:com.rem2.health-http) 健康检查端点监听于 http://127.0.0.1:xxxxx/health
[..] INFO  (plugin:com.rem2.notify-worker) notify-worker 已在独立 Worker 线程启动
[..] INFO  (kernel) 内核启动完成：started=6 degraded=0 failed=0
──── rem2 kernel started ────
loadOrder : com.rem2.config-json -> com.rem2.hello-command -> com.rem2.logger-console -> com.rem2.health-http -> com.rem2.notify-worker -> com.rem2.theme-dark
started   : com.rem2.config-json, com.rem2.hello-command, com.rem2.logger-console, com.rem2.health-http, com.rem2.notify-worker, com.rem2.theme-dark
```

### 二、Electron 桌面外壳（可选）

外壳是**插件载体**，内核不依赖它。它会把内核当库启动，并提供一个命令输入框。

```bash
# 打开桌面应用（开发模式，带热重载）
pnpm start
```

窗口里输入命令（默认 `hello`）点「执行」，命令会经 IPC 桥转发到内核事件总线。

> **为什么外壳需要 tsx**：插件入口是磁盘上的 `.ts`，内核用动态 `import()` 加载。
> Electron 主进程只有 Node 原生 TS 支持（strip-only），既不吃 TS 参数属性，
> 也不会把 `.js` 说明符重映射到 `.ts` —— 因此外壳在启动内核前注册 `tsx` 的
> ESM loader（`src/electron-shell/main.ts` 的 `registerTsLoader`）。
> `tsx` 属 `devDependencies`：内核与 `dependencies` 仍零第三方依赖。
> 打包产物若需加载 `.ts` 插件，需自行把 tsx 提为运行时依赖。

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
import type { Plugin, PluginContext, PluginManifest } from 'rem2-kernel';

export default class MyPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'com.example.my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    entry: 'src/index.ts',
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
  };

  async onStart(ctx: PluginContext): Promise<void> {
    ctx.log.info('已启动');
  }
}
```

```json
// plugins/com.example.my-plugin/plugin.json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "entry": "src/index.ts",
  "compatibility": { "minKernel": "^1.0.0", "contractVersion": "1" }
}
```

7 阶段生命周期（全部可选）：`onDiscover` → `onLoad` → `onConfigure` → `onStart` → `onStop` → `onUnload` → `onDispose`

完整 API 参考见 **[docs/02-plugin-api.md](docs/02-plugin-api.md)**。

---

## 示例插件（6 类扩展点）

| 插件                                       | 证明什么                                         | 依赖                  |
| ------------------------------------------ | ------------------------------------------------ | --------------------- |
| [`logger-console`](plugins/logger-console) | **可观测性是插件** — 提供 `log.sink`             | —                     |
| [`config-json`](plugins/config-json)       | **配置来源是插件** — 提供 `config.provider`      | —                     |
| [`hello-command`](plugins/hello-command)   | **业务功能是插件** — 提供 `command.provide`      | 软依赖 config-json    |
| [`health-http`](plugins/health-http)       | **运维是插件** — 暴露 `/health` 端点             | 硬依赖 logger-console |
| [`theme-dark`](plugins/theme-dark)         | **UI 是插件** — 无 UI 外壳时优雅降级             | —                     |
| [`notify-worker`](plugins/notify-worker)   | **Worker 线程隔离** — 崩溃不影响内核（故障隔离） | —                     |

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
pnpm typecheck       # 内核类型检查
pnpm typecheck:shell # Electron 外壳类型检查
```

| 层次 | 文件数 | 测试数 | 覆盖内容                                                                                                           |
| ---- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------ |
| 单元 | 15     | 183    | semver / 拓扑排序 / 环检测 / DI 容器 / 容器隔离 / 事件总线 / 生命周期 / manifest 校验 / 权限 / 配置服务 / 健康服务 |
| 集成 | 14     | 46     | 启动顺序 / 软依赖降级 / 硬依赖级联 / 故障隔离 / 配置插件 / 可观测性 / 热重载 / 卸载级联 / 安全边界 / Worker 隔离 / **命令链路** / **主题链路** |
| 契约 | 4      | 30     | 插件导入边界 / 内核依赖白名单 / 扩展点清单一致性 / **构建产物为浏览器版 svelte** / **IPC 白名单与内核 Topics 一致** |

---

## 文档

文档按**阅读顺序**编号（`01` 最先读），完整索引见 **[docs/README.md](docs/README.md)**。

| # | 文档 | 内容 |
| --- | --- | --- |
| — | **[docs/README.md](docs/README.md)** | **文档索引与阅读路径**（从这里开始） |
| 01 | **[01-architecture-overview.md](docs/01-architecture-overview.md)** | **架构设计文档（权威）**：分层、职责、扩展点机制、4 条调用链路、数据流、部署拓扑、决策权衡、扩展流程 |
| 02 | **[02-plugin-api.md](docs/02-plugin-api.md)** | **插件开发指南**：`definePlugin`、生命周期、12 个扩展点、命令链路 |
| 03 | [03-target-architecture.md](docs/03-target-architecture.md) | 目标架构设计：生命周期两层模型、契约、扩展点全表 |
| 04 | [04-svelte-integration.md](docs/04-svelte-integration.md) | Svelte 接入设计：进程/构建边界、IPC 契约、CSP/HMR |
| 05 | [05-architecture-skeleton.md](docs/05-architecture-skeleton.md) | 骨架落地说明：实际目录树、扩展点注册表、构建产物流 |
| 06 | [06-migration-and-skeletonspec.md](docs/06-migration-and-skeletonspec.md) | 迁移映射表与破坏式变更清单（迁移已完成） |
| 07 | [07-form-evaluation.md](docs/07-form-evaluation.md) | 5 种「打通打包态」形式裁决 + 4 条实测证据 |
| 08 | [08-current-state-diagnosis.md](docs/08-current-state-diagnosis.md) | 重构前诊断：24 条优化项 |
| 09 | [09-prd-arch-refactor.md](docs/09-prd-arch-refactor.md) | 重构 PRD：需求锚点与验收判据 |

架构图：[class-diagram-v2.mermaid](docs/class-diagram-v2.mermaid) · [sequence-diagram-v2.mermaid](docs/sequence-diagram-v2.mermaid)

> **文档整理记录（2026-10-16）**：原 `01`–`07`（重构前文档）与两份旧 mermaid 图已删除 —— 它们描述的 `src/electron-shell/`、`src/runtime/`、`registerCapability`、`entry: src/index.ts`、`ServiceToken.create` 均已不存在，其中旧 `04-plugin-api.md` 会教插件作者使用三个已删除的 API。同日文档按阅读顺序从 `01` 重新编号（原 `08`–`15` → `01`–`09`），全部交叉引用已同步。

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
│   ├── observability/    # 日志 / 指标 / 追踪 / 健康 + 扩展点 sink 桥
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
│   └── lib/              # ipc-client / bridge-types / channels / stores / theme
├── main.ts               # Electron Forge 主进程入口（转发壳）
└── preload.ts            # Forge preload 入口（转发壳）
plugins/                  # 6 个示例插件（源码 + plugin.json + 独立 tsconfig）
plugins-dist/             # 插件构建产物（esbuild ESM bundle，进 extraResource）
dist/                     # 内核产物（tsc，含 .d.ts）
tests/                    # 单元 / 集成 / 契约测试
docs/                     # 架构与 API 文档（入口见 docs/README.md）
examples/                 # 示例配置与说明
```

---

## 许可

MIT
