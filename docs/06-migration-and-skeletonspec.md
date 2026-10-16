# 06 · 迁移与骨架规格

> 对应 PRD **P0-6 / P1-1 / P1-2 / P1-5**。
> 原则：允许破坏式变更，**不写兼容层、不做双形态并存、不加迁移垫片**。本文给的是终态。
> 前置：`09`（诊断）、`10`（形式裁决）、`11`（目标架构）、`12`（Svelte 接入）。

---

## 1. 旧 → 新逐条映射表（覆盖全部 85 个 `src` 文件）

图例：↻ 移动并修改 ｜ ✎ 重写 ｜ ⇢ 拆分 ｜ ✕ 删除 ｜ ➕ 新增

### 1.1 内核契约层（16 个文件）

| # | 旧路径 | 新路径 | 动作 | 说明 |
| --- | --- | --- | --- | --- |
| 15 | `kernel/contracts/config.ts` | `kernel/contracts/config.ts` | ↻ | 内容基本不变 |
| 16 | `kernel/contracts/context.ts` | `kernel/contracts/context.ts` | ✎ | `PluginContext` 增 `extensions: ExtensionContributorView`；`PluginApi` 删 `registerCapability`；`ServicesView` 从 `ServiceRegistry` 独立命名 |
| 17 | `kernel/contracts/di-container.ts` | `kernel/contracts/container.ts` | ↻ | 重命名，消除「di-」前缀（目录已叫 `di`） |
| 18 | `kernel/contracts/event-bus.ts` | 同 | ↻ | 不变 |
| 19 | `kernel/contracts/health.ts` | 同 | ↻ | 不变 |
| 20 | `kernel/contracts/index.ts` | 同 | ✎ | 增 `extension-point`、`plugin`、`ui` 桶导出；移除不再公开的项 |
| 21 | `kernel/contracts/kernel-tokens.ts` | 同 | ✎ | `ServiceToken.create` → `defineToken`；补 `KernelTokens.UiThemeRegistry` / `UiPanelHost`（宿主提供的 UI 侧服务） |
| 22 | `kernel/contracts/lifecycle.ts` | 同 | ✎ | `Plugin`（7 钩子接口）改为 `PluginFactoryHooks` + `PluginFactory`；`LifecyclePhase` 按 `11` §4.2 状态机重命名 |
| 23 | `kernel/contracts/logging.ts` | 同 | ↻ | 不变 |
| 24 | `kernel/contracts/manifest.ts` | 同 | ✎ | 增 `contributes` / `requires`；`entry` 类型收窄为产物路径；`capabilities` 更名 `requires` |
| 25 | `kernel/contracts/metrics.ts` | 同 | ↻ | 不变 |
| 26 | `kernel/contracts/permission.ts` | 同 | ✎ | 增 UI 相关能力常量（`ui.panel` / `ui.route`）与 `log.sink` / `metrics.sink` 等 |
| 27 | `kernel/contracts/plugins.ts` | 同 | ✎ | 删 `PublicPluginState`；引入 `PLUGIN_STATES` + `PluginStateT`（单一来源） |
| 28 | `kernel/contracts/service-token.ts` | 同 | ✎ | **class → 品牌化 interface + `defineToken` 纯函数**（`11` §3.3） |
| 29 | `kernel/contracts/service.ts` | 同 | ✎ | `ServiceDescriptor` / `ServiceFactory` 与 `service-token.ts` 内容合并到此（避免两处定义） |
| ➕ | — | `kernel/contracts/plugin.ts` | ➕ | `PluginFactory` / `PluginFactoryHooks` / `PluginModuleExport` 的类型侧 |
| ➕ | — | `kernel/contracts/extension-point.ts` | ➕ | `ExtensionPointId` / `ExtensionPointDef` / `ExtensionContribution` / `ExtensionContributorView` |
| ➕ | — | `kernel/contracts/ui.ts` | ➕ | `PanelContribution` / `RouteContribution` / `ThemeDefinition` / `ThemeRegistry`（**从 `plugins/theme-dark/src/index.ts` 上移**） |

### 1.2 内核实现层（44 个文件）

| # | 旧路径 | 新路径 | 动作 | 说明 |
| --- | --- | --- | --- | --- |
| 9 | `kernel/bootstrap/options.ts` | `kernel/bootstrap/options.ts` | ✎ | **删除死配置 `bootstrap`**（`09` O23） |
| 10 | `kernel/bootstrap/register-core-services.ts` | 同 | ✎ | 改为返回 `KernelDeps`，注册动作交给 `composition.ts` |
| 11 | `kernel/config/config-service.ts` | 同 | ✎ | `get()` 在 `dirty` 时惰性 refresh（O18）；`set()` 增量合并（O19） |
| 12 | `kernel/config/memory-provider.ts` | 同 | ↻ | 不变 |
| 13 | `kernel/context/plugin-api.ts` | 同 | ✎ | 删 `capabilities` Map 与 `registerCapability`/`getCapability`/`listCapabilities` |
| 14 | `kernel/context/plugin-context.ts` | 同 | ✎ | `ContextDeps` 增 `extensions`；`createPluginContext` 注入 `ctx.extensions` |
| 31 | `kernel/dependency/cycles.ts` | 同 | ↻ | 不变 |
| 32 | `kernel/dependency/graph.ts` | 同 | ↻ | 不变 |
| 33 | `kernel/dependency/resolver.ts` | 同 | ✎ | 产出增加 `Resolved` 状态标记；`Discovery`/`Loader` 可替换端口抽为接口 |
| 34 | `kernel/dependency/topo-sort.ts` | 同 | ↻ | 不变 |
| 35 | `kernel/di/container.ts` | 同 | ↻ | 不变（**保持按 `token.id` 索引**，`10` E3） |
| 36 | `kernel/di/lifetime.ts` | 同 | ↻ | 不变 |
| 37 | `kernel/di/service-registry.ts` | 同 | ↻ | 不变 |
| 38 | `kernel/di/token.ts` | `kernel/di/token.ts` | ✕ | **删除**：与 `contracts/service-token.ts` 重复（需先核对内容，若仅为再导出则删） |
| 39 | `kernel/discovery/candidate.ts` | 同 | ↻ | 不变 |
| 40 | `kernel/discovery/discovery.ts` | 同 | ✎ | 加按「根目录 + mtime」的轻量缓存（O17） |
| 41 | `kernel/discovery/manifest-validator.ts` | 同 | ✎ | **新增 entry 校验**：必须以 `.js`/`.mjs` 结尾；`capabilities` → `requires`；增 `contributes` 结构校验 |
| 42 | `kernel/errors.ts` | 同 | ✎ | 增 `UnknownExtensionPointError` / `ExtensionConflictError` |
| 43 | `kernel/events/event-bus.ts` | 同 | ✎ | **桶索引 + 订阅期定序**（O16）：去掉 `collect()` 的全表 filter+sort |
| 44 | `kernel/events/pattern.ts` | 同 | ↻ | 不变（需增「按首段分桶」的辅助函数） |
| 45 | `kernel/events/priority.ts` | 同 | ✎ | 增「有序插入」辅助（供订阅期定序） |
| 46 | `kernel/index.ts` | 同 | ✎ | **只导出**：契约类型 + `definePlugin` / `defineToken` + `KernelTokens` + 错误类 + 版本常量。实现类全部移除（`09` O9） |
| 47 | `kernel/isolation/worker-bootstrap.ts` | 同 | ✎ | `instantiate` 改为调用唯一形态工厂（与 `plugin-factory` 对齐）；协议常量引用 `worker-protocol.ts` |
| 48 | `kernel/isolation/worker-host.ts` | 同 | ✎ | ① **修复权限快照 bug**：传真实 `permissions.get(pluginId)` 而非 `{granted:[],denied:[]}`；② `dispatchCtx` 增 trace span；③ 支持 `extensions` 的三类 sink 白名单 |
| 49 | `kernel/isolation/worker-plugin-proxy.ts` | 同 | ✎ | 承载 `ctx.extensions` 的受限贡献 |
| 50 | `kernel/kernel.ts` | `kernel/kernel.ts` | ✎ | 构造器不再 `new` 14 个实现类，改持 `KernelDeps`；`teardownPluginArtifacts` 增 `extensions.retractAll(pluginId)` |
| 51 | `kernel/lifecycle/lifecycle-manager.ts` | `kernel/lifecycle/manager.ts` | ↻ | 文件名对齐目录惯例 |
| 52 | `kernel/lifecycle/phases.ts` | 同 | ✎ | `PHASES` 按 `11` §4.2 的 7 段重命名；增 `satisfies Record<PluginStateT, LifecyclePhase>` 穷尽表 |
| 53 | `kernel/lifecycle/rollback.ts` | 同 | ↻ | 不变 |
| 54 | `kernel/loader/loader.ts` | 同 | ✎ | `instantiatePlugin` 调用点改为「断言工厂函数并调用」；新增 worker `permissions` 透传 |
| 55 | `kernel/loader/module-resolver.ts` | 同 | ✎ | **补全列表删除 `.ts` 与 `index.ts`**（`10` §5.1）；保留 `assertInsideRoot` |
| 56 | `kernel/loader/plugin-factory.ts` | 同 | ✎ | **90 行猜测逻辑 → ~10 行断言**（`09` O22） |
| 57 | `kernel/observability/health-service.ts` | 同 | ✎ | `registerCheck` 改为经 `health.check` 扩展点 |
| 58 | `kernel/observability/log-service.ts` | 同 | ✎ | `addSink` 改为经 `log.sink` 扩展点 |
| 59 | `kernel/observability/metrics-service.ts` | 同 | ✎ | 同上，经 `metrics.sink` |
| 60 | `kernel/observability/noop-metrics-sink.ts` | 同 | ↻ | 作为 `metrics.sink` 扩展点的宿主默认实现 |
| 61 | `kernel/observability/null-sink.ts` | 同 | ↻ | 作为 `log.sink` 扩展点的宿主默认实现 |
| 62 | `kernel/observability/tracing-service.ts` | 同 | ✎ | `addExporter` 改为经 `trace.exporter` |
| 63 | `kernel/registry/plugins-registry.ts` | 同 | ✎ | `state` 类型改用 `PluginStateT` |
| 64 | `kernel/scheduler/scheduler.ts` | 同 | ↻ | 不变（对应 `scheduler.replace` 扩展点契约） |
| 65 | `kernel/scheduler/serial-scheduler.ts` | 同 | ↻ | 作为 `scheduler.replace` 的宿主默认实现 |
| 66 | `kernel/security/capability-guard.ts` | 同 | ↻ | 不变 |
| 67 | `kernel/security/permission-manager.ts` | 同 | ✎ | `check()` 读 `manifest.requires` |
| 68 | `kernel/security/trust-policy.ts` | 同 | ✎ | `defaults`/`warnOn` 补 UI 与 sink 类能力条目 |
| 69 | `kernel/semver/range.ts` | 同 | ↻ | 不变 |
| 70 | `kernel/semver/semver.ts` | 同 | ↻ | 不变 |
| 71 | `kernel/topics.ts` | 同 | ↻ | 不变（13 个 topic） |
| 72 | `kernel/types.ts` | `kernel/state-machine.ts` | ⇢ | **拆分**：删 `PluginState` enum 与 `LoadedPluginBuilder`；状态定义迁到 `contracts/plugins.ts`；状态转移表迁到新的 `state-machine.ts` |
| 73 | `kernel/util/deep-merge.ts` | 同 | ↻ | 不变 |
| 74 | `kernel/util/disposable.ts` | 同 | ↻ | 不变 |
| 75 | `kernel/util/id.ts` | 同 | ↻ | 不变 |
| 76 | `kernel/util/timeout.ts` | 同 | ↻ | 不变 |
| 77 | `kernel/version.ts` | 同 | ↻ | 不变 |

**新增的内核文件（12 个）**

| 新路径 | 职责 |
| --- | --- |
| `kernel/extensions/registry.ts` | `ExtensionPointRegistry`：定义 / 宿主默认 / 插件贡献 / 枚举 / **按 pluginId 回收** |
| `kernel/extensions/definitions.ts` | 12 个扩展点的声明式定义表（`11` §7.2） |
| `kernel/extensions/contrib-slot.ts` | 单例槽与多贡献槽的容器语义 |
| `kernel/define-plugin.ts` | `definePlugin()` 运行时工厂（唯一插件形态入口） |
| `kernel/state-machine.ts` | 7 段逻辑状态机的转移表（`11` §4.2） |
| `kernel/composition.ts` | 默认服务装配（替代 `kernel.ts` 构造函数里的 14 个 `new`）+ 宿主默认扩展点注册 |
| `kernel/lifecycle/pipeline.ts` | 物理执行管线：逻辑状态机 × 物理序的映射（`11` §4.3） |
| `kernel/isolation/worker-protocol.ts` | Worker 消息类型的单一来源 |
| `kernel/observability/extension-sinks.ts` | log / metrics / trace 三个 sink 的扩展点桥 |
| `contracts/plugin.ts` | 插件工厂类型 |
| `contracts/extension-point.ts` | 扩展点契约 |
| `contracts/ui.ts` | UI 扩展点契约（从插件上移） |

### 1.3 运行时 / CLI（5 个文件）

| # | 旧路径 | 新路径 | 动作 | 说明 |
| --- | --- | --- | --- | --- |
| 81 | `runtime/bootstrap/args.ts` | `host/cli/args.ts` | ↻ | 不变 |
| 82 | `runtime/bootstrap/paths.ts` | `host/cli/paths.ts` | ↻ | **删除 `examplesDir()`**（仓库中无 `examples/` 目录，`11` §12.4） |
| 83 | `runtime/bootstrap/run.ts` | `host/cli/run.ts` | ✎ | 移除 `bootstrap` 选项；改用 `createDeps` 装配 |
| 84 | `runtime/ipc/ipc-bridge.ts` | `host/ipc/bridge.ts` | ✎ | 白名单从**前缀匹配**改为 **`Set<string>` 精确匹配**（`12` §4.3 的 8 个方法）；增加事件白名单 + DTO 降维转发 |
| 85 | `runtime/ipc/ipc-topics.ts` | `host/ipc/channels.ts` | ✎ | 3 个通道 → 2 个（`rem2:invoke` / `rem2:event`）+ 前后端共享的方法名/事件名常量 |

### 1.4 Electron 外壳（4 个文件）

| # | 旧路径 | 新路径 | 动作 | 说明 |
| --- | --- | --- | --- | --- |
| 5 | `electron-shell/main.ts` | `host/electron/main.ts` | ✎ | ① 删 `registerTsLoader()`（`:57-65, 71`）；② 删 `:19` 的插件源码 import；③ ThemeRegistry 注册改为经扩展点；④ `webPreferences.sandbox: true`；⑤ `Kernel` 用 `createDeps` 装配 |
| 6 | `electron-shell/preload.ts` | `host/electron/preload.ts` | ✎ | 暴露 `window.rem2 = { invoke, onEvent }`（2 个方法，替代现有 `execute` + `onBroadcast`） |
| 7 | `electron-shell/renderer.ts` | — | ✕ | **删除**：由 `src/frontend/entry-client.ts` 取代 |
| 8 | `electron-shell/theme-registry.ts` | `host/electron/theme-registry.ts` | ✎ | 类型 import 从 `plugins/theme-dark/src/index.js`（`:7-10`）改为 `kernel/contracts/ui.js`；增 `activate(themeId)` |

**新增**：`host/electron/window.ts`（`createWindow()` 抽出，含 CSP 注入与 `sandbox` 设置）。

### 1.5 转发壳与全局声明（4 个文件）

| # | 旧路径 | 新路径 | 动作 | 说明 |
| --- | --- | --- | --- | --- |
| 78 | `main.ts` | `main.ts` | ↻ | 保留（Forge 需要固定入口），内容改为 `import './host/electron/main.js'` |
| 79 | `preload.ts` | `preload.ts` | ↻ | 保留，内容改为 `import './host/electron/preload.js'` |
| 80 | `renderer.ts` | — | ✕ | **删除**（3 行转发壳，已被 `frontend/entry-client.ts` 取代） |
| 4 | `declarations.d.ts` | `declarations.d.ts` | ↻ | 保留（`forge-vite-env` 引用 + `*.css` 模块声明，前端需要） |

### 1.6 CLI（3 个文件）

| # | 旧路径 | 新路径 | 动作 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `cli/cli.ts` | `host/cli/cli.ts` | ✎ | import 路径改为同目录；删 `examplesDir` 相关分支 |
| 2 | `cli/scaffold-plugin.ts` | `host/cli/scaffold-plugin.ts` | ✎ | **必须重写生成模板**：产出 `definePlugin` 形态 + `package.json` + `tsconfig.json` + `entry: dist/index.js`（PRD Q5 / P1-6） |
| 3 | `cli/validate-manifest.ts` | `host/cli/validate-manifest.ts` | ↻ | import 路径改为 `kernel/discovery/manifest-validator` |

### 1.7 新增的前端文件（14 个）

见 `12` §2 目录树。清单：`frontend/entry-client.ts`、`app/{App,Shell,PanelHost,RouteHost}.svelte`、`app/components/{PanelShell,ThemeToggle,HealthBadge,CommandPrompt}.svelte`、`app/global.css`、`lib/{ipc-client,bridge-types,channels}.ts`、`lib/stores/{panels,routes,theme,health,command}.svelte.ts`、`lib/theme/vars.ts`。

> 上表 14 项 + `entry-client` 已计入；实际 `app/components` 下 4 个 + `app` 下 4 个 + `entry-client` 1 + `app/global.css` 1 + `lib` 3 + `lib/stores` 5 + `lib/theme` 1 = 19 个新文件。以 `12` §2 目录树为准。

### 1.8 汇总

| 类别 | 数量 |
| --- | --- |
| 移动（↻） | 30 |
| 重写（✎） | 38 |
| 删除（✕） | 3（`di/token.ts`、`electron-shell/renderer.ts`、`renderer.ts`） |
| 拆分（⇢） | 1（`types.ts` → `state-machine.ts` + 迁出） |
| 新增（➕） | 约 43（内核 12 + 前端 19 + host 2 + 插件侧 12 个 `package.json`/`tsconfig.json`） |

---

## 2. 破坏式变更清单

### 2.1 删除

| # | 删除对象 | 位置 | 理由 | 受影响方 |
| --- | --- | --- | --- | --- |
| D1 | `registerTsLoader()` 及其动态 `import('tsx/esm/api')` | `src/electron-shell/main.ts:57-65, 71` | 插件入口改为预编译产物，主进程不再需要 TS 运行时 | Electron 启动路径 |
| D2 | `src/renderer.ts` + `src/electron-shell/renderer.ts` | 3 行 + 61 行 | 由 `frontend/entry-client.ts` + Svelte 组件树取代 | `index.html:41` 的入口引用 |
| D3 | `LoadedPluginBuilder` | `src/kernel/types.ts:67-128` | 9 个 `withXxx` 只在一处用（`09` O24）；`loader.ts` 直接构造对象字面量 | `loader.ts:128-135` |
| D4 | `PluginState` enum | `src/kernel/types.ts:16-26` | 与 `PublicPluginState` 双源；真 enum 是运行期对象（`10` §五①） | `registry`、`kernel.ts:656-666`、测试 |
| D5 | `PluginApi.registerCapability` / `getCapability` / `listCapabilities` | `context/plugin-api.ts:65-76`、契约 `contracts/context.ts:37` | 能力发现退化为不可枚举的散装注册（`09` O11）；改走扩展点 | 所有 `ctx.api.registerCapability` 调用点 |
| D6 | `KernelOptions.bootstrap` | `bootstrap/options.ts:7-13, 68-70` | 死配置，`Kernel` 从不消费（`09` O23） | `defaultKernelOptions` |
| D7 | `examplesDir()` | `runtime/bootstrap/paths.ts:107` | 仓库无 `examples/` 目录 | `run.ts:5, 88` |
| D8 | `kernel/index.ts` 的 20+ 实现类导出 | `index.ts:102-135` | 契约层与实现层边界模糊（`09` O9）；插件可 `new ConfigService()` 造假内核服务 | 插件与 host 的 import |
| D9 | `PublicPluginState` | `contracts/plugins.ts:8-17` | 与 `PluginState` 双源 | `PluginsRegistryView`、`host/cli` |
| D10 | `runtime/bootstrap/` 与 `runtime/ipc/` 目录 | — | 合并进 `host/{cli,ipc}`（PRD Q3 默认假设） | 全部 import 路径 |
| D11 | `tsconfig.json` 的 `rem2-kernel/*` 通配 | `tsconfig.json:28` | 使「只走公共出口」可绕过 | 插件类型解析 |
| D12 | `kernel/di/token.ts` | — | 与 `contracts/service-token.ts` 重复（**工程师需先核对内容再删**） | — |

### 2.2 语义变更（不是删除，但会改变行为）

| # | 变更 | 旧行为 | 新行为 | 影响 |
| --- | --- | --- | --- | --- |
| C1 | 插件形态 | 4 种猜测（class / 实例 / 命名导出 / 双层 default） | **唯一**：`export default definePlugin(manifest, setup)` | 6 个示例插件全部要改写入口 |
| C2 | `manifest.entry` | `src/index.ts` | `dist/index.js`（dev/prod 同值） | 6 个 `plugin.json` |
| C3 | `manifest.capabilities` | 语义含混 | 更名 `requires`（我需要什么）+ 新增 `contributes`（我提供什么） | 6 个 `plugin.json` + `PermissionManager.check` |
| C4 | `ServiceToken` | class + 私有构造器 + `static create` | 品牌化 interface + `defineToken()` 纯函数 | 所有 `ServiceToken.create` 调用点（含 `health-http`、`theme-dark`、`tests/helpers/make-plugin.ts`） |
| C5 | 插件运行时 | **动态** `registerCapability` | **静态** `contributes` 声明 + 内核裁决 | 插件需在 `onConfigure` 前声明贡献 |
| C6 | 依赖解析 | 内核内部步骤，无对外状态 | 产生 `Resolved`/`Dropped` 状态跃迁（对外可观测） | `KernelStartResult` 增 `dropped` |
| C7 | 能力门槛 | 只在 `services.resolve` / `api.useCapability` 生效 | 扩展点贡献时也校验 `capability` | 插件贡献未授权扩展点 → Failed 而非静默 |
| C8 | Worker 插件权限 | `granted: []`（硬编码空集，**现存缺陷**） | 传真实 `permissions.get(pluginId)` | `worker-host.ts:150-153` |
| C9 | Worker 可用能力 | `ctx.services`/`api`/`plugins` 抛错 | 同上，但**类型层面可见**；新增「仅三类 sink 可贡献扩展点」 | `contracts/context.ts` + bootstrap |
| C10 | IPC 白名单 | 前缀匹配 `['command:','health:']` | `Set<string>` 精确匹配 8 个方法 | renderer 需改；`IpcBridge` 构造参数 |
| C11 | IPC 通道 | 3 个（request/response/broadcast） | 2 个（`rem2:invoke` / `rem2:event`） | `preload.ts` |
| C12 | `EventBus.emit` | 每次 O(n) filter + sort | 桶索引 + 订阅期定序 | 需保证**派发顺序语义不变**（priority 降序 → seq 升序） |
| C13 | `ConfigService.get` | 直读 snapshot，`dirty` 未用 | `dirty` 时惰性 refresh | 配置变更后插件读到新值 |
| C14 | `ConfigService.set` | 全量 refresh + 全量 deepMerge | 增量合并受影响路径 | 同上 |
| C15 | 主题契约位置 | 定义在 `plugins/theme-dark/src/index.ts` | 上移到 `kernel/contracts/ui.ts` | `theme-registry.ts` 的 import 改向；`theme-dark` 只 import 契约 |
| C16 | `Kernel` 构造 | 直接 `new` 14 个实现类 | 持 `KernelDeps`（由 `Composition.createDeps()` 创建） | `kernel.ts` 大改；`tests/fixtures/fake-kernel.ts` 可能可简化 |

### 2.3 会失效的测试及原因

> PRD A4 允许用例数减少，但需给出新旧对照与每一处差异的原因。**本轮不新增测试文件**（PRD §6.3），但下列已有文件**必须改**。

| 测试文件 | 失效原因 | 必须做的改动 |
| --- | --- | --- |
| `tests/contract/kernel-deps.test.ts` | 扫描路径 `src/kernel` + `src/runtime`（`:102-103`）在目录重排后 `src/runtime` 已不存在 → **红线静默失效**（`09` O20 / PRD §9.1） | 改为扫 `src/kernel/**` + `src/host/**`（排除 `host/electron/**`）；新增 R2（内核不得 import host/frontend/plugins）、R5（`dependencies` 为空，保留） |
| `tests/contract/plugin-contract.test.ts` | 扫描 `plugins/**/*.ts`，现在插件有 `dist/**/*.js` 产物；且规则需加「不得 `rem2-kernel/` 深链」 | 扫描范围明确为 `plugins/*/src/**`；新增 R4 第二条（禁 `rem2-kernel/` 前缀）、R7（`plugin.json` 的 entry 形态） |
| `tests/unit/lifecycle.test.ts` | 阶段名从 7 段旧名改为新状态机（`11` §4.2） | 更新 `PHASES` 断言的阶段名 |
| `tests/unit/container.test.ts` | `ServiceToken.create` → `defineToken` | 改调用点；新增不变量断言（`10` §3.3：`Object.keys` 恰为 3 键） |
| `tests/unit/hardening.test.ts` / `manifest-*.test.ts` / `topo-sort.test.ts` | `makeManifest` 默认 `entry: 'src/index.ts'`（`helpers/make-manifest.ts:35`）不再合法 | 默认改 `dist/index.js`；三处硬编码 `entry: 'src/index.ts'`（`manifest-boundary:14`、`manifest-validator:12`、`topo-sort:17`）同步 |
| `tests/helpers/make-plugin.ts` | `ServiceToken.create` + 4 种形态的 makePlugin | 改为 `definePlugin` 工厂形态 |
| `tests/helpers/tmp-plugins-dir.ts` | 默认 `entryFileName = 'src/index.ts'`（`:38`） | 默认改 `index.js`（多数集成测试已显式传 `'index.js'`，改动面小） |
| `tests/fixtures/fake-kernel.ts` | 生成的插件用 `ctx.api.registerCapability('demo', true)` | 改为 `contributes` 声明式；否则 `registerCapability` 删除后 fixture 报错（现有代码里被 `try/catch` 包住，**不会红但会静默失效** —— 必须改） |
| `tests/integration/capability-boundary.test.ts` | 断言 `THREW:CapabilityDeniedError` 的路径可能变化（现在扩展点贡献也校验能力） | 逐条复核断言；D5 删除后 `registerCapability` 调用点全清 |
| `tests/integration/worker-isolation.test.ts` | `(manifest as {isolation?}).isolation = 'worker'`（`:29`）仍可用；但 Worker 权限快照修复（C8）后断言可能需更新 | 复核权限相关断言 |
| `tests/unit/config-service.test.ts` | C13/C14 行为变更 | `get()`/`set()` 的时序断言需复核（惰性 refresh 可能让「写后立即读」由失败变成功） |
| `tests/unit/event-bus.test.ts` | C12 桶索引重写 | 派发顺序断言必须保持绿（这是语义不变性证明） |
| 其余 integration（`boot-order` / `hard-dep-fail` / `optional-dep` / `observability` / `fault-isolation*` / `reload` / `config-plugins` / `security-boundary` / `kernel-hardening`） | 生成的 fixture 已是 `.js`/`.mjs`（已核实：`boot-order`/`hard-dep-fail`/`optional-dep`/`observability`/`config-plugins`/`fault-isolation` 用 `fake-kernel.ts`，entry 已是 `index.js`），**预期无需改动** | 仅在新语义下复核 |

**用例数预期**：以 222 passing 为基线（PRD A4 / README），重构后**数量可能减少**（`registerCapability` 相关用例、`PluginState` enum 用例被删），差异原因逐条对应上表。

---

## 3. 依赖方向禁止清单（P1-2）

### 3.1 规则表

| # | 规则 | 适用范围 | 违反示例 |
| --- | --- | --- | --- |
| **D1** | `src/kernel/**` 不得 import `src/host/**`、`src/frontend/**`、`plugins/**` | 全部 kernel 文件 | `import { IpcBridge } from '../host/ipc/bridge.js'` |
| **D2** | `src/kernel/**` 不得 import 任何第三方包（只允许 `node:*` 与相对路径） | 全部 kernel 文件 | `import { defineConfig } from 'vite'` |
| **D3** | `src/host/**` 不得 import `plugins/**` 源码 | `host/electron`、`host/cli`、`host/ipc` | `import { ThemeRegistryToken } from '../../plugins/theme-dark/src/index.js'`（现状 `main.ts:19`） |
| **D4** | `src/host/electron/**` 可以 import 第三方（`electron`），但 `host/{cli,ipc}` 不可以 | host 内部 | `host/cli/run.ts` 里 `import { app } from 'electron'` |
| **D5** | `src/frontend/**` 不得 import `rem2-kernel` 或任何 `src/kernel/**` | 全部 frontend 文件 | `import { KernelTokens } from 'rem2-kernel'` |
| **D6** | `plugins/*/src/**` 只允许 import `rem2-kernel`、`node:*`、相对路径；**禁止 `rem2-kernel/` 前缀** | 插件源码 | `import { Container } from 'rem2-kernel/di/container.js'` |
| **D7** | `src/kernel/**` 不得 import `src/kernel/contracts/**` 以外的**具体实现**（`kernel.ts` 允许，因为它就是编排层） | 例外白名单见 §3.3 | — |

### 3.2 如何用测试强制

**改写 `tests/contract/kernel-deps.test.ts`**（文件名保留，内容重写）：

| 用例 | 扫描对象 | 断言 |
| --- | --- | --- |
| R1 零第三方 | `src/kernel/**` + `src/host/**` − `src/host/electron/**` | 每个 import 是 `node:*` 或相对路径 |
| R2 内核不反向依赖 | `src/kernel/**` 的 import 说明符 | 不得包含 `../host/`、`../frontend/`、`../../plugins/` |
| R3 宿主不依赖插件 | `src/host/**` + `src/frontend/**` | 不得包含 `plugins/` |
| R5 dependencies 为空 | `package.json` | `dependencies` 为 `{}` |

**改写 `tests/contract/plugin-contract.test.ts`**：

| 用例 | 扫描对象 | 断言 |
| --- | --- | --- |
| R4 插件只走公共出口 | `plugins/*/src/**/*.ts` | import ∈ {`rem2-kernel`, `node:*`, 相对路径}；**显式禁止 `rem2-kernel/` 前缀**（新规则，`tsconfig.json:28` 删除后即为类型级强制） |
| R6 前端不碰内核 | `src/frontend/**/*.ts` + `*.svelte` | import 不含 `rem2-kernel`、`src/kernel`、`src/host` |
| R7 manifest 形态 | `plugins/*/plugin.json` | `entry` 以 `.js` 或 `.mjs` 结尾 |

**扫描路径的关键修正**：现有 `collectTsFiles()`（`kernel-deps.test.ts:36-53`）用 `!entry.includes('.')` 判断是否递归进子目录 —— 这意味着**任何含点的目录名（如未来的 `v1.0/`）都会被跳过**。骨架阶段目录名无点，可接受；但需在测试里加一条**自检**：扫描到的文件数 > 阈值（现有 `expect(files.length).toBeGreaterThan(10)`，`:105`），防止路径写错导致扫不到文件而静默通过。

**新增 `tests/contract/extension-points.test.ts`？** —— PRD §6.3 规定「不新增测试文件；若架构师认为需要补契约测试，须先向用户申请」。R7 与扩展点清单一致性（A7）本应需要新文件。**建议向用户申请这一个文件的创建**，理由：A7 是明确的验收判据，而扩展点清单与 `definitions.ts` 导出一致性无法在现有两个文件里表达。

### 3.3 `kernel.ts` 的例外说明

`kernel.ts` 是编排层，**允许** import 所有具体实现（它就是要把它们装配起来）。规则 D7 的表述改为：

> `src/kernel/**` 中除 `kernel.ts` 与 `composition.ts` 外的文件，不得 import 其他子模块的**具体实现类**（`di/container`、`events/event-bus`、`config/config-service` 等）；只能 import `contracts/**` 的类型与 `extensions/**`、`util/**`、`semver/**` 的纯逻辑。

由 `09` 的 O1 改造后，`kernel.ts` 只持 `KernelDeps`，实际 new 的职责移交给 `composition.ts` —— 这两个文件是唯二的装配点。

---

## 4. tsconfig 职责划分（P1-5）

**四份配置，各管一块，不重叠。**

### 4.1 `tsconfig.json`（主配置，**开发期类型检查**）

```jsonc
{
  "compilerOptions": {
    "target": "ESNext", "lib": ["ESNext"],
    "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noImplicitAny": true, "noImplicitOverride": true,
    "noUnusedLocals": true, "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true, "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": false, "noEmit": true,
    "allowJs": false, "isolatedModules": true,
    "types": ["node"],
    "ignoreDeprecations": "6.0",
    "baseUrl": ".",
    "paths": {
      "rem2-kernel": ["src/kernel/index.ts"]
      // ★ 删除 "rem2-kernel/*": ["src/kernel/*"]（D11 / 规则 D6）
    }
  },
  "include": ["src/kernel/**/*.ts", "src/host/**/*.ts", "src/frontend/**/*.ts",
              "plugins/*/src/**/*.ts", "tests/**/*.ts", "*.mts", "*.ts"],
  "exclude": ["node_modules", "dist", "coverage", ".vite", "plugins-dist"]
}
```

| 决策 | 理由 |
| --- | --- |
| **删掉 `rem2-kernel/*` 通配** | 让「插件只能从公共出口引用内核」从**可绕过的约定**变成**类型级强制**（`10` §7）。契约测试 R4 是第二道防线 |
| **新增 `src/frontend/**`** | 消除现状 B10（`tsconfig.json:37-46` 把外壳与渲染层 exclude 掉，导致它们不在主 typecheck 覆盖内）。前端需要 DOM lib，故**新增 `tsconfig.frontend.json`**（见 §4.3），主配置用 `references` 引用而非直接 include |
| **新增 `src/host/**`** | 同上（PRD Q3 默认假设的收益之一） |
| `include` 去掉 `vitest.config.ts` 单项 | 改为 `*.ts` 通配，覆盖 `vitest.config.ts` 与未来的 `vite.shared.mts` |

> **注意**：`src/host/electron/**` 与 `src/frontend/**` 需要 DOM lib（`document`、`window`、`HTMLElement`），而内核绝不能有（否则内核能误用 `document` 而不报错）。因此主配置**不能**直接 include 它们 —— 走 `references`。

### 4.2 `tsconfig.build.json`（内核产物的**唯一**编译配置）

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "module": "NodeNext",       // ★ 保留 .js 后缀不变（10-form-evaluation E2）
    "types": ["node"]
    // ★ 不要开 rewriteRelativeImportExtensions
  },
  "include": ["src/kernel/**/*.ts"],
  "exclude": ["src/host/**", "src/frontend/**", "plugins/**", "tests/**", "*.mts"]
}
```

| 决策 | 理由 |
| --- | --- |
| **只 include `src/kernel`** | 内核是零第三方依赖的那一层，也是唯一需要对外分发 `.d.ts` 的部分。host/frontend 不进 dist |
| `declaration: true` | `10-form-evaluation` §2.2：dist 的核心价值是「类型分发 + 包身份」，`.d.ts` 是刚需 |
| `module: NodeNext` + 不改写后缀 | E2 实测：转译后文件真的是 `.js`，`./x.js` 自然成立。开了 `rewriteRelativeImportExtensions` 反而产出 `./x.ts` → Node 必炸 |
| `rootDir: "src"` | 产物落在 `dist/kernel/**`（与 `exports` 的 `default` 路径对应） |

**构建脚本**（`package.json`）：

```jsonc
"build:kernel": "tsc -p tsconfig.build.json",
"build:plugins": "node scripts/build-plugins.mjs",   // 遍历 plugins/* 调 esbuild
"build": "pnpm build:kernel && pnpm build:plugins",
"predev": "pnpm build",
"premake": "pnpm build"
```

> `scripts/build-plugins.mjs` 是新增的构建脚本（约 30 行：读 `pnpm-workspace.yaml` 的 `packages` 或直接遍历 `plugins/*`，逐个调 esbuild API，输出到 `plugins-dist/<id>/`）。**它属于构建期代码，不进 `src/`，不违反契约红线。**

### 4.3 `tsconfig.shell.json`（演进，不重建）

**现状问题**：它同时管「Electron 外壳」+「渲染层」，`include` 是 `src/main.ts / src/preload.ts / src/renderer.ts / src/electron-shell/**`（`tsconfig.shell.json:11-16`）。这三者都要 DOM lib。

**目标形态的问题**：`src/renderer.ts` 被删；`src/host/electron/**` 与 `src/frontend/**` 需要**不同的 lib 组合**（前者要 DOM + node，后者只要 DOM + DOM.Iterable，不能给 node 类型否则前端能 import `node:fs`）。

**演进方案（一份拆两份，不重复造）**：

```jsonc
// tsconfig.electron.json —— 从 tsconfig.shell.json 演进而来
{
  "//": "Electron 主进程 + preload：需要 DOM（BrowserWindow）与 node（fs/path）",
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/main.ts", "src/preload.ts", "src/host/electron/**/*.ts"]
}

// tsconfig.frontend.json —— 新增
{
  "//": "Svelte 前端：只要 DOM。刻意不给 node 类型，从类型层面阻止前端碰 Node API",
  "//why": "renderer 在 contextIsolation 下本就无 Node 能力；把这条约束落到类型上比靠自觉可靠",
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": [],                 // ★ 不给 node
    "noEmit": true,
    "moduleResolution": "Bundler",   // vite/svelte 插件需要 Bundler 解析
    "module": "ESNext",
    "verbatimModuleSyntax": true,// svelte 编译需要
    "isolatedModules": true
  },
  "include": ["src/frontend/**/*.ts", "src/frontend/**/*.svelte", "src/declarations.d.ts"]
}
```

| 决策 | 理由 |
| --- | --- |
| **一份拆两份** | 现状 `tsconfig.shell.json` 把主进程（要 node）和渲染层（不要 node）混在一起。Svelte 的 `*.svelte` import 需要 `moduleResolution: Bundler`（`NodeNext` 不认 `import App from './App.svelte'`），与主进程的要求冲突 → 必须拆 |
| `tsconfig.frontend.json` 的 `types: []` | **关键决策**：不给 `@types/node`，前端就无法 `import path from 'node:path'`。这比契约测试 R6 更早拦截 |
| `tsconfig.shell.json` **保留为 `tsconfig.electron.json`** | 演进而非重造：保留其 `lib` 与 `noEmit` 设置，只改 `include` 路径与文件名 |
| 脚本改名 | `typecheck:shell` → `typecheck:electron`；新增 `typecheck:frontend`；`typecheck:all` 串联三者 |

```jsonc
// package.json scripts
"typecheck": "tsc --noEmit -p tsconfig.json",
"typecheck:electron": "tsc --noEmit -p tsconfig.electron.json",
"typecheck:frontend": "tsc --noEmit -p tsconfig.frontend.json",
"typecheck:all": "pnpm typecheck && pnpm typecheck:electron && pnpm typecheck:frontend"
```

### 4.4 插件侧 tsconfig（约定，非根配置）

见 `07-form-evaluation.md` §7。每个 `plugins/<id>/tsconfig.json`：

```jsonc
{
  "compilerOptions": {
    "target": "ESNext", "lib": ["ESNext"],
    "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noEmit": true,          // ★ emit 交给 esbuild
    "skipLibCheck": true, "resolveJsonModule": true, "isolatedModules": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "rem2-kernel": ["../../src/kernel/index.ts"] }   // ★ 只有一条，无 /* 通配
  },
  "include": ["src/**/*.ts"]
}
```

| 决策 | 理由 |
| --- | --- |
| **不用根 tsconfig** | 根配置的 `include` 覆盖整个仓库、`paths` 面向内核自身解析、`exclude` 掉外壳。插件需要的是「只检查自己 + 能解析 rem2-kernel」的最小集 |
| `noEmit: true` | 转译由 esbuild 做；`paths` 只影响类型，产物里没有 `rem2-kernel`（被 bundle 内联） |
| **只有一条 `paths`** | 与 D11/D6 呼应。开了通配，插件就能深链内核实现 |

### 4.5 四份配置的职责边界一览

| 配置 | 管谁 | lib / types | emit | 关键约束 |
| --- | --- | --- | --- | --- |
| `tsconfig.json` | `src/kernel` + `src/host` + `tests` + `plugins/*/src` | `ESNext` + `node` | `noEmit` | 删 `rem2-kernel/*` 通配；用 `references` 引另两份 |
| `tsconfig.build.json` | 只 `src/kernel` | `ESNext` + `node` | `dist/`，`declaration: true` | 不开 `rewriteRelativeImportExtensions` |
| `tsconfig.electron.json` | `src/host/electron` + 两个转发壳 | `ESNext`+`DOM` + `node` | `noEmit` | 由 `tsconfig.shell.json` 演进 |
| `tsconfig.frontend.json` | `src/frontend`（含 `.svelte`） | `ESNext`+`DOM`，**`types: []`** | `noEmit` | `moduleResolution: Bundler`；不给 node 类型 |
| `plugins/*/tsconfig.json` | 单插件 | `ESNext` + `node` | `noEmit` | `paths` 只有一条 |

> PRD A1/A2 验收的是 `pnpm typecheck` 与 `pnpm typecheck:shell`。改造后建议保留 `typecheck:shell` 作为 `typecheck:electron` 的别名，避免验收脚本失效。

---

## 5. vite config 实质化规格

**不写完整代码，只列必须设定项。** 共享项抽到 `vite.shared.mts`（`07-form-evaluation.md` §7.2 决策 11）。

### 5.1 `vite.shared.mts`（新增）

| 必须设定 | 值 | 理由 |
| --- | --- | --- |
| `resolve.alias` | `{ 'rem2-kernel': <abs>/src/kernel/index.ts }` | 内核按源码处理；`.js`→`.ts` 由 Vite 8 内建回退（E1 实测） |
| `ssr.noExternal` | `['rem2-kernel']` | ★ **最关键一项**。默认 externalize 会让产物留下 `require('rem2-kernel')` → 打包态解析到 `.ts` → `ERR_UNKNOWN_FILE_EXTENSION`。**此错误只在打包后出现** |
| `build.sourcemap` | `true` | 与 `tsconfig.json` 的 `sourceMap: true` 对齐 |
| `build.target` | 由各 config 覆盖 | main/preload 用 `node20`，renderer 用 `chrome120` |

> ★ `resolve.conditions` **不进共享段**：Vite 8 对它是整体替换默认集，而 `node` 条件隐含 `worker`，
> 会让 renderer 把 svelte 解析到 server 入口（白屏）。main/preload 用
> `['node','import','module']`（`NODE_CONDITIONS`），renderer 用 `['browser','import','module']`。
> 详见 `04-svelte-integration.md` §7.2。

### 5.2 `vite.main.config.mts`

| 必须设定 | 值 |
| --- | --- |
| `extends` / `import` | 复用 `vite.shared.mts` |
| `build.rollupOptions.external` | `['electron']` |
| `build.target` | `'node20'`（对齐 `engines.node: '>=20'`） |
| `build.rollupOptions.input` | `src/main.ts`（保留转发壳形态，`forge.config.mts:28` 不必改） |
| `ssr.noExternal` | `['rem2-kernel']`（继承共享项） |
| `define` | 不自加；`MAIN_WINDOW_VITE_*` 由 forge 插件注入 |

### 5.3 `vite.preload.config.mts`

| 必须设定 | 值 |
| --- | --- |
| `build.rollupOptions.external` | `['electron']` |
| `build.target` | `'node20'` |
| `build.rollupOptions.output.format` | `'cjs'`（preload 必须 CJS：`contextBridge` 依赖 CommonJS 语义） |
| **产物文件名** | ★ **必须是 `preload.cjs`** —— `host/electron/main.ts` 里 `path.join(__dirname, 'preload.cjs')` 硬编码。改名会导致「preload 脚本加载失败」且**不提示是文件名问题** |
| `resolve.alias` / `ssr.noExternal` | 继承共享项 |

### 5.4 `vite.renderer.config.mts`

| 必须设定 | 值 |
| --- | --- |
| `plugins` | `[svelte()]` —— **唯一**挂 `@sveltejs/vite-plugin-svelte` 的 config（边界 B1） |
| `root` | 项目根（`index.html` 在根） |
| `build.rollupOptions.input` | `index.html` |
| `build.target` | `'chrome120'`（对齐 Electron 44 的 Chromium） |
| `resolve.alias` | 继承共享项（前端实际不 import 内核；B3 由契约测试 R6 把关） |
| `server.hmr` | 保持默认；`index.html` 的 `connect-src` 已放行 `ws://localhost:*` |
| `server.fs.allow` | 若 svelte 插件需要访问项目根，需显式允许（骨架阶段按需） |

### 5.5 `vitest.config.ts`

| 必须设定 | 值 |
| --- | --- |
| `resolve.alias` | ★ 改为 `import { KERNEL_ALIAS } from './vite.shared.mjs'`，不再独立声明（消除 `09` O21 的三处重复） |
| `test.coverage.include` | `['src/kernel/**/*.ts']`（保持） |
| `test.coverage.exclude` | 增 `src/kernel/index.ts`、`src/kernel/contracts/**`、`src/kernel/extensions/definitions.ts`（后者是纯声明表，计入覆盖率无意义） |
| `test.environment` | `'node'`（保持，内核是纯 Node 库） |
| `test.maxWorkers` / `testTimeout` | 保持（`vitest.config.ts:38-41` 的注释说明了 Windows IO 压力，必须留） |

---

## 6. `forge.config.mts` 需要改什么

| # | 改什么 | 从 | 到 | 理由 |
| --- | --- | --- | --- | --- |
| F1 | **加 `extraResource`** | 无 | `{ from: 'plugins-dist', to: 'rem2-plugins', filter: ['**/*'] }` | B6：插件根本没进包。用 `plugins-dist/`（构建产物聚合目录）而非 `plugins/`（含 `src/`、`node_modules`、`tsconfig.json`） |
| F2 | **加 `plugins` workspace** | 无 | `pnpm-workspace.yaml` 的 `packages: ['plugins/*']` | B12 / `09` O8：插件无独立 package.json → 形态无法统一 |
| F3 | `packagerConfig.asar` | `true` | **保持 `true`** | 插件经 `extraResource` 落在 asar **外**（`resources/rem2-plugins/`），因此 asar 不影响插件加载（`10` §4.2） |
| F4 | `build` 数组的 `entry` | `src/main.ts` / `src/preload.ts` | **保持** | 两个转发壳保留（`src/main.ts` 改为 `import './host/electron/main.js'`） |
| F5 | `renderer[0].name` | `'main_window'` | **保持** | `main.ts:151` 的 `loadFile` 路径依赖它 |
| F6 | `FusesPlugin` | `RunAsNode:false`、`EnableNodeOptionsEnvironmentVariable:false`、`OnlyLoadAppFromAsar:true`、`EnableEmbeddedAsarIntegrityValidation:true` | **全部保持** | `RunAsNode:false` + `EnableNodeOptionsEnvironmentVariable:false` 封死了 `NODE_OPTIONS=--import=tsx` 通道（这是**好事**，它让 D1 的删除变成必需的而非可选的） |
| F7 | **新增构建钩子** | — | `package.json` 的 `premake` 钩子跑 `pnpm build` | F1 的 `extraResource` 需要 `plugins-dist/` 已存在 |
| F8 | `makers` | 4 个（squirrel/zip/rpm/deb） | **保持** | 与本轮无关 |

---

## 7. 契约测试同步更新清单（汇总）

| # | 文件 | 动作 | 用例变化 |
| --- | --- | --- | --- |
| 1 | `tests/contract/kernel-deps.test.ts` | **重写**：`collectTsFiles` 的扫描路径改为 `src/kernel` + `src/host`（排除 `host/electron`）；新增 R2（内核不得反向依赖）；R5 保留 | 2 → 3 |
| 2 | `tests/contract/plugin-contract.test.ts` | **扩展**：扫描范围改 `plugins/*/src/**`；新增 R4-2（禁 `rem2-kernel/` 前缀）、R6（前端不碰内核）、R7（entry 形态） | 2 → 4 |
| 3 | `tests/contract/extension-points.test.ts` | **需向用户申请新增**（PRD §6.3）：A7 要求扩展点清单与 `definitions.ts` 导出一致 | 0 → 1（**需授权**） |
| 4 | `tests/unit/container.test.ts` | 改 `ServiceToken.create` → `defineToken`；新增「令牌无状态」不变量断言 | +1 |
| 5 | `tests/unit/lifecycle.test.ts` | 阶段名更新为新状态机 | 0 |
| 6 | `tests/unit/manifest-*.test.ts`（2 个）、`topo-sort.test.ts` | `entry: 'src/index.ts'` → `'dist/index.js'` | 0 |
| 7 | `tests/helpers/make-manifest.ts` | 默认 `entry` 改 `dist/index.js`；`capabilities` → `requires` | — |
| 8 | `tests/helpers/tmp-plugins-dir.ts` | 默认 `entryFileName` 改 `index.js` | — |
| 9 | `tests/helpers/make-plugin.ts` | 改 `definePlugin` 形态；`ServiceToken.create` → `defineToken` | — |
| 10 | `tests/fixtures/fake-kernel.ts` | 生成的插件改 `contributes` 声明式（现有 `registerCapability` 被 try/catch 包住，**不会红但会静默失效**） | — |
| 11 | `tests/unit/config-service.test.ts` | 复核 C13/C14 的时序断言 | 可能 −N |
| 12 | `tests/unit/event-bus.test.ts` | 派发顺序断言必须保持绿（桶索引重写的语义不变性证明） | 0 |
| 13 | `tests/integration/*.test.ts`（12 个） | 逐条复核（见 §2.3 表） | 可能 −N |

**用例数预期说明**（PRD A4 要求给出新旧对照与原因）：

| 变化 | 原因 |
| --- | --- |
| **−N**：`registerCapability` 相关用例 | D5 删除该 API，`fake-kernel.ts:60-62` 的 fixture 调用被 try/catch 吞掉，相关断言失效 |
| **−N**：`PluginState` enum 直接引用 | D4 删除 enum，改用 `PluginStateT` 字符串联合 |
| **−N**：`KernelOptions.bootstrap` 相关用例（若有） | D6 删除死配置 |
| **+2**：`kernel-deps` 加 R2、`plugin-contract` 加 R4-2/R6/R7 | §7 表格第 1、2 行 |
| **+1**：`container.test` 的令牌不变量断言 | `10` §3.3 |
| **±0**：其余 integration | fixture 本就是 `.js`/`.mjs`（已核实），预期不受影响 |

---

## 8. 工程师施工顺序建议

> 依赖顺序，每组完成后应 `pnpm typecheck` 通过。

| 组 | 内容 | 阻塞于 |
| --- | --- | --- |
| **G1** | 配置文件：`tsconfig.build.json` / `tsconfig.electron.json` / `tsconfig.frontend.json` / `tsconfig.json` 改 / `vite.shared.mts` / 三个 vite config / `forge.config.mts` / `package.json` scripts / `pnpm-workspace.yaml` | 无（**先做，因为后续所有 typecheck 都依赖它**） |
| **G2** | 契约层：`contracts/` 全部（含新增 `plugin.ts` / `extension-point.ts` / `ui.ts`）+ `define-plugin.ts` + `types.ts` 拆分 | G1 |
| **G3** | 扩展点：`extensions/` 三个文件 + `observability/extension-sinks.ts` + 各服务的 sink 桥接改造 + `context/` 注入 `extensions` | G2 |
| **G4** | 内核实现：`composition.ts` 抽出 + `kernel.ts` 改造 + `events/` 桶索引 + `config/` 惰性 refresh + `lifecycle/` 阶段重命名 + `state-machine.ts` + `lifecycle/pipeline.ts` + `loader/` 形态收敛 + `manifest-validator` entry 校验 + `isolation/` 权限修复 | G3 |
| **G5** | 宿主：`host/{electron,cli,ipc}` 全部 + 删 3 个转发壳 + `index.html` 入口改 | G4 |
| **G6** | 前端：`frontend/` 全部 19 个文件 + `tsconfig.frontend.json` 落地 | G5 |
| **G7** | 插件侧：6 个 `package.json` + 6 个 `tsconfig.json` + 6 个 `plugin.json` 改 entry/capabilities + 6 个 `src/index.ts` 改 `definePlugin` 形态 + `scripts/build-plugins.mjs` | G4（内核契约稳定后才能改插件） |
| **G8** | 测试：按 §7 清单逐个改 | G1–G7 |

**并行可能**：G6 与 G7 可并行（互不依赖）。G8 中「纯 fixture 形态改动」可与 G7 并行。

---

## 9. 需要确认的事项

1. **是否批准新增 `tests/contract/extension-points.test.ts`**？PRD §6.3 规定不新增测试文件、需先申请。但 A7（扩展点清单与代码导出一致性）需要它。**建议批准这一个文件**。
2. **`typecheck:shell` 是否改名 `typecheck:electron`？** PRD A2 的验收命令是 `pnpm typecheck:shell`。建议**保留旧名作为别名**以免 A2 验收脚本失效。
3. **`ui.panel` 采用「声明式描述 + 宿主渲染 chrome」是我的裁决**（`11` §7.1），非 PRD 指定。若用户要求插件可提供真正的 Svelte 组件，需追加 `ui.component` 扩展点 + 插件侧 Svelte 构建链 + renderer 组件注册表，工作量远超骨架阶段。**建议开工前确认**。
4. **C8（Worker 权限快照修复）是否纳入本轮**？它是现存缺陷（`worker-host.ts:150-153` 硬编码 `{granted:[],denied:[]}`，导致 Worker 插件永远认为无权限），但不在 PRD 的 P0 列表内。修复只需 1 处（Kernel 把 `permissions.get(pluginId)` 透传给 `workerFacilities`），建议**顺手修**。
5. **新增构建脚本 `scripts/build-plugins.mjs` 的位置**：本规格放在 `scripts/`（构建期代码，不进 `src/`）。若团队约定构建脚本放 `tools/` 或根目录，请统一。