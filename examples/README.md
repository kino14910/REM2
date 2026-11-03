# rem2-kernel Examples

This directory shows how to extend the system through plugins **without modifying the kernel**.

The repository ships two built-in samples under `plugins/`: `logger-console` (a `log.sink`)
and `plugin-inspector` (a `ui.panel` + `ui.route`). `pnpm dev` loads them automatically.

## Running the kernel with built-in plugins

```bash
# Boot the kernel (the built-in plugins/ dir acts as the trusted plugin source)
pnpm dev
```

`pnpm dev` will:

1. Scan `plugins/` (source=builtin → trusted) and the user's `roots` (source=user → sandboxed).
2. Validate `plugin.json`, resolve dependencies, and run a **deterministic topological sort**.
3. Load and start plugins in order (with timeouts and error isolation).
4. Print `loadOrder / started / degraded / failed` plus the health report.

No built-in command is shipped: until a plugin contributes `command.provide`, command execution
returns an explicit `unknown command` result.

## Writing your own plugin

```bash
pnpm cli scaffold my-plugin
```

The generated plugin contains a `plugin.json` + `package.json` + `tsconfig.json` + `src/index.ts`
skeleton whose default export is the `definePlugin(manifest, setup)` factory; implement any
optional lifecycle hook inside it, then run the plugin's `build` script to produce
`dist/index.js` (the single canonical entry). Plugins import types and tokens **only** from the
`rem2-kernel` public entry.

---

# rem2-kernel 示例

本目录演示如何在**不修改内核**的前提下，通过插件扩展系统能力。

仓库在 `plugins/` 下内置两个示例：`logger-console`（`log.sink`）和 `plugin-inspector`
（`ui.panel` + `ui.route`）。`pnpm dev` 会自动加载它们。

## 运行内核并加载内建插件

```bash
# 启动内核（内建 plugins/ 目录作为 trusted 插件源）
pnpm dev
```

`pnpm dev` 会：

1. 扫描 `plugins/`（source=builtin → trusted）与用户 `roots`（source=user → sandboxed）。
2. 校验 `plugin.json`、解析依赖、做**确定性拓扑排序**。
3. 按序加载并启动插件（带超时与错误隔离）。
4. 输出 `loadOrder / started / degraded / failed` 与健康报告。

默认不附带命令插件：在插件贡献 `command.provide` 之前，命令执行会返回明确的
`unknown command`。

## 编写你自己的插件

```bash
pnpm cli scaffold my-plugin
```

生成的插件包含 `plugin.json` + `package.json` + `tsconfig.json` + `src/index.ts` 骨架，默认导出为
`definePlugin(manifest, setup)` 工厂；在工厂内实现任意可选生命周期钩子，再运行插件自带的 `build`
脚本产出 `dist/index.js`（唯一规范入口）。插件**只**从 `rem2-kernel` 公共出口导入类型与令牌。
