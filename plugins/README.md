# 内建插件目录（`plugins/`）

本目录包含 rem2 的**内建示例插件**，在发现阶段被标记为 `source: 'builtin'`，
据此获得 `trusted` 信任级别（docs/02 附录 B #7）。

| 插件             | 提供能力                      | 依赖                    | 演示的架构点                                                   |
| ---------------- | ----------------------------- | ----------------------- | -------------------------------------------------------------- |
| `logger-console` | `log.sink`                    | —                       | 可观测性是插件（动机 #8）                                      |
| `config-json`    | `config.provider`             | —                       | 配置来源是插件（动机 #10）                                     |
| `hello-command`  | `command.provide`             | 软依赖 `config-json`    | 业务功能是插件 + 软依赖降级（动机 #1/#2/#6）                   |
| `health-http`    | `health.expose`, `net.listen` | 硬依赖 `logger-console` | 运维是插件 + 硬依赖排序（动机 #8/#2）                          |
| `theme-dark`     | `ui.theme`                    | 软依赖 `logger-console` | UI 是插件（动机 #1）                                           |
| `notify-worker`  | （事件协作）                  | —                       | **Worker 线程隔离**（动机 #6 进程级错误隔离；入口为纯 `.mjs`） |

## 每个插件的结构

```
plugin.json     # 清单（内核读取，声明依赖/能力/兼容性）
src/index.ts    # 实现，default 导出一个实现 Plugin 接口的实例/类
```

## 加载顺序

内核按**确定性拓扑排序**（§D.4）加载：硬依赖先于依赖者；
无依赖时按 `source 优先级 → pluginId 字典序`。

## 编写新插件

```bash
pnpm cli scaffold com.example.my-plugin --name "My Plugin"
```
