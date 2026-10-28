# Built-in Plugins (`plugins/`)

This directory holds rem2-kernel's **built-in sample plugins**. During discovery they are marked `source: 'builtin'`, which grants them the `trusted` trust level.

| Plugin             | Provides                                                         | Depends on                       | Architecture point demonstrated                                                       |
| ------------------ | ---------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `logger-console`   | `log.sink`                                                       | —                                | Observability is a plugin                                                             |
| `config-json`      | `config.provider`                                                | —                                | Config sources are plugins                                                            |
| `hello-command`    | `command.provide`                                                | soft-depends on `config-json`    | Business features are plugins + soft-dependency degradation                           |
| `health-http`      | `health.check` (requires `health.expose` + `net.listen`)         | hard-depends on `logger-console` | Ops is a plugin + hard-dependency ordering                                            |
| `theme-dark`       | `ui.theme` (light + dark)                                        | soft-depends on `logger-console` | UI is a plugin (a mode switch needs one theme per mode resident)                      |
| `plugin-inspector` | `ui.panel` + `ui.route` (live plugin table over a private topic) | —                                | The runtime inspector is itself a plugin (panel data path end to end)                 |
| `notify-worker`    | `log.sink`                                                       | —                                | **Worker-thread isolation** (process-level error isolation; source stays pure `.mjs`) |

## Structure of each plugin

```
plugins/<dir>/
  package.json     type: module + esbuild build (output lands in dist/)
  tsconfig.json    exactly one paths entry
  plugin.json      entry: dist/index.js (single canonical form)
  src/index.ts     export default definePlugin(manifest, setup)
```

Every plugin directory contains `package.json` (`type: module`) + `tsconfig.json` + `plugin.json` + `src/` + `dist/`. The entry is always the prebuilt artifact `dist/index.js` (a self-contained esbuild ESM bundle; dev and prod share one entry). The only plugin form is the `export default definePlugin(manifest, setup)` factory function.

## Load order

The kernel loads plugins by **deterministic topological sort**: hard dependencies come before their dependents; when there are no dependencies, order follows `source priority → pluginId lexicographic order`.

## Writing a new plugin

```bash
pnpm cli scaffold com.example.my-plugin --name "My Plugin"
```

---

# 内建插件目录（`plugins/`）

本目录包含 rem2-kernel 的**内建示例插件**，在发现阶段被标记为 `source: 'builtin'`，据此获得 `trusted` 信任级别。

| 插件               | 提供能力                                               | 依赖                    | 演示的架构点                                           |
| ------------------ | ------------------------------------------------------ | ----------------------- | ------------------------------------------------------ |
| `logger-console`   | `log.sink`                                             | —                       | 可观测性是插件                                         |
| `config-json`      | `config.provider`                                      | —                       | 配置来源是插件                                         |
| `hello-command`    | `command.provide`                                      | 软依赖 `config-json`    | 业务功能是插件 + 软依赖降级                            |
| `health-http`      | `health.check`（需 `health.expose` + `net.listen`）    | 硬依赖 `logger-console` | 运维是插件 + 硬依赖排序                                |
| `theme-dark`       | `ui.theme`（light + dark 两套 token）                  | 软依赖 `logger-console` | UI 是插件（切换需要每个 mode 各一套主题常驻）          |
| `plugin-inspector` | `ui.panel` + `ui.route`（私有 topic 提供实时插件表格） | —                       | 运行时检查器自身也是插件（面板数据链路端到端）         |
| `notify-worker`    | `log.sink`                                             | —                       | **Worker 线程隔离**（进程级错误隔离；源码为纯 `.mjs`） |

## 每个插件的结构

```
plugins/<dir>/
  package.json     type: module + esbuild 构建（产物落在 dist/）
  tsconfig.json    恰好一条 paths 条目
  plugin.json      entry: dist/index.js（唯一规范形式）
  src/index.ts     export default definePlugin(manifest, setup)
```

每个插件目录包含 `package.json`（`type: module`）+ `tsconfig.json` + `plugin.json` + `src/` + `dist/`。入口统一为预编译产物 `dist/index.js`（esbuild 自包含 ESM bundle，dev/prod 同一入口）。插件唯一形态是 `export default definePlugin(manifest, setup)` 工厂函数。

## 加载顺序

内核按**确定性拓扑排序**加载：硬依赖先于依赖者；无依赖时按 `source 优先级 → pluginId 字典序`。

## 编写新插件

```bash
pnpm cli scaffold com.example.my-plugin --name "My Plugin"
```
