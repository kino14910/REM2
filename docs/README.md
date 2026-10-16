# rem2 文档索引

> 项目：`rem2`（package `rem2-kernel`）—— 极小内核 + 一切皆插件。
>
> 文档按**阅读顺序**编号（`01` 最先读）。**权威设计文档是 [`01-architecture-overview.md`](01-architecture-overview.md)** —— 以代码为准，关键论断用符号名定位。

## 文档一览

| # | 文档 | 内容 | 时效 |
| --- | --- | --- | --- |
| **01** | [**architecture-overview**](01-architecture-overview.md) | **架构设计文档（权威）**：分层架构、模块职责、扩展点机制、4 条调用链路、数据流向、技术栈、部署拓扑、9 条决策与权衡、扩展流程、已知限制 | ✅ 现行 |
| **02** | [**plugin-api**](02-plugin-api.md) | **插件开发指南**：`definePlugin`、清单、生命周期、`PluginContext`、12 个扩展点、服务令牌、命令链路、隔离模式、错误码 | ✅ 现行 |
| **03** | [target-architecture](03-target-architecture.md) | 目标架构设计：生命周期两层模型、契约草案、扩展点全表、职责边界 | ⚠️ 设计文档，实现有偏差（见 `01` §8-A） |
| **04** | [svelte-integration](04-svelte-integration.md) | Svelte 接入设计：进程/构建边界、IPC 契约、store↔事件桥、CSP/HMR | ✅ 设计仍成立 |
| **05** | [architecture-skeleton](05-architecture-skeleton.md) | 骨架落地说明：实际目录树（每文件职责）、扩展点注册表填充、构建产物流、tsconfig 边界 | ✅ 基本准确（差异见 `01` §8-A） |
| **06** | [migration-and-skeletonspec](06-migration-and-skeletonspec.md) | 迁移映射表（85 个文件逐条去向）、破坏式变更清单、tsconfig/vite/forge 规格 | 📜 历史记录（迁移已完成） |
| **07** | [form-evaluation](07-form-evaluation.md) | 5 种「打通打包态」形式逐项裁决 + 4 条实测证据 | 📜 决策记录（结论仍有效） |
| **08** | [current-state-diagnosis](08-current-state-diagnosis.md) | 重构前诊断：24 条优化项 + 5 条数据流 | 📜 历史记录 |
| **09** | [prd-arch-refactor](09-prd-arch-refactor.md) | 重构 PRD：需求锚点、A1–A12 验收判据、非目标 | 📜 历史记录 |

**架构图**：[`class-diagram-v2.mermaid`](class-diagram-v2.mermaid)（类图）、[`sequence-diagram-v2.mermaid`](sequence-diagram-v2.mermaid)（5 条主链路时序）。

## 按角色选阅读路径

| 你是谁 | 按这个顺序读 |
| --- | --- |
| **想了解现在的系统** | `01` §1 架构 → §2 职责 → §3 链路 → §7 决策 → §10 扩展流程 |
| **想写插件** | `02`（完整指南）→ `01` §3.2 命令链路 |
| **想知道某个决策为什么这么做** | `01` §7 决策与权衡 → §8 缺陷复盘 → `07` 形式评估 |
| **刚接手，想看演变过程** | `09` PRD → `08` 诊断 → `07` 评估 → `03` 设计 → `01` 现状 |

---

## 快速上手

```bash
pnpm install
pnpm dev                      # 终端形态启动内核（6 个 builtin 插件）
pnpm start                    # Electron 桌面应用（renderer 是 Svelte）
pnpm test:run                 # 全量测试（33 文件 / 259 用例）
pnpm typecheck:all            # 三份 tsconfig 类型检查
```

**文档一致性由契约测试把关** —— `tests/contract/` 有 4 个文件 30 个用例，静态断言：

| 断言 | 保障什么 |
| --- | --- |
| 内核零第三方依赖、不得反向 import | `01` §1 的分层硬约束 |
| 插件只从 `rem2-kernel` 导入 | `02` 的导入边界 |
| 扩展点清单与 `03` §7.2 逐 id 一致 | 扩展点不会漂移 |
| 构建产物是浏览器版 svelte | 不会白屏 |
| IPC 白名单与内核 `Topics` 真值一致 | 不会「无响应者」或自递归 |

---

## 已删除的文档（2026-10-16）

原先的 `01`–`07`（重构前文档）与两份旧 mermaid 图已删除，编号不复用。

删除理由：描述的是**重构前结构** —— `src/electron-shell/`、`src/runtime/`、`registerCapability`、`entry: 'src/index.ts'`、`ServiceToken.create` 等均已不存在，与现行的 `01` 直接矛盾。其中旧 `04-plugin-api.md` 尤其危险：它教插件作者使用三个已删除的 API，照其写插件会直接失败。

删除前已做的处理：
- 源码与测试中共 63 处指向旧文档的导航引用全部改指现行文档（`grep -rn "docs/0[1-9] §" src/ tests/` 现为 0）。
- 设计动机的实质内容已浓缩进 `01` §7 的决策与权衡。
- 旧 `04-plugin-api.md` 的替代品是现行的 [`02-plugin-api.md`](02-plugin-api.md)。
- 文档于同日按阅读顺序从 `01` 重新编号（原 `08`–`15` → `01`–`09`），全部交叉引用已同步。

若需追溯 REM 项目的架构分析，原始材料在 `D:\projects\REM`（只读参照，与 rem2 无代码继承关系）。