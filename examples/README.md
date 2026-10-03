# rem2 示例

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

生成的插件包含 `plugin.json` + `src/index.ts` 骨架，实现 `Plugin` 接口的任意可选钩子即可。
插件**只**从 `rem2-kernel` 公共出口导入类型与令牌。
