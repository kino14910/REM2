# rem2-kernel Examples

This directory shows how to extend the system through plugins **without modifying the kernel**.

## Contents

- `config/app.config.json` — a sample config loaded by the `com.rem2.config-json` plugin.
  The plugin registers a `ConfigProvider` through the kernel's `KernelTokens.ConfigService`;
  the kernel itself never parses this file.

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

## Using the sample config

Copy or link `examples/config/app.config.json` somewhere the plugin can reach, or override
the path at startup via `config.json.path`. `hello-command` reads `app.greeting` as its
greeting; when the key is missing it falls back to `Hello` (soft dependency, the plugin
still starts normally).

## Writing your own plugin

```bash
pnpm cli scaffold my-plugin
```

The generated plugin contains a `plugin.json` + `package.json` + `tsconfig.json` + `src/index.ts` skeleton whose default export is the `definePlugin(manifest, setup)` factory; implement any optional lifecycle hook inside it, then run the plugin's `build` script to produce `dist/index.js` (the single canonical entry). Plugins import types and tokens **only** from the `rem2-kernel` public entry.

---

# rem2-kernel 示例

本目录演示如何在**不修改内核**的前提下，通过插件扩展系统能力。

## 目录

- `config/app.config.json` —— 由 `com.rem2.config-json` 插件加载的示例配置。
  插件通过内核 `KernelTokens.ConfigService` 注册 `ConfigProvider`；内核本身不解析该文件。

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

## 使用示例配置

将 `examples/config/app.config.json` 复制/链接到插件可访问的位置，或在启动时通过
`config.json.path` 覆盖。`hello-command` 会读取 `app.greeting` 作为问候语；
该配置缺失时使用默认 `Hello`（软依赖，插件仍正常启动）。

## 编写你自己的插件

```bash
pnpm cli scaffold my-plugin
```

生成的插件包含 `plugin.json` + `package.json` + `tsconfig.json` + `src/index.ts` 骨架，默认导出为
`definePlugin(manifest, setup)` 工厂；在工厂内实现任意可选生命周期钩子，再运行插件自带的 `build`
脚本产出 `dist/index.js`（唯一规范入口）。插件**只**从 `rem2-kernel` 公共出口导入类型与令牌。
