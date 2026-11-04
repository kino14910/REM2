# Built-in Plugins (`plugins/`)

This directory holds rem2-kernel's **built-in sample plugins**. During discovery they are marked `source: 'builtin'`, which grants them the `trusted` trust level. The catalog is intentionally empty: console logging is a host feature (toggle and level under **Settings → Console logging**), not a plugin. Add a directory here to ship a trusted built-in.

The theme UI lives in the sibling [`REM2-plugins/theme-switcher`](../../REM2-plugins/theme-switcher) repository (light/dark/system, accent form, persisted preference). It is **not** a built-in plugin: `pnpm build:external` builds it into `plugins-external-dist` for release packaging and tests, and users install it from its GitHub release (source=user, sandboxed, explicit capability grant required).

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

本目录包含 rem2-kernel 的**内建示例插件**，在发现阶段被标记为 `source: 'builtin'`，据此获得 `trusted` 信任级别。目录当前有意保持为空：控制台日志已是宿主能力（在 **设置 → 控制台日志** 中开关并调整等级），不再作为插件提供。把插件目录放到这里即可作为可信内置插件发布。

主题 UI 已迁到同级 [`REM2-plugins/theme-switcher`](../../REM2-plugins/theme-switcher) 仓库（亮/暗/跟随系统、强调色表单、偏好持久化）。它**不是**内置插件：`pnpm build:external` 把它构建到 `plugins-external-dist`，用于发布打包与测试；用户从它的 GitHub Release 安装（source=user，沙箱策略，需要显式授权能力）。本目录不再保留主题源码。

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
