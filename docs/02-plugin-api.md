# 02 · 插件开发指南

> 面向插件作者的公共契约参考。**唯一合法导入源是 `rem2-kernel`**，禁止深链 `src/kernel/**` 内部实现（`tests/contract/plugin-contract.test.ts` R4 强制）。
>
> 配套：[`01-architecture-overview.md`](01-architecture-overview.md)（整体架构与边界）、[`04-development-guide.md`](04-development-guide.md)（构建、校验、排障）。
>
> English: [`en/02-plugin-api.md`](en/02-plugin-api.md)

---

## 1. 一个最小插件

```ts
// plugins/my-plugin/src/index.ts
import { definePlugin } from 'rem2-kernel'
import type { PluginContext } from 'rem2-kernel'

export default definePlugin(
  { id: 'com.example.my-plugin', name: 'My Plugin', version: '0.1.0' },
  (ctx: PluginContext) => ({
    async onStart(): Promise<void> {
      ctx.log.info('plugin started')
    },
  }),
)
```

目录固定四件：

```
plugins/my-plugin/
├── package.json        # @rem2/plugin-my-plugin，private，exports 指向 dist
├── tsconfig.json       # 独立配置（不继承根 tsconfig）
├── plugin.json         # 清单：entry 指向**构建产物**
└── src/index.ts
```

---

## 2. 唯一形态：`definePlugin(manifest, setup)`

只有工厂一种形态 —— class 导出、已实例化单例、命名导出都不被接受。`loader` 只做一次断言，不做形态猜测。

| 参数       | 类型                          | 说明                                                                                                |
| ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `manifest` | `PluginManifestInit`          | 内联清单。**权威来源是 `plugin.json`**；内联值只用于漂移检测，`id` 不一致抛 `ManifestMismatchError` |
| `setup`    | `(ctx) => PluginFactoryHooks` | 钩子工厂，`import()` 后调用一次                                                                     |

约束：

- `manifest.id` 必须是非空字符串，否则 `definePlugin` 直接抛 `ManifestError`。
- `setup` 必须是函数，否则抛 `TypeError`。
- 工厂对象会被 `Object.freeze`；内联 manifest 以只读属性挂在工厂上。

---

## 3. 清单（`plugin.json`）

| 字段                                            | 类型                         | 必填 | 说明                                                                 |
| ----------------------------------------------- | ---------------------------- | ---- | -------------------------------------------------------------------- |
| `id`                                            | `string`                     | ✅   | `^[a-z0-9]+([._-][a-z0-9]+)*$`，建议 reverse-DNS                     |
| `name`                                          | `string`                     | ✅   | 展示名                                                               |
| `version`                                       | `string`                     | ✅   | semver                                                               |
| `entry`                                         | `string`                     | ✅   | **构建产物相对路径，恒为 `dist/index.js`**，只允许 `.js` / `.mjs`    |
| `compatibility`                                 | `object`                     | ✅   | `{ minKernel, contractVersion }`；`maxKernel` 可选                   |
| `dependencies`                                  | `Record<string,string>`      |      | 硬依赖：缺失或版本不符 → 本插件 `Failed`                             |
| `optionalDependencies`                          | `Record<string,string>`      |      | 软依赖：缺失 → `Degraded`，其余功能仍可用                            |
| `contributes`                                   | `{point, id, capability?}[]` |      | **静态声明**贡献哪些扩展点（与运行期 `contribute` 对齐）             |
| `requires`                                      | `string[]`                   |      | 能力声明，`PermissionManager.check` 的输入，如 `['command.provide']` |
| `isolation`                                     | `'in-process' \| 'worker'`   |      | 默认 `in-process`                                                    |
| `configSchema`                                  | `object`                     |      | 内核不解释，透传给插件                                               |
| `author` `description` `icon` `tags` `homepage` | —                            |      | 元信息，内核不使用                                                   |

```jsonc
// plugins/my-plugin/plugin.json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "optionalDependencies": { "com.rem2.logger-console": "^1.0.0" },
  "contributes": [{ "point": "command.provide", "id": "greet" }],
  "requires": ["command.provide"],
  "compatibility": { "minKernel": "^1.0.0", "contractVersion": "1" },
}
```

`manifest-validator` 在**发现阶段**校验清单，本地安装与远程 ZIP 包复用同一校验器；`manifest.schema.json` 是同一套规则的 JSON Schema 版本。改校验规则必须同时改两处。

安装 / 启停 / 卸载、用户插件目录、状态与路径安全见 [`05-plugin-management.md`](05-plugin-management.md)。本地安装只接受已构建目录，远程安装只接受带可信摘要的 ZIP 包；两者都默认禁用，不执行插件代码。

### 3.1 `entry` 为什么必须是 `dist/index.js`

内核用运行时 `import()` 装载插件，这条路径不经过任何打包器，磁盘上必须是 Node 原生可解析的真实文件。Node 不会把 `./x.js` 映射到 `x.ts`（`ERR_MODULE_NOT_FOUND`）。

因此 `entry` 在 dev 与 prod 完全相同，没有双形态、没有环境变量切换。代价是改完源码必须 `pnpm build:plugins`。

---

## 4. 生命周期钩子

`PluginFactoryHooks` 的全部钩子（均可选）：

| 钩子                  | 阶段       | 语义                                                                       |
| --------------------- | ---------- | -------------------------------------------------------------------------- |
| `onDiscover(ctx)`     | Discover   | 只读探测。**禁止副作用**（无写 IO、无注册）                                |
| `onLoad(ctx)`         | Load       | 模块已实例化，只做内存态准备                                               |
| `onConfigure(ctx)`    | Initialize | 读配置、注册服务、订阅事件（失败可回滚）                                   |
| `onStart(ctx)`        | Start      | 启动运行时（开连接、起定时器、贡献扩展点）。必须在 `startTimeoutMs` 内完成 |
| `onStop(ctx, reason)` | Stop       | 幂等停止，释放运行时资源                                                   |
| `onUnload(ctx)`       | Unload     | 注销服务与事件订阅                                                         |
| `onDispose(ctx)`      | Dispose    | 最终释放，之后实例不可再用                                                 |
| `onHealthCheck()`     | —          | 返回 `HealthStatus`，由健康服务周期性调用                                  |

`onStop` 的 `reason`：`'user-disable' | 'reload' | 'dependency-failed' | 'health-degraded' | 'shutdown' | 'start-failed' | 'timeout'`。

**失败语义**：

- `Load` / `Initialize` / `Start` 失败是**致命**的 → 逆序回滚已执行阶段 → 插件 `Failed`。
- `Discover` 失败或软依赖缺失是**非致命**的 → `Degraded`，其余插件继续运行。健康信息会写明缺失项：`missing optional dependency: <id>`。
- 软依赖随后被启用时，内核会重新评估并把该插件恢复为 `Active`（无需重启插件服务）；`enablePlugin` 幂等，可在 `Degraded` 状态上再次调用以强制重算。
- 仅因软依赖缺失而 `Degraded` 的插件会被记录；`Active` / `Failed` / 卸载后自动清除该记录，避免误恢复。

---

## 5. `PluginContext`：插件能拿到什么

| 字段          | 用途                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `pluginId`    | 本插件 id                                                                                  |
| `manifest`    | 规范化后的清单                                                                             |
| `phase`       | 当前生命周期阶段（只读）                                                                   |
| `container`   | 本插件的 DI 子容器（父容器不可达）                                                         |
| `services`    | 注册 / 解析服务（解析经 `CapabilityGuard` 校验）                                           |
| `events`      | 全局事件总线：`emit` / `on` / `once` / `request` / `respond`                               |
| `config`      | 配置只读访问：`get` / `getOrThrow` / `has` / `onDidChange`                                 |
| `log`         | 插件作用域日志器：`trace` … `fatal`                                                        |
| `metrics`     | 指标 API：`counter` / `gauge` / `histogram`                                                |
| `permissions` | 本插件被授予的权限集（只读快照）                                                           |
| `extensions`  | **贡献扩展点（见 §6）**                                                                    |
| `api`         | `export` / `unexport` / `useCapability`                                                    |
| `plugins`     | 探测其他插件（软依赖的运行期探测）                                                         |
| `resolvePath` | 解析到插件 rootDir 内部，越界抛 `EntryEscapeError`                                         |
| `dataPath`    | 解析到宿主提供的可写插件数据目录（`pluginDataRoot/<pluginId>`），越界抛 `EntryEscapeError` |

---

## 6. 扩展点：贡献能力的唯一入口

能力贡献只有一条路：向扩展点槽 `contribute`。以下是插件最常用的写法：

```ts
ctx.extensions.contribute('command.provide', {
  contributionId: 'hello',
  impl: async (args: unknown) => {
    const name = (args as { name?: string })?.name ?? 'rem2-kernel'
    return { ok: true, output: `Hello, ${name}!` }
  },
})
```

### 6.1 12 个扩展点

| id                  | 契约                     | 槽     | 冲突裁决                         | capability         |
| ------------------- | ------------------------ | ------ | -------------------------------- | ------------------ |
| `log.sink`          | `LogSink`                | multi  | —                                | —                  |
| `metrics.sink`      | `MetricSink`             | multi  | —                                | —                  |
| `trace.exporter`    | `TraceExporter`          | multi  | —                                | —                  |
| `config.provider`   | `ConfigProvider`         | multi  | —                                | `config.provide`   |
| `command.provide`   | `CommandHandler`         | multi  | 同 id → `ExtensionConflictError` | `command.provide`  |
| `health.check`      | `HealthCheckFn`          | multi  | —                                | —                  |
| `ui.theme`          | `ThemeDefinition`        | multi  | 同 id → `reject-new`             | `ui.theme`         |
| `ui.panel`          | `PanelContribution`      | multi  | 同 id → `reject-new`             | `ui.panel`         |
| `ui.route`          | `RouteContribution`      | multi  | 同 path → `replace-old`          | `ui.route`         |
| `scheduler.replace` | `Scheduler`              | single | `replace-old`                    | `kernel.internals` |
| `resolver.replace`  | `DependencyResolverPort` | single | `replace-old`                    | `kernel.internals` |
| `loader.replace`    | `PluginLoaderPort`       | single | `replace-old`                    | `kernel.internals` |

契约类型的权威定义在 `src/kernel/contracts/`（`ui.ts` / `logging.ts` / `metrics.ts` / `tracing.ts` / `config.ts` / `health.ts`）。

**multi 槽按 `contributionId` 去重**：同一 multi 槽里重复的 contributionId 抛 `ExtensionConflictError`（`conflict` 策略只对 singleton 槽有意义 —— 单例槽才需要裁决「谁留下」，multi 槽的语义是「同 id 即同一个贡献，重复即冲突」）。

### 6.2 三条硬规则

1. **未知 point id 抛 `UnknownExtensionPointError`** —— 拼错不会被静默忽略。
2. **扩展点声明了 `capability` 而你没获授 → `CapabilityDeniedError`**。贡献本身受能力约束，`plugin.json` 的 `requires` 必须覆盖。
3. **回收由内核强制**：卸载时按 `pluginId` 撤回你的全部贡献，即使你从不调 `retract` 也不会泄漏。别把回收逻辑写成插件侧的责任。

### 6.3 UI 类扩展点是「声明式描述」

`ui.panel` / `ui.route` 只接受数据（id / 标题 / 图标 / 区域 / 排序 / 关联命令），**插件不提供 Svelte 组件**，chrome 由宿主渲染。理由：插件侧引入 Svelte 构建链、CSP 下的动态 import 白名单、组件版本耦合，三条都与「极小内核」冲突。

### 6.4 Worker 插件能贡献什么

只允许 `log.sink` / `metrics.sink` / `trace.exporter`，且值必须可结构化克隆（`isolation/worker-protocol.ts` → `WORKER_ALLOWED_EXTENSION_POINTS`）。贡献 UI 类扩展点会抛错。

---

## 7. 服务与令牌

```ts
import { defineToken } from 'rem2-kernel'

export interface Greeter {
  greet(name: string): string
}

export const GreeterToken = defineToken<Greeter>({
  id: 'plugin.hello.greeter',
  capability: 'command.provide', // 可选：解析该服务所需能力
  describe: 'greeting service',
})
```

- `defineToken()` 是**纯函数**，返回品牌化对象；令牌的身份是 `unique symbol` 类型品牌，没有构造器、没有静态工厂。
- 解析服务经 `CapabilityGuard` 校验，未授权抛 `CapabilityDeniedError`。
- 服务默认**不泄漏**到父容器：要给别人用必须 `ctx.api.export(token)`。
- 兄弟插件只有在对方 `export` 后才解析得到；root 容器用 `shareable: true` 才能被子容器解析。

内核自带令牌见 `KernelTokens`（共 16 个）：`EventBus` / `Config` / `ConfigService` / `Log` / `Metrics` / `Tracer` / `Health` / `Permissions` / `Plugins` / `Scheduler` / `Resolver` / `Discovery` / `Loader` / `CapabilityGuard` / `Extensions` / `UiThemeRegistry`。

---

## 8. 命令链路：如何让前端能调用你

命令走 **contribute + dispatcher** 模式：插件把命令贡献进 `command.provide` 扩展点，内核 `CommandDispatcher` 是 `command.execute` 的唯一 responder（宿主实现为 `null`），按 `contributionId === command` 查槽并原样返回 handler 的返回值。

```ts
import { Topics } from 'rem2-kernel'

// 唯一入口：贡献扩展点。不要再 bus.respond(Topics.CommandExecute) ——
// 内核 dispatcher 在 start() 注册得更早，按 seq 会遮蔽插件侧 responder。
ctx.extensions.contribute('command.provide', {
  contributionId: 'hello',
  impl: async (args: unknown) => {
    const name = (args as { name?: string })?.name ?? 'rem2-kernel'
    return { ok: true, output: `Hello, ${name}!` }
  },
})
```

返回值形状就是前端看到的东西：`{ok: true, output}` → 展示 output；`{ok: false, error}` → 展示错误。未知命令由 dispatcher 返回 `{ok:false, error:'unknown command: …'}`（显式错误，不抛 `NoResponderError`、不递归）。

为什么不是「插件直接 respond topic」：宿主 responder 与请求的 topic 同名（`Topics.CommandExecute` 的值就是 `'command.execute'`）时，一次转发实现失误就会让请求命中自己 → 无限递归 `RangeError`（真实事故）。dispatcher 直接读扩展槽、从不请求同名 topic，递归在结构上不可能；单一分发路径也让「哪条命令由谁提供」在扩展点清单里可枚举。

**topic 一律用 `Topics` 常量，禁止手抄字符串。** 另一条已知事故模式：插件用冒号写 topic（`'command:execute'`）而内核用点号（`'command.execute'`）。匹配器把两者都当段分隔符，所以「碰巧能用」；这属于巧合，不要依赖。

---

## 9. 构建

```bash
pnpm build:plugins          # esbuild bundle 全部插件 → plugins-dist/<id>/dist/index.js
```

- `plugins/*/package.json` 是 pnpm workspace 成员（`@rem2/plugin-<id>`，private）。
- 插件侧 `tsconfig.json` **独立**，只声明 `paths: { "rem2-kernel": ["../../src/kernel/index.ts"] }`。内核的 `NodeNext` + DOM 排除策略不适用于插件，继承根配置会连测试与前端一起拉进来。
- 打包形态是自包含 ESM bundle（`target: node20`），dev 与 prod 完全一致。

---

## 10. 隔离模式

| 模式                 | 说明                                           |
| -------------------- | ---------------------------------------------- |
| `in-process`（默认） | 与内核同进程同 realm，性能最高                 |
| `worker`             | 独立 Node Worker 线程，内核经 RPC 驱动生命周期 |

**Worker 内可用**：`log` / `config`（init 快照 + 变更推送，只读）/ `events`（`emit` / `on` / `request`）/ `metrics` / `permissions`（快照）/ `resolvePath` / `dataPath`。
**Worker 内不可用**（调用即抛错）：`services` / `api` / `plugins` / `container` / `events.respond`。跨插件协作只能走事件总线。

Worker 隔离是**故障隔离**（挡住崩溃与死循环），**不是安全沙箱** —— Worker 内代码仍有完整 Node 能力。安全边界由内核侧 `CapabilityGuard` 把守「能触达哪些内核设施」。

---

## 11. 错误码

全部内核错误继承 `KernelError`，携带稳定 `code`：

| 分类        | 码                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 清单 / 加载 | `E_INVALID_MANIFEST` · `E_MANIFEST_MISMATCH` · `E_ENTRY_ESCAPE` · `E_LOAD_FAILED`                                              |
| 依赖解析    | `E_DUPLICATE_ID` · `E_MISSING_DEPENDENCY` · `E_VERSION_MISMATCH` · `E_CYCLE` · `E_INCOMPATIBLE`                                |
| 服务 / DI   | `E_NO_PROVIDER` · `E_CIRCULAR_DEPENDENCY` · `E_SCOPED_ACCESS`                                                                  |
| 安全 / 扩展 | `E_CAPABILITY_DENIED` · `E_UNKNOWN_EXTENSION_POINT` · `E_EXTENSION_CONFLICT`                                                   |
| 运行期      | `E_TIMEOUT` · `E_LIFECYCLE` · `E_ILLEGAL_TRANSITION` · `E_NO_RESPONDER` · `E_NOT_WRITABLE` · `E_ALREADY_STARTED` · `E_GENERIC` |

权威来源：`src/kernel/errors.ts`。

---

## 12. 自检清单

- [ ] `entry` 指向 `dist/index.js`，不是 `src/index.ts`
- [ ] 只从 `rem2-kernel` / `node:*` / 相对路径导入
- [ ] topic 用 `Topics` 常量，不手抄字符串
- [ ] 能力经 `ctx.extensions.contribute` 贡献，不用其他通道
- [ ] `plugin.json` 的 `contributes` 与运行期 `contribute` 一致
- [ ] 需要的扩展点能力已写进 `requires`
- [ ] 令牌用 `defineToken()`
- [ ] `pnpm cli validate plugins/<id>/plugin.json` 通过
- [ ] `pnpm build:plugins` 产出 `plugins-dist/<id>/dist/index.js`
