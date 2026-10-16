# 02 · 插件开发指南

> 面向插件作者的**公共契约参考**。
> 唯一合法导入源：`rem2-kernel`。**禁止**深链 `src/kernel/**` 内部实现 —— 由 `tests/contract/plugin-contract.test.ts` 的 R4-1 / R4-2 强制。
> 本文描述**当前磁盘上的真实 API**，与 `docs/01-architecture-overview.md`（整体架构）配套阅读。

---

## 1. 一个最小插件

```ts
// plugins/my-plugin/src/index.ts
import { definePlugin } from 'rem2-kernel';
import type { PluginContext } from 'rem2-kernel';

export default definePlugin(
  { id: 'com.example.my-plugin', name: 'My Plugin', version: '0.1.0' },
  (ctx: PluginContext) => ({
    async onStart(): Promise<void> {
      ctx.log.info('插件已启动');
    },
  }),
);
```

对应目录结构：

```
plugins/my-plugin/
├── package.json        # @rem2/plugin-my-plugin，private，exports 指向 dist
├── tsconfig.json       # 独立配置（不继承根 tsconfig）
├── plugin.json         # 清单：entry 指向**构建产物**
└── src/index.ts
```

---

## 2. 唯一形态：`definePlugin(manifest, setup)`

**只有一种形态**。不再支持 class 导出、已实例化单例、命名导出 `plugin` —— 那些猜测逻辑已从 loader 中删除（`src/kernel/loader/plugin-factory.ts` 从 90 行缩到 42 行）。

`setup` 在插件被 `import()` 后调用一次，返回钩子对象。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `manifest` | `PluginManifestInit` | 内联清单。**权威来源是 `plugin.json`**；内联值仅用于漂移检测，`id` 不一致会抛 `ManifestMismatchError` |
| `setup` | `(ctx) => PluginFactoryHooks` | 钩子工厂 |

> 为什么是工厂而非 class：tree-shaking 友好（setup 是闭包）、loader 只需一行断言、与 esbuild 的 ESM 产物对齐。

---

## 3. 清单（`plugin.json`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | ✅ | reverse-DNS 风格，`^[a-z0-9]+([._-][a-z0-9]+)*$` |
| `name` | `string` | ✅ | 展示名 |
| `version` | `string` | ✅ | semver |
| `entry` | `string` | ✅ | **构建产物相对路径，恒为 `dist/index.js`** |
| `compatibility` | `object` | ✅ | `{ minKernel, contractVersion }`；`maxKernel` 可选 |
| `dependencies` | `Record<string,string>` | | 硬依赖：缺失或版本不符 → 本插件失败 |
| `optionalDependencies` | `Record<string,string>` | | 软依赖：缺失 → 本插件进入 `Degraded`，其余功能仍可用 |
| `capabilities` | `string[]` | | 能力声明，如 `['command.provide']` |
| `isolation` | `'in-process' \| 'worker'` | | 默认 `in-process`。`worker` 在独立线程运行，崩溃不拖垮内核 |
| `configSchema` | `object` | | 内核不解释，透传给插件 |

```jsonc
// plugins/my-plugin/plugin.json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "dependencies": {},
  "capabilities": ["command.provide"],
  "compatibility": { "minKernel": "^1.0.0", "contractVersion": "1" }
}
```

### ★ `entry` 为什么必须是 `dist/index.js`

内核用**运行时 `import()`** 装载插件（`src/kernel/loader/loader.ts`），这条路径**不经过 Vite**，所以磁盘上必须是 Node 原生可解析的真实文件。实测：Node 无法解析 `./x.js` 指向 `.ts`（`ERR_MODULE_NOT_FOUND`）。

因此 `entry` **dev 与 prod 完全相同**，没有双形态、没有环境变量切换。代价是改完 `.ts` 必须 rebuild：

```bash
pnpm build:plugins          # 全量
# 或开发时并行 watch（esbuild 已在 node_modules/.bin）
```

---

## 4. 生命周期钩子

`PluginFactoryHooks` 的全部钩子（均可选）：

| 钩子 | 阶段 | 语义 |
| --- | --- | --- |
| `onDiscover(ctx)` | Discover | 只读探测。**禁止副作用**（无 IO 写、无注册） |
| `onLoad(ctx)` | Load | 模块已实例化，只做内存态准备 |
| `onConfigure(ctx)` | Initialize | 读配置、注册服务、订阅事件（**可回滚**） |
| `onStart(ctx)` | Start | 启动运行时（开连接、起定时器、挂 UI）。必须在 `startTimeoutMs` 内完成 |
| `onStop(ctx, reason)` | Stop | 幂等停止，释放运行时资源 |
| `onUnload(ctx)` | Unload | 注销服务与事件订阅 |
| `onDispose(ctx)` | Dispose | 最终释放，之后实例不可再用 |
| `onHealthCheck()` | — | 返回 `HealthStatus`，由健康服务周期性调用 |

`onStop` 的 `reason` 取值：`'user-disable' | 'reload' | 'dependency-failed' | 'health-degraded' | 'shutdown' | 'start-failed' | 'timeout'`。

**失败语义**：`Load` / `Initialize` / `Start` 失败是致命的 → 回滚已执行阶段，插件进入 `Failed`；`Discover` 失败或软依赖缺失是非致命的 → 插件进入 `Degraded`，其余功能继续运行。

---

## 5. `PluginContext`：插件能拿到什么

| 字段 | 用途 |
| --- | --- |
| `pluginId` | 本插件 id |
| `manifest` | 规范化后的清单 |
| `phase` | 当前生命周期阶段（只读） |
| `container` | 本插件的 DI 子容器 |
| `services` | 注册 / 解析服务（解析经 CapabilityGuard 校验） |
| `events` | 全局事件总线（`emit` / `on` / `once` / `request` / `respond`） |
| `config` | 配置只读访问（`get` / `getOrThrow` / `has` / `onDidChange`） |
| `log` | 插件作用域日志器（`trace` … `fatal`） |
| `metrics` | 指标 API（`counter` / `gauge` / `histogram`） |
| `permissions` | 本插件被授予的权限集 |
| **`extensions`** | **贡献扩展点（见 §6）** |
| `api` | `export` / `unexport` / `useCapability` |
| `plugins` | 探测其他插件（软依赖运行期探测） |

---

## 6. 扩展点：贡献能力的唯一入口

**`registerCapability` 已删除。** 贡献能力统一走扩展点注册表：

```ts
ctx.extensions.contribute('command.provide', {
  contributionId: 'hello',
  impl: async (args: unknown) => {
    const name = (args as { name?: string })?.name ?? 'rem2';
    return { ok: true, output: `Hello, ${name}!` };
  },
});
```

### 12 个扩展点

| id | 契约 | 单例/多贡献 | 冲突裁决 | capability |
| --- | --- | --- | --- | --- |
| `log.sink` | `LogSink` | multi | — | — |
| `metrics.sink` | `MetricSink` | multi | — | — |
| `trace.exporter` | `TraceExporter` | multi | — | — |
| `config.provider` | `ConfigProvider` | multi | — | `config.provide` |
| `command.provide` | `CommandHandler` | multi | 同 id → 抛 `ExtensionConflictError` | `command.provide` |
| `health.check` | `HealthCheckFn` | multi | — | — |
| `ui.theme` | `ThemeDefinition` | **single** | `keep-first` | `ui.theme` |
| `ui.panel` | `PanelContribution` | multi | 同 id → `reject-new` | `ui.panel` |
| `ui.route` | `RouteContribution` | multi | 同 path → `replace-old` | `ui.route` |
| `scheduler.replace` | `Scheduler` | single | `replace-old` | `kernel.internals` |
| `resolver.replace` | `DependencyResolverPort` | single | `replace-old` | `kernel.internals` |
| `loader.replace` | `PluginLoaderPort` | single | `replace-old` | `kernel.internals` |

**回收由内核强制**：插件卸载时按 `pluginId` 撤回其**全部**贡献（`ExtensionPointRegistry.retractAll`），插件即使漏调 `retract` 也不会泄漏。

> `ui.panel` / `ui.route` 采用**声明式描述 + 宿主渲染 chrome**：插件只贡献数据（id / 标题 / 区域 / 排序 / 关联命令），**不提供 Svelte 组件`**。

---

## 7. 服务与令牌

```ts
import { defineToken } from 'rem2-kernel';
import type { Greeter } from './greeter.js';

export const GreeterToken = defineToken<Greeter>({
  id: 'plugin.hello.greeter',
  capability: 'command.provide',   // 可选：声明该服务所需能力
  describe: '问候服务',
});
```

- `defineToken()` 是**纯函数**，返回品牌化对象。不是 class —— 没有 `new ServiceToken()`。
- 解析服务经 CapabilityGuard 校验；未授权抛 `CapabilityDeniedError`。
- 服务默认**不泄漏**到父容器，需显式 `ctx.api.export(GreeterToken)`。

内核提供的令牌见 `KernelTokens`（`EventBus` / `Config` / `Log` / `Metrics` / `Tracer` / `Health` / `Plugins` 等 15 个）。

---

## 8. 命令链路（如何让前端能调用你）

插件通过**事件总线 responder** 提供命令，前端经 IPC 白名单调用：

```ts
const bus = ctx.events;

bus.respond<{ command: string }, { ok: boolean; output?: string }>(
  'command.execute',                       // ★ 用 Topics.CommandExecute，勿手抄
  (p) => {
    if (p.command !== 'hello') return { ok: false, error: `未知命令：${p.command}` };
    return { ok: true, output: 'Hello, rem2!' };
  },
);
```

**返回值形状决定前端显示什么**：`{ ok: true, output: '...' }` → 前端显示 `output`；`{ ok: false, error: '...' }` → 显示错误。

> ⚠️ **topic 名必须用 `Topics` 常量，不要手抄字符串。** 曾因宿主用 `'command.execute'` 注册 responder 却 `request(Topics.CommandExecute)`（而后者值就是 `'command.execute'`）导致无限递归 `RangeError`；也曾因插件用冒号 `'command:execute'` 而内核用点号 `'command.execute'` 导致「无响应者」。现在 `tests/contract/plugin-contract.test.ts` 会断言白名单名与 `Topics.CommandExecute` 一致。

---

## 9. 构建

```bash
pnpm build:plugins        # esbuild bundle 全部插件 → plugins-dist/<id>/dist/index.js
```

`plugins/*/package.json` 是 pnpm workspace 成员（`@rem2/plugin-<id>`，private）。插件侧 `tsconfig.json` **不继承**根配置 —— 内核的 `NodeNext` + DOM 排除策略不适用于插件。

---

## 10. 隔离模式

| 模式 | 说明 |
| --- | --- |
| `in-process`（默认） | 与内核同进程同 realm，性能最高 |
| `worker` | 独立 Node Worker 线程，内核经 RPC 驱动生命周期 |

**Worker 内可用**：`log` / `config`（init 快照，只读）/ `events`（`emit` / `on` / `request`）/ `metrics`。
**Worker 内不可用**（调用即抛错）：`services` / `api` / `plugins` / `container` / `events.respond`。跨插件协作必须走事件总线。

> 诚实声明：Worker 隔离是**故障隔离**（挡住崩溃与死循环），**不是安全沙箱** —— Worker 内代码仍有完整 Node 能力（fs / net）。安全边界由内核侧 CapabilityGuard 把守「能触达哪些内核设施」。

---

## 11. 错误码

全部内核错误继承 `KernelError`，携带稳定 `code`：

| 分类 | 码 |
| --- | --- |
| 清单 / 加载 | `E_INVALID_MANIFEST` · `E_MANIFEST_MISMATCH` · `E_ENTRY_ESCAPE` · `E_LOAD_FAILED` |
| 依赖解析 | `E_DUPLICATE_ID` · `E_MISSING_DEPENDENCY` · `E_VERSION_MISMATCH` · `E_CYCLE` · `E_INCOMPATIBLE` |
| 服务 / DI | `E_NO_PROVIDER` · `E_CIRCULAR_DEPENDENCY` · `E_SCOPED_ACCESS` |
| 安全 | `E_CAPABILITY_DENIED` |
| 运行期 | `E_TIMEOUT` · `E_LIFECYCLE` · `E_ILLEGAL_TRANSITION` · `E_NO_RESPONDER` · `E_NOT_WRITABLE` · `E_ALREADY_STARTED` · `E_GENERIC` |

权威来源：`src/kernel/errors.ts`。

---

## 12. 自检清单

- [ ] `entry` 指向 `dist/index.js`（不是 `src/index.ts`）
- [ ] 只从 `rem2-kernel` / `node:*` / 相对路径导入
- [ ] topic 名用 `Topics` 常量，不手抄字符串
- [ ] 贡献能力走 `ctx.extensions.contribute`，不用 `registerCapability`
- [ ] 令牌用 `defineToken()`，不用 `new ServiceToken()`
- [ ] `pnpm cli validate plugins/<id>/plugin.json` 通过
- [ ] `pnpm build:plugins` 产出 `plugins-dist/<id>/dist/index.js`
