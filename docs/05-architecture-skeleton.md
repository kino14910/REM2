# 05 · 架构骨架落地说明（磁盘实际状态）

> 上游：`09-prd-arch-refactor.md`（需求锚点）、`03-target-architecture.md`（目标架构）、`06-migration-and-skeletonspec.md`（迁移计划）
> 本文是 PRD §5.1 要求 7 份文档的最后一份。**本文描述的是磁盘现状，不是目标设计** —— 一切以 `find` / `ls` 的实际输出为准。
> 与 `docs/03` 目标树有出入的地方集中列在 §6，逐条给出证据，不做静默「修正」。

---

## 1. 三分骨架一句话

| 层 | 位置 | 唯一职责 | 硬约束 |
| --- | --- | --- | --- |
| **内核** | `src/kernel/**` | 编排 + 契约 + 扩展点注册表 | 零第三方运行时依赖；**不得** import `host` / `frontend` / `plugins` |
| **宿主** | `src/host/**` | 把 Electron / CLI / IPC 的世界适配到内核契约上 | 除 `host/electron/**` 外同样零第三方依赖 |
| **前端** | `src/frontend/**` | Svelte 5 renderer；唯一跑 Svelte 的地方 | **不得** import 内核；与内核的唯一通道是 `window.rem2` |

依赖方向恒为：`frontend →（window.rem2）→ host/ipc → kernel`，`plugins →（rem2-kernel 公共出口）→ kernel`，**无反向边**。由 `tests/contract/kernel-deps.test.ts`（R1/R2）静态扫描强制。

---

## 2. 实际目录树（完整到文件级）

以下树由 `find src -type f` 与 `ls` 直接导出，未做任何美化。行尾注释为一句话职责。

```
rem2/
├── src/
│   ├── main.ts                        # ★ Forge 主进程入口「转发壳」：import './host/electron/main.js'
│   ├── preload.ts                     # ★ Forge preload 入口转发壳：import './host/electron/preload.js'
│   ├── declarations.d.ts              # renderer 侧 window.rem2 的全局类型声明
│   │
│   ├── kernel/                        # ═══ 极小内核（零第三方运行时依赖）═══
│   │   ├── index.ts                   # ★ 唯一公共出口：只导出契约类型 + 2 个纯函数工厂 + 令牌 + 错误类 + 版本常量
│   │   ├── kernel.ts                  # 编排层：构造器只接收注入的 KernelDeps，不 new 任何实现类
│   │   ├── composition.ts             # 装配点之一：createDeps() 创建 14 个服务 + 宿主默认扩展点实现
│   │   ├── define-plugin.ts           # definePlugin()：唯一插件形态工厂（运行期薄校验）
│   │   ├── state-machine.ts           # 12 个 PluginStateT 与 LifecyclePhase 的双向映射（PHASE_OF_STATE）
│   │   ├── errors.ts                  # 全部错误类（含 UnknownExtensionPoint / ExtensionConflict）
│   │   ├── topics.ts                  # 内核语义主题常量（UiThemeChanged / PanelDataChanged 等）
│   │   ├── version.ts                 # KERNEL_VERSION / CONTRACT_VERSION / KERNEL_ID / MANIFEST_FILENAME
│   │   │
│   │   ├── contracts/                 # ═══ 插件看得见的全部语言（纯类型 + 纯函数，零副作用）═══
│   │   │   ├── index.ts               #   桶文件：只 re-export
│   │   │   ├── manifest.ts            #   PluginManifest / PluginManifestInit / Compatibility / Isolation
│   │   │   ├── plugin.ts              #   PluginFactory / PluginFactoryHooks / PLUGIN_HOOK_NAMES
│   │   │   ├── lifecycle.ts           #   LifecyclePhase / StopReason / PhaseOutcome
│   │   │   ├── context.ts             #   PluginContext / PluginApi / ServicesView
│   │   │   ├── extension-point.ts     #   ExtensionPointId / Def / Contribution / ContributorView / Summary
│   │   │   ├── service-token.ts       #   ServiceToken 品牌化接口 + defineToken() 纯工厂
│   │   │   ├── kernel-tokens.ts       #   KernelTokens：15 个内核服务令牌（含 UiThemeRegistry）
│   │   │   ├── event-bus.ts           #   EventBus / EventHandler / Unsubscribe / OnOptions
│   │   │   ├── config.ts              #   ConfigAccess / ConfigProvider / ConfigLayer
│   │   │   ├── logging.ts             #   Logger / LogEntry / LogSink / LOG_LEVEL_ORDER
│   │   │   ├── metrics.ts             #   MetricsApi / MetricSink / KERNEL_METRICS
│   │   │   ├── tracing.ts             #   Tracer / Span / SpanData / TraceExporter
│   │   │   ├── health.ts              #   HealthReport / HealthStatus / HealthCheckFn
│   │   │   ├── permission.ts          #   Capability / TrustLevel / PermissionSet / Capabilities
│   │   │   ├── plugins.ts             #   PluginStateT / PLUGIN_STATES / TERMINAL_STATES / PluginInfo
│   │   │   ├── container.ts           #   Container 契约（不含实现）
│   │   │   └── service.ts             #   ServiceDescriptor / ServiceFactory / Lifetime / ServicesView
│   │   │
│   │   ├── extensions/                # ═══ P3 唯一能力挂载面 ═══
│   │   │   ├── definitions.ts         # ★ 12 个扩展点的声明式定义表（顺序即 list() 输出序）
│   │   │   ├── registry.ts            # ★ ExtensionPointRegistry：define/贡献/枚举/按 pluginId 强制回收
│   │   │   ├── contrib-slot.ts        #   SingleContributionSlot / MultiContributionSlot：槽的容器语义
│   │   │   ├── ports.ts               #   三个 *.replace 扩展点与 command.provide 的端口契约
│   │   │   └── ports-types.ts         #   LoadedPlugin / PluginLoaderOptions 等端口侧类型
│   │   │
│   │   ├── bootstrap/
│   │   │   ├── options.ts             #   KernelOptions + defaultKernelOptions()（删除死配置 bootstrap）
│   │   │   └── register-core-services.ts #  15 个 KernelTokens 注册进 root 容器 + 8 项敏感服务能力门槛
│   │   │
│   │   ├── lifecycle/
│   │   │   ├── phases.ts              #   PHASES 有序表（发现→加载→初始化→配置→启动→停止→卸载）
│   │   │   ├── pipeline.ts            #   物理执行管线（9 步，表达为数据，便于断言顺序 == 契约）
│   │   │   ├── manager.ts             #   阶段驱动 + 超时 + 致命/非致命裁决
│   │   │   └── rollback.ts            #   致命失败逆序回滚
│   │   │
│   │   ├── registry/
│   │   │   └── plugins-registry.ts    #   已加载插件表 + 状态 + 健康（对外只读视图）
│   │   │
│   │   ├── di/
│   │   │   ├── container.ts           #   Container 实现（父引用藏模块私有 WeakMap）
│   │   │   ├── lifetime.ts            #   Lifetime 归一
│   │   │   └── service-registry.ts    #   ServiceRegistryFacade
│   │   │
│   │   ├── dependency/
│   │   │   ├── resolver.ts            #   依赖解析（去重 / 兼容 / 环检测 / 拓扑）
│   │   │   ├── graph.ts               #   依赖图构建
│   │   │   ├── cycles.ts              #   环检测
│   │   │   └── topo-sort.ts           #   拓扑排序（稳定）
│   │   │
│   │   ├── discovery/
│   │   │   ├── discovery.ts           #   根目录扫描 + manifest 读取 + 排序
│   │   │   ├── candidate.ts           #   Candidate 类型
│   │   │   ├── manifest-validator.ts  #   校验器（entry 形态校验：只允许 .js / .mjs）
│   │   │   └── manifest.schema.json   #   manifest 的 JSON Schema
│   │   │
│   │   ├── loader/
│   │   │   ├── loader.ts              #   动态 import + 工厂调用 + 容器/上下文组装
│   │   │   ├── module-resolver.ts     #   entry 解析 + assertInsideRoot 入口沙箱
│   │   │   └── plugin-factory.ts      #   assertPluginFactory：只接受 definePlugin 工厂（1 种形态）
│   │   │
│   │   ├── isolation/
│   │   │   ├── worker-host.ts         #   Worker 侧宿主（RPC 派发 + 真实权限快照透传）
│   │   │   ├── worker-plugin-proxy.ts #   内核侧代理（对插件实例的 RPC 包装 + 扩展点贡献转发）
│   │   │   ├── worker-bootstrap.ts    #   eval 引导源码（保持无路径知识）
│   │   │   └── worker-protocol.ts     #   消息类型与 WORKER_ALLOWED_EXTENSION_POINTS 白名单
│   │   │
│   │   ├── security/
│   │   │   ├── capability-guard.ts    #   能力代理（resolve / assertCapability / declareServiceCapability）
│   │   │   ├── permission-manager.ts  #   权限授予与查询（扩展点贡献时校验的依据）
│   │   │   └── trust-policy.ts        #   信任级别 → 默认授权集
│   │   │
│   │   ├── observability/
│   │   │   ├── log-service.ts         #   LogService：产生日志，按 sink 分发
│   │   │   ├── metrics-service.ts     #   MetricsService：counter / gauge / histogram
│   │   │   ├── tracing-service.ts     #   TracingService：span 生命周期
│   │   │   ├── health-service.ts      #   健康聚合（消费 health.check 扩展点）
│   │   │   ├── extension-sinks.ts     # ★ log/metrics/trace/config 四个 sink 扩展点的宿主默认实现桥
│   │   │   ├── null-sink.ts           #   NullLogSink（保证 dispatch 永远有承接者）
│   │   │   └── noop-metrics-sink.ts   #   NoopMetricSink
│   │   │
│   │   ├── config/
│   │   │   ├── config-service.ts      #   分层合并 + 快照 + onDidChange
│   │   │   └── memory-provider.ts     #   MemoryConfigProvider / ReadOnlyMemoryConfigProvider
│   │   │
│   │   ├── events/
│   │   │   ├── event-bus.ts           #   桶索引 + 订阅期定序（去掉每次 emit 的 sort）
│   │   │   ├── pattern.ts             #   主题模式匹配
│   │   │   └── priority.ts            #   订阅优先级
│   │   │
│   │   ├── scheduler/
│   │   │   ├── scheduler.ts           #   Scheduler 端口接口（scheduler.replace 的契约侧）
│   │   │   └── serial-scheduler.ts    #   SerialScheduler 默认实现
│   │   │
│   │   ├── semver/
│   │   │   ├── semver.ts              #   解析与比较
│   │   │   └── range.ts               #   range 满足判定
│   │   │
│   │   ├── context/
│   │   │   ├── plugin-context.ts      #   createPluginContext()：组装 ctx（services 经 guard，resolvePath 受沙箱约束）
│   │   │   └── plugin-api.ts         #   PluginApiImpl：export / unexport / useCapability（无 registerCapability）
│   │   │
│   │   └── util/
│   │       ├── deep-merge.ts          #   深合并
│   │       ├── disposable.ts          #   Disposable 工具
│   │       ├── id.ts                  #   id 生成
│   │       └── timeout.ts             #   超时包装
│   │
│   ├── host/                          # ═══ 宿主适配层（内核之外）═══
│   │   ├── electron/
│   │   │   ├── main.ts                # ★ Electron 主进程：createDeps() 启动内核 + 8 个白名单方法响应器
│   │   │   ├── preload.ts             # ★ 唯一契约边界：contextBridge 暴露 window.rem2（invoke / onEvent）
│   │   │   ├── window.ts              #   createWindow()：contextIsolation + sandbox + CSP 注入
│   │   │   └── theme-registry.ts      #   宿主侧主题表实现（只依赖 kernel/contracts/ui，不 import 任何插件）
│   │   ├── ipc/
│   │   │   ├── channels.ts            # ★ 2 个通道名 + 8 方法 + 5 事件的精确白名单（renderer 的能力上限）
│   │   │   └── bridge.ts              #   IpcBridge：双向收窄转发 + DTO 降维（不暴露 bus.emit）
│   │   └── cli/
│   │       ├── run.ts                 #   `pnpm dev` 引导：参数 → KernelOptions → start → 健康报告
│   │       ├── cli.ts                 #   `pnpm cli` 子命令：scaffold / validate / list / help
│   │       ├── args.ts                #   命令行参数解析
│   │       ├── paths.ts               # ★ projectRoot() / builtinPluginsRoot()：三种运行形态的路径解析
│   │       ├── scaffold-plugin.ts     #   插件骨架生成
│   │       └── validate-manifest.ts   #   manifest 校验命令实现
│   │
│   └── frontend/                      # ═══ Svelte 5 前端 ═══
│       ├── entry-client.ts            #   renderer 入口：import global.css + mount(App)
│       ├── app/
│       │   ├── App.svelte             #   根组件：四类数据并行拉取 + 事件订阅（退订交 onMount 返回值）
│       │   ├── Shell.svelte           #   布局骨架（标题栏 / 侧栏 / 主区）
│       │   ├── PanelHost.svelte       # ★ ui.panel 扩展点贡献的插槽宿主
│       │   ├── RouteHost.svelte       # ★ ui.route 扩展点贡献的导航宿主
│       │   ├── global.css             #   全局样式与 CSS 变量槽
│       │   └── components/
│       │       ├── CommandPrompt.svelte  #   命令输入与结果展示
│       │       ├── HealthBadge.svelte    #   健康状态徽标
│       │       ├── PanelShell.svelte     #   单个面板的外壳 chrome（边框 / 标题 / 状态）
│       │       └── ThemeToggle.svelte    #   主题切换控件
│       └── lib/
│           ├── ipc-client.ts          #   window.rem2 的类型化封装（前端唯一 IPC 出口）
│           ├── bridge-types.ts        #   DTO：与内核契约对齐的 renderer 侧类型
│           ├── channels.ts            #   前端侧通道名与方法/事件常量
│           ├── stores/                #   Svelte 5 runes 状态（文件名必须 .svelte.ts 结尾）
│           │   ├── panels.svelte.ts   #     面板列表与激活项
│           │   ├── routes.svelte.ts   #     导航项（按 order 排序）
│           │   ├── theme.svelte.ts    #     当前主题 + 主题列表
│           │   ├── health.svelte.ts   #     健康报告与 unhealthy 过滤
│           │   └── command.svelte.ts  #     命令执行结果与历史
│           └── theme/
│               └── vars.ts            #   主题 token → CSS 变量映射
│
├── plugins/                           # 插件源码单元（6 个）
│   ├── config-json/                   #   JSON 文件配置 provider
│   ├── health-http/                   #   /health HTTP 端点（硬依赖 logger-console）
│   ├── hello-command/                 #   hello 命令（软依赖 config-json）
│   ├── logger-console/                #   控制台日志 sink
│   ├── notify-worker/                 #   Worker 线程隔离示例（src/index.mjs）
│   └── theme-dark/                    #   深色主题 token
│   每个插件固定 5 件：plugin.json（entry: dist/index.js）、package.json、tsconfig.json、src/index.ts
│
├── plugins-dist/                      # ★ 插件构建产物聚合目录（进 extraResource，git 已忽略）
│   └── <plugin-id>/{plugin.json, package.json, dist/index.js, dist/index.js.map}
│
├── scripts/
│   └── build-plugins.mjs              # ★ 插件构建：esbuild 逐个打包 → plugins-dist/（构建期代码，不进 src/）
│
├── tests/{unit,integration,contract}/  # 3 层测试 + fixtures/ + helpers/
├── examples/config/app.config.json    # 配置插件的示例数据文件
│
├── vite.shared.mts                    # ★ alias / ssr.noExternal / build 的单一来源（conditions 按环境分化，不共享）
├── vite.main.config.mts               #   主进程构建（target node20）
├── vite.preload.config.mts            #   preload 构建（产物名必须是 preload.cjs）
├── vite.renderer.config.mts           #   renderer 构建（target chrome120）
├── vitest.config.ts                   #   node 环境 + 限并发（Windows 文件 IO 决定，见文件头注释）
│
├── tsconfig.json                      # 内核 + host(cli/ipc) + 插件 + 测试
├── tsconfig.build.json                # 内核产物编译（唯一 noEmit:false 的配置）
├── tsconfig.electron.json             # 主进程 + preload（DOM + node）
├── tsconfig.frontend.json             # renderer（只要 DOM，刻意不给 node 类型）
├── tsconfig.shell.json                # 兼容旧脚本名的纯转发壳
│
├── forge.config.mts                   # asar: true + extraResource: ['plugins-dist'] + Fuses
└── .gitignore                         # 含 dist/ 与 plugins-dist/（构建产物不入库）
```

---

## 3. 扩展点注册表如何被填充

12 个扩展点的 id 在 `src/kernel/extensions/definitions.ts` 里以 `as const satisfies readonly ExtensionPointDef<unknown>[]` 声明，**逐 id 与 `docs/03 §7.2` 全表一一对应**，由 `tests/contract/extension-points.test.ts` 用写死的字面量数组强制（期望值不 import 自 `definitions.ts`，这样它才是独立判据）。

### 3.1 三个填充动作

| 动作 | 调用点 | 参与者 | 代码位置 |
| --- | --- | --- | --- |
| ① **声明 12 个点** | `createDeps()` 启动第一步 | `pluginId='kernel'` 无关 | `composition.ts:86` `extensions.defineAll(EXTENSION_POINT_DEFS)` |
| ② **注入宿主默认实现** | 启动中段 | `pluginId='kernel'` | `composition.ts:211/214-225` + `extension-sinks.ts:52-72` |
| ③ **插件贡献** | 插件 `onLoad` 期 | 真实 `pluginId` | 插件调 `ctx.extensions.contribute(...)` |

### 3.2 ① 声明：定义表 → 注册表

`definitions.ts` 的 12 条按固定顺序排列（顺序即 `registry.list()` 的输出顺序，也是契约测试的断言对象）：

| # | id | multi | hasHostDefault | conflict | capability |
| --- | --- | --- | --- | --- | --- |
| 1 | `log.sink` | ✅ | ✅ `kernel.null` | keep-first | — |
| 2 | `metrics.sink` | ✅ | ✅ `kernel.noop` | keep-first | — |
| 3 | `trace.exporter` | ✅ | ✅ `kernel.buffered` | keep-first | — |
| 4 | `config.provider` | ✅ | ✅ `kernel.defaults` | keep-first | `config.provide` |
| 5 | `command.provide` | ✅ | ❌ | reject-new | `command.provide` |
| 6 | `health.check` | ✅ | ❌ | keep-first | — |
| 7 | `ui.theme` | ❌ 单例 | ✅ `ThemeRegistry` | keep-first | `ui.theme` |
| 8 | `ui.panel` | ✅ | ⚠️ 声明为 true 但**代码未注册**（见 §3.3） | reject-new | `ui.panel` |
| 9 | `ui.route` | ✅ | ❌ | replace-old | `ui.route` |
| 10 | `scheduler.replace` | ❌ 单例 | ✅ `kernel.serial` | replace-old | `kernel.internals` |
| 11 | `resolver.replace` | ❌ 单例 | ✅ `kernel.builtin` | replace-old | `kernel.internals` |
| 12 | `loader.replace` | ❌ 单例 | ✅ `kernel.builtin` | replace-old | `kernel.internals` |

`defineAll()` 逐条调 `define()`：重复定义直接抛 `ExtensionConflictError`（启动期就该炸，不静默），并按 `multi` 分派到 `MultiContributionSlot` 或 `SingleContributionSlot` 建空槽。

### 3.3 ② 宿主默认实现：为什么不全在 `register-core-services.ts`

任务书假设宿主默认实现由 `register-core-services.ts` 注入，**磁盘上不是这样**，需要澄清：

`register-core-services.ts` 只做两件事，与扩展点无关：
1. 把 15 个 `KernelTokens.*` 实例注册进 root 容器（`KernelTokens` 共 **17** 个，另 2 个由宿主侧注册，见下）；
2. 用 `guard.declareServiceCapability()` 给 **8** 个敏感服务设能力门槛（`ConfigService`→`config.admin`、`Permissions`→`permissions.admin`、`Scheduler`/`Resolver`/`Discovery`/`Loader`/`CapabilityGuard`/`Extensions`→`kernel.internals`）。

扩展点的宿主默认实现在**两个地方**注入，都由 `composition.ts` 编排：

- `extension-sinks.ts` 的 `registerHostSinks()` → `log.sink`（`NullLogSink`）、`metrics.sink`（`NoopMetricSink`）、`trace.exporter`（`BufferedTraceExporter`）。前两者**同时**直接 `addSink()` 到服务上，保证 dispatch 永远有承接者，避免内核各处写 `undefined` 判断。
- `extension-sinks.ts` 的 `registerHostConfigLayer()` → `config.provider`（`ReadOnlyMemoryConfigProvider({app:{name:'rem2'}})`）。
- `composition.ts:214-225` 内联注册三个 `*.replace` → `kernel.serial` / `kernel.builtin` / `kernel.builtin`。
- `ui.theme` 的宿主默认实现是 `ThemeRegistryImpl`，**不在内核里**，由 `host/electron/main.ts:170` 用 `kernel.root.registerInstance(KernelTokens.UiThemeRegistry, themeRegistry)` 注入 —— 它依赖 `electron` 侧的窗口生命周期，内核零依赖原则下不可能放在内核。

**两处已知不一致（如实记录，未擅自改动）**：

- `ui.panel` 在 `definitions.ts` 声明 `hasHostDefault: true`，但代码里**没有任何 `registerHostDefault('ui.panel', ...)` 调用**。实际效果是空 multi 槽 —— `registry.listAll('ui.panel')` 返回 `[]`，`main.ts` 的 `ui.panel.list` 响应器返回空数组，前端 `PanelHost.svelte` 渲染零面板。功能上不崩（`docs/03 §7.2` 把它描述为「内置『无面板』占位（不算贡献）」，即占位是隐式的），但 `hasHostDefault` 这个字段此刻是**空声明**。
- `KernelTokens.UiPanelHost` 已定义（`contracts/kernel-tokens.ts:80`）但**全仓库无注册也无消费**（`grep -rn UiPanelHost` 只命中定义处本身）。这是一个预留令牌。

### 3.4 ③ 插件贡献：`ctx.extensions` 的完整链路

```
插件 setup(ctx) → ctx.extensions.contribute(point, { contributionId, impl })
  └─ context/plugin-context.ts:104        deps.extensions 原样挂到 ctx 上
     └─ composition.ts:172-183             闭包捕获 candidate.manifest.id
        └─ registry.contribute(pluginId, point, contribution)
           ├─ ① defs.get(point)?  否 → throw UnknownExtensionPointError
           ├─ ② def.capability?   permissions.get(pluginId).isGranted(cap)
           │                        否 → throw CapabilityDeniedError
           ├─ ③ multi 槽：contributionId 撞车 → throw ExtensionConflictError
           │           single 槽：按 conflict 裁决
           │             keep-first  → 记 issue 后 return（不抛错，贡献被丢弃）
           │             reject-new  → throw ExtensionConflictError
           │             replace-old → slot.replace()
           └─ ④ byPlugin.get(pluginId).add(point)   ← P6 回收索引
```

**回收索引是 P6 的落点**：`byPlugin` 与 `MultiContributionSlot.byPlugin` 双向记录归属，`retractAll(pluginId)` 才能在插件漏调 `retract` 时仍把它的全部贡献撤干净。`docs/03 §7.3` 点名「这是骨架阶段最容易漏的一处」，落盘时确实单独抽了 `contrib-slot.ts` 来固化。

**Worker 隔离下的贡献**受限：`worker-plugin-proxy.ts` 只转发 `WORKER_ALLOWED_EXTENSION_POINTS`（`log.sink` / `metrics.sink` / `trace.exporter`）三类，值必须可结构化克隆；贡献 UI 类扩展点会抛错。

### 3.5 新增一个扩展点的 checklist（落盘版）

1. `contracts/extension-point.ts` 的 `ExtensionPointId` 联合加字面量；
2. `extensions/definitions.ts` 加一条 `ExtensionPointDef`（单例槽**必须**显式写 `conflict`，契约测试会查）；
3. `extensions/ports.ts` 若引入新端口，加接口；
4. 若 `hasHostDefault`：在 `composition.ts` 或 `extension-sinks.ts` 里 `registerHostDefault`；
5. 若需 capability：`contracts/permission.ts` 加常量 + `security/trust-policy.ts` 给出各信任级别处置；
6. 同步更新 `tests/contract/extension-points.test.ts` 的 `EXPECTED_IDS` 与 `docs/03 §7.2` 表格（两者都被断言，改一个必须改另一个）。

---

## 4. 构建产物流

### 4.1 三条产线

```
① 内核库（tsc，唯一对外分发的 .d.ts）
   src/kernel/**/*.ts
     └─ tsc -p tsconfig.build.json
        → dist/kernel/**（.js + .d.ts + .map）
        → package.json 的 exports["."] 指向 ./dist/kernel/index.js

② 插件（esbuild，dev 与打包态同形态）
   plugins/<id>/src/index.ts
     └─ node scripts/build-plugins.mjs
        → plugins-dist/<id>/dist/index.js（ESM, bundle, target node20）
        → plugins-dist/<id>/{plugin.json, package.json}

③ 外壳（vite + electron-forge）
   src/main.ts / src/preload.ts / src/frontend/entry-client.ts
     └─ forge.config.mts 的 VitePlugin
        → .vite/build/main.cjs / preload.cjs / .vite/renderer/main_window/index.html
```

`pnpm build` = `build:kernel` + `build:plugins`；`premake` 钩子保证打包前两者都已就绪。

### 4.2 插件进包与运行时定位

```
plugins-dist/  ──extraResource──▶  resources/plugins-dist/   （asar 之外）
                                          │
                                          ▼
                        builtinPluginsRoot()   ← src/host/cli/paths.ts:96
                                          │
                                          ▼
              KernelOptions.builtinRoot ──▶ discovery 扫描 ──▶ loader import()
```

三点必须说清：

1. **asar 保持 `true`**。插件落在 asar **外面**，所以 asar 不会影响插件加载 —— `import()` 一个 asar 内的 `.js` 可以，动态 require 不行，因此这里选 extraResource 而非打进 `app.asar`。
2. **装出来叫 `resources/plugins-dist/`，不是 `resources/rem2-plugins/`**。packager 8.x 的 `extraResource` 接受的是**目录列表**（不是 `{from,to}` 对象），目标名取路径末段。`forge.config.mts:17-19` 的注释已记录这一点。任何按 `rem2-plugins` 去找的代码都会 `ENOENT`。
3. **运行时定位**由 `paths.ts` 承担，且必须兼容三种形态：ESM（`tsx`/原生）、CJS bundle（Electron 主进程，`import.meta.url` 被编译成 `undefined`，改用 `__dirname`）、兜底 `process.cwd()`。`moduleDir()` 每一步都判空后才用 —— 早期版本把 `fileURLToPath(import.meta.url)` 写成默认参数，Electron 主进程启动即抛 `ERR_INVALID_ARG_TYPE`。

`builtinPluginsRoot()` 的取值优先级是 `plugins-dist/`（已构建）> `plugins/`（未构建，便于手工调试源码目录）。**必须指向 `plugins-dist/`**：manifest 的 `entry` 唯一指向 `dist/index.js`，若根目录指 `plugins/`，内核会去找 `plugins/<id>/dist/index.js` —— 开发态下该目录不存在，于是全部插件 `Failed`，而报错是「模块解析失败」，与真正原因相距很远。

### 4.3 vite 侧的关键一项

`vite.shared.mts` 的 `ssr.noExternal: ['rem2-kernel']` 是三个 vite config 与 `vitest.config.ts` 的共享来源。少了它，Vite 会把裸包名 externalize，主进程产物里留下 `require('rem2-kernel')`，打包态解析到 `exports` 指向的 `.ts` 入口 → `ERR_UNKNOWN_FILE_EXTENSION`。**这个错误只在打包后出现，开发态看不出来。** 同一 alias 声明在 4 个文件里是 `docs/09` O21 点名的漂移源，故收敛到单一来源。

---

## 5. 三份 tsconfig 的职责边界

四份配置是**一份基线 + 三份特化 + 一份转发壳**。`tsconfig.electron.json` 与 `tsconfig.frontend.json` 都 `extends: ./tsconfig.json`，因此 `strict` / `noUnusedLocals` / `paths` 等规则全局一致，差异只在 `lib` / `types` / `include` / `moduleResolution`。

| 配置 | `include` | `lib` / `types` | `moduleResolution` | 为什么这样切 |
| --- | --- | --- | --- | --- |
| **`tsconfig.json`**（基线） | `src/kernel/**`、`src/host/{cli,ipc}/**`、`plugins/*/src/**`、`tests/**`、`*.ts`、`*.mts` | `ESNext` + `types: ["node"]` | `NodeNext` | 内核与 CLI/IPC 是纯 Node 库，**不需要 DOM**。`exclude` 掉 `host/electron/**` 与 `src/{main,preload}.ts`（它们要 DOM，见下行）。同时覆盖插件与测试，保证三者对同一份契约的类型判断一致。 |
| **`tsconfig.electron.json`** | `src/{main,preload}.ts`、`src/host/electron/**`、`src/declarations.d.ts` | `ESNext` + `DOM` + `DOM.Iterable`，`types: ["node"]` | `NodeNext`（继承） | 主进程与 preload 需要 **DOM（`BrowserWindow`）+ node（`fs`/`path`）** 同时在场。这份配置由 `tsconfig.shell.json` 演进而来 —— renderer 已被 frontend 配置接管，剩下主进程一侧，故只保留 DOM + node 组合。 |
| **`tsconfig.frontend.json`** | `src/frontend/**`、`src/declarations.d.ts` | `ESNext` + `DOM` + `DOM.Iterable`，**`types: []`** | **`Bundler`** | ① 刻意不给 node 类型：renderer 在 `contextIsolation + sandbox` 下本就无 Node 能力，把这条约束落到**类型层面**比靠自觉可靠。② `moduleResolution: "Bundler"` 是 svelte 插件解析 `./X.svelte` 的必要条件 —— `NodeNext` 不认无后缀的 `.svelte` 导入。 |
| **`tsconfig.build.json`** | 仅 `src/kernel/**` | 同基线 | `NodeNext` | **唯一 `noEmit: false` 的配置**。`declaration: true` + `outDir: dist` + `rootDir: src`。host 与 frontend **不进 dist** —— 它们是宿主产物，各自由 vite/forge 负责。 |
| `tsconfig.shell.json` | — | — | — | 纯转发壳（`extends: ./tsconfig.electron.json`）。保留原因：验收脚本写的是 `pnpm typecheck:shell`，直接改脚本名会让该验收项失效；保留一个转发壳比改验收命令安全。 |

对应的 npm 脚本：`typecheck` / `typecheck:electron` / `typecheck:frontend` / `typecheck:shell`，`typecheck:all` 串跑前三者（`typecheck:shell` 因与 `typecheck:electron` 等价而未纳入）。

---

## 6. 与 `docs/03` 目标树的差异（逐条对照）

`docs/03 §2` 是**目标**设计，本节记录落盘时与它的全部出入。每条都可在磁盘上复核。

| # | `docs/03` 目标树 | 磁盘实际 | 性质 |
| --- | --- | --- | --- |
| 1 | `host/ipc/topics.ts` | **未建**。topic 常量统一在 `src/kernel/topics.ts` | 实现时合并：主题常量是内核语义，放内核更符合 P1（前端/宿主不持有内核语义） |
| 2 | `host/theme-registry.ts`（`host/` 根下） | `host/electron/theme-registry.ts` | 实现时调整：它被 `main.ts` 单点使用，且实现上依赖 `electron` 侧窗口生命周期，放 electron 内更贴合 |
| 3 | `extensions/` 只列 3 个文件 | 多 `ports.ts`、`ports-types.ts` | 实现时新增：让 `definitions.ts` 能在**不 import 实现层**的前提下声明 `*.replace` 三个扩展点（`docs/03` §7.2 脚注提到的 D7 例外，仅限 `kernel.ts` 与 `composition.ts`） |
| 4 | `scheduler/` 只列 `serial-scheduler.ts` | 多 `scheduler.ts` | 实现时新增：端口接口与默认实现分离，`scheduler.replace` 才有契约可贡献 |
| 5 | `frontend/app/` 只列 4 个 `.svelte` | 多 `components/`（4 个）与 `global.css` | 实现时新增：把 chrome 渲染拆到 `PanelShell.svelte`，插槽宿主只负责遍历 |
| 6 | `frontend/lib/` 只列 3 项 | 多 `channels.ts` 与 `stores/` 下 5 个具名 store | 实现时新增：`channels.ts` 让前端不 import `host/ipc/channels.ts`（renderer 不得触碰宿主源码） |
| 7 | 根级 `tsconfig.{json,build,shell}` | 另有 `tsconfig.electron.json`、`tsconfig.frontend.json`（`shell` 降级为转发壳） | 实现时调整：见 §5 |
| 8 | 树中未列 `src/main.ts` / `src/preload.ts` | 存在，是转发壳 | 实现时新增：Forge 的 `build[].entry` 需要固定路径 |
| 9 | 树中未列 `scripts/` | 存在 `scripts/build-plugins.mjs` | 实现时新增：属构建期代码，**刻意不进 `src/`**，以免触犯「内核零第三方依赖」红线 |
| 10 | `discovery/` 未列 schema | 另有 `manifest.schema.json` | 实现时新增 |
| 11 | — | 另有 `examples/config/app.config.json` | 补齐 `docs/03 §12.4` 提出的疑问：`examples/` 是真实存在且被 `config-json` 插件使用的，故 `host/cli/paths.ts` 的相关引用**不是**残留，保留 |

**关于任务书提到的 `registry/` 层级差异**：任务书说「`src/kernel/registry/` 已提到 `src/kernel/`」。实际核对结果是 **磁盘与 `docs/03` 一致** —— 两边都是 `src/kernel/registry/plugins-registry.ts`（`docs/03` 第 69-70 行 / `docs/06` 第 78 行均可复核）。`src/kernel/registry/` 只含这一个文件，把它提到 `src/kernel/` 根下会让 `kernel/` 平铺 20+ 个条目，可读性反而更差。**故本文不记录这处差异，因为它不存在。** 若确有一处层级调整指的是别的目录，请指出具体路径。

---

## 7. 验证状态（主理人独立复核 + 本轮补充）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 内核类型 | `npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| 外壳类型 | `npx tsc --noEmit -p tsconfig.electron.json` | 0 错误 |
| 前端类型 | `npx tsc --noEmit -p tsconfig.frontend.json` | 0 错误 |
| 契约测试 | `npx vitest run tests/contract` | 3 文件 / **18** 用例全绿（原 11 → 本轮 +7，见下） |
| 产物可加载 | `node -e "import('./dist/kernel/index.js')"` | 可加载，29 个导出 |

本轮新增的 7 个用例全部在 `tests/contract/kernel-deps.test.ts` 的 `contract · 提取器自检（元测试）` 组内。它们的必要性：R1/R2 的断言形式是「violations 为空」，这在提取器**恒返回空数组**时同样成立 —— 红线会静默失效。这不是假想，`stripLiterals()` 曾把引号字符串清空成正则匹配不到的 `''`，导致注入 `zod` 到 `src/kernel/**` 后 5 条硬红线**恒真**而测试全绿。元测试断言的是「提取器在一个已知输入上确实提取得出来」，提取器一旦被改坏立刻红，红线失效不会再次静默发生。

---

## 8. 未做的事（明确留给后续）

1. **业务实现**：本轮是骨架，插件的 setup 体多为最小可运行形态，没有真实业务逻辑。
2. **运行期替换 `*.replace` 三个扩展点**：当前只支持启动期由引导插件替换。`SerialScheduler` 的 in-flight 任务迁移与 `DependencyResolver` 的幂等性都未设计，运行期替换会静默丢任务（`docs/03 §12.2` 的未决项）。
3. **`ui.component` 扩展点**：插件目前只能贡献**声明式描述**，chrome 由宿主渲染。若要让插件提供真正的 Svelte 组件，需追加插件侧 Svelte 构建链 + CSP 下的动态 import 白名单 + 组件版本耦合，骨架阶段刻意不做（`docs/03 §12.1` 的未决项，建议开工前与用户确认）。
4. **打包态实跑**：`pnpm make` 尚未执行，`resources/plugins-dist/` 的实际落盘名与 `builtinPluginsRoot()` 的匹配只经代码推演，未在真机验证。
5. **`ui.panel` 的 `hasHostDefault` 空声明**（见 §3.3）：要么补一个 `registerHostDefault('ui.panel', ...)`，要么把该字段改回 `false`。当前状态不影响运行，但字段与实现不符会误导后续读者。
6. **`KernelTokens.UiPanelHost` 是死令牌**（见 §3.3）：无注册无消费。
