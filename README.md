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

完整 API 参考见 **[docs/04-plugin-api.md](docs/04-plugin-api.md)**。

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
| 集成 | 12     | 35     | 启动顺序 / 软依赖降级 / 硬依赖级联 / 故障隔离 / 配置插件 / 可观测性 / 热重载 / 卸载级联 / 安全边界 / Worker 隔离   |
| 契约 | 2      | 4      | 插件导入边界 / 内核依赖白名单                                                                                      |

---

## 文档

| 文档                                                                                                            | 内容                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [01-rem-architecture-analysis.md](docs/01-rem-architecture-analysis.md)                                         | REM 架构只读分析（对照基线，未修改 REM）                                              |
| [02-architecture-design.md](docs/02-architecture-design.md)                                                     | 架构设计（内核边界 / 契约 / 依赖解析 / 隔离 / DI / 事件 / 配置 / 观测 / 安全 / 测试） |
| [03-comparison-rem-vs-rem2.md](docs/03-comparison-rem-vs-rem2.md)                                               | 与 REM 的 12 维度对比                                                                 |
| [04-plugin-api.md](docs/04-plugin-api.md)                                                                       | **插件开发 API 参考**                                                                 |
| [05-build-plan-and-risks.md](docs/05-build-plan-and-risks.md)                                                   | 构建计划 / 里程碑 / 风险 / 扩展路线图                                                 |
| [06-implementation-summary.md](docs/06-implementation-summary.md)                                               | 实现总结与验证结果                                                                    |
| [07-architecture-review.md](docs/07-architecture-review.md)                                                     | 第二轮缺陷审查报告（13 项 Bug/安全/完整性缺口 + 修正记录）                            |
| [class-diagram.mermaid](docs/class-diagram.mermaid) · [sequence-diagram.mermaid](docs/sequence-diagram.mermaid) | 类图与启动时序图                                                                      |

---

## 目录结构

```
src/
├── kernel/               # 内核（零第三方依赖）
│   ├── contracts/        # 16 个纯类型契约（无逻辑）
│   ├── di/               # DI 容器
│   ├── discovery/        # 发现 + manifest 校验
│   ├── dependency/       # 依赖图 / 拓扑排序 / 环检测
│   ├── lifecycle/        # 7 阶段 + 超时 + 回滚
│   ├── loader/           # 动态 import + 缓存击穿 + Worker 分支
│   ├── isolation/        # Worker 线程隔离（RPC 上下文 + 崩溃隔离）
│   ├── security/         # 权限 + 能力代理
│   ├── observability/    # 日志 / 指标 / 追踪 / 健康
│   ├── config/           # 配置服务（provider 可插拔）
│   ├── events/           # 事件总线（通配 + RPC）
│   ├── scheduler/        # 调度器（可被插件覆盖）
│   ├── semver/           # 独立实现的 semver
│   └── bootstrap/        # 内核选项与核心服务注册
├── runtime/              # CLI 引导 + IPC 桥
├── cli/                  # 开发者 CLI（scaffold / validate / list）
└── electron-shell/       # 可选 Electron 外壳（内核不依赖）
plugins/                  # 6 个示例插件
tests/                    # 单元 / 集成 / 契约测试
docs/                     # 架构与 API 文档
examples/                 # 示例配置与说明
```

---

## 许可

MIT
