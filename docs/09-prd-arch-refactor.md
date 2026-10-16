# 09 · 架构重构 PRD（轻量档）

> 项目：`D:\projects\rem2` · package name `rem2-kernel` · TypeScript ESM · 零运行时第三方依赖
> 核心理念：**极小内核 + 一切皆插件**
> 本 PRD 用途：向架构师（architect）钉死需求锚点、交付物边界与验收判据。**不含任何业务实现。**
> 状态：待用户确认第 8 节 5 个待拍板点后即可开工。

---

## 1. 产品目标

**一句话**：把当前「设计正确但打包态不可运行、且前端缺位」的 rem2，重构为一套边界清晰、构建态自洽、可被 Svelte 前端消费的插件化骨架 —— 只交付架构与骨架，不交付任何功能实现。

**展开为三件可验收的事**：

1. 说清现状：现有 9173 行代码的架构、依赖与数据流，以及每个可优化点的动因/影响面/优先级。
2. 选对形态：在参考文档的 5 种「打通打包态」形式中做出明确取舍，并落到本项目的具体配置。
3. 搭起骨架：目标架构 + 插件生命周期/契约/隔离机制 + 扩展点清单 + Svelte 前端接入通道，全部以目录与契约形式存在且可编译。

---

## 2. 当前项目事实基线（已勘察校验）

### 2.1 代码体量

| 项 | 数值 |
| --- | --- |
| `src/` 下 `.ts` 文件 | 85 个 |
| `src/` TS 总行数 | 9173 |
| `src/kernel/` | 69 文件（内核主体） |
| `src/runtime/` | 5 文件（bootstrap 3 + ipc 2） |
| `src/cli/` | 3 文件（scaffold / validate / list） |
| `src/electron-shell/` | 4 文件（main / preload / renderer / theme-registry） |
| `tests/` | 29 文件（unit 15 / integration 12 / contract 2） |
| `plugins/` | 6 个示例插件，5 个 `src/index.ts` + 1 个 `src/index.mjs`（notify-worker） |

### 2.2 内核零依赖红线

- `src/kernel/**` 只允许 `node:fs` / `node:fs/promises` / `node:path` / `node:url`（相对导入 + 少量 node 内置），**零第三方**。
- **硬断言**：`tests/contract/kernel-deps.test.ts`
  - `:100-118` 静态扫描 `src/kernel/**` **与 `src/runtime/**`**（注意：不只 kernel）的全部 import 说明符，非 `node:` / 非相对路径即判违规。
  - `:120-125` 断言 `package.json` 的 `dependencies` 必须为空对象。
- 该测试的 `ALLOWED_NODE_BUILTINS` 白名单已包含 `node:events` / `node:worker_threads` 等，即 isolation 层用 worker_threads 是被允许的。

### 2.3 内核子目录（18 个）

`contracts`（15 个文件）/ `di` / `discovery` / `dependency` / `lifecycle` / `loader` / `isolation`（worker-bootstrap / worker-host / worker-plugin-proxy）/ `security` / `observability` / `config` / `events` / `scheduler` / `semver` / `bootstrap` / `registry` / `util` / `context`，加顶层 `kernel.ts`（编排层）、`types.ts`、`topics.ts`、`errors.ts`、`version.ts`、`index.ts`。

`src/kernel/contracts/` 实为 15 个 `.ts`（含 `index.ts` 桶文件），其中 `index.ts` 之外的 14 个为契约定义。

### 2.4 构建与打包断点（**本次重构的核心动因**）

| # | 事实 | 位置 | 后果 |
| --- | --- | --- | --- |
| B1 | `exports: { ".": "./src/kernel/index.ts" }` | package.json:25-28 | 裸包名直接指向 TS 源码，**无 dist**，无 `build` 脚本 |
| B2 | `imports: { "rem2-kernel": "./src/kernel/index.ts" }` | package.json:29-31 | 同上，且属 Node 内部 imports（非 `dependencies`），无版本语义 |
| B3 | `main: ".vite/build/main.cjs"` | package.json:19 | 入口名与 `type: module` + Vite 产物 ESM/CJS 混用，需在骨架里明确 |
| B4 | 内核 247 处 `from './x.js'` 指向 `.ts` 文件 | `src/kernel/**` 全量扫描 | Node ESM 严格解析，**打包态直接 ENOENT** |
| B5 | 三个 vite config 全为空壳 | `vite.main/preload/renderer.config.mts` | 无 external / noExternal / conditions / alias 策略，构建期行为不可控 |
| B6 | `packagerConfig: { asar: true }`，**无 `extraResource`** | forge.config.mts:11-13 | 插件与内核产物**根本没进包** |
| B7 | Fuses 关掉 `RunAsNode` 与 `EnableNodeOptionsEnvironmentVariable` | forge.config.mts:49-51 | `NODE_OPTIONS=--import=tsx` 通道被封死 |
| B8 | 无 `tsconfig.build.json`、无 `outDir`、无 `declaration` | tsconfig.json | 内核零构建产物 |
| B9 | 根 `tsconfig.json` 的 `paths` 把 `rem2-kernel` 映射到 `src/kernel/index.ts` | tsconfig.json:26-29 | 与 B1 同源，类型解析与运行期解析耦合 |
| B10 | 根 tsconfig `exclude` 掉 `src/electron-shell/**` + `src/main.ts` + `src/preload.ts` + `src/renderer.ts` | tsconfig.json:37-46 | 外壳与渲染层**不在主 typecheck 覆盖范围**（另有 `tsconfig.shell.json` 兜底） |
| B11 | `src/electron-shell/main.ts` 用 `registerTsLoader()` 动态注册 tsx ESM loader | main.ts:57-65 | 外壳职责、内核零感知（设计正确），但 tsx 在 devDependencies，**打包态不存在** |
| B12 | `pnpm-workspace.yaml` 里写的是 pnpm 设置（`allowBuilds` / `nodeLinker`），**没有 `packages:` 字段** | pnpm-workspace.yaml | 6 个插件**不是 workspace 包**，各自无 `package.json` / 无独立构建 |

### 2.5 前端现状

- 渲染层是**手写原生 TS**：`index.html` → `/src/renderer.ts`（7 行转发）→ `src/electron-shell/renderer.ts`。
- `index.html` 已有严格 CSP（`script-src 'self'`，无 `unsafe-eval`；`connect-src` 显式放行 `ws://localhost:*` 供 HMR）。
- **`svelte` / `@sveltejs/vite-plugin-svelte` 均不在 `package.json`**，即 Svelte 是全新引入。
- preload 走 `contextIsolation: true` + `preload.cjs`，renderer 不直连内核，经 `IpcBridge` 白名单（`command:` / `health:` 前缀）。

### 2.6 已有文档资产

`docs/01`–`07` 已存在（架构分析 / 架构设计 / rem 对比 / 插件 API / 构建计划与风险 / 实现总结 / 二轮审查报告），另有 `class-diagram.mermaid` 与 `sequence-diagram.mermaid`。`docs/07` 记录并已修复 13 项缺陷（F1–F13），说明现有实现**逻辑层质量可用**，问题集中在**构建/分发/前端**三处。本次重构是**结构性重排**，不是修 bug。

---

## 3. 用户故事

| # | 作为 | 我想要 | 以便 |
| --- | --- | --- | --- |
| US1 | 架构负责人 | 拿到一份逐层的现状诊断（架构 / 模块 / 依赖 / 数据流），每项优化都带动因、影响范围、优先级 | 能判断重构顺序与风险，而不是凭感觉动手 |
| US2 | 架构负责人 | 参考文档的 5 种「打通打包态」形式得到逐项裁决：适配 / 不适配 / 落地方式 / 风险 | 形式选型有据可依，不靠拍脑袋 |
| US3 | 插件作者 | 一份明确的插件契约：manifest 字段、`define` 形态、生命周期 6 阶段、卸载语义、扩展点清单 | 写插件时知道该在哪挂钩、会被怎样调用、何时被清理 |
| US4 | 内核维护者 | 主机与插件的隔离与权限机制被写清（能力授予、入口沙箱、worker 隔离、卸载回收） | 敢让第三方代码跑在内核进程里 |
| US5 | 前端开发者 | Svelte 作为前端接入方式被设计清楚（进程边界、IPC 契约、store 与事件桥、构建配置、主题/能力如何触达插件） | 前端不是「另起一套」，而是内核能力的一等消费者 |
| US6 | 项目负责人 | 明确知道本次是破坏式变更、不保留向后兼容、旧结构可弃 | 重构不必背上「不能动」的包袱 |
| US7 | 项目负责人 | 拿到的是**可编译的骨架**：目录存在、扩展点为显式注册表、契约为类型 | 后续填实现有明确落点，不用再重构一次 |
| US8 | QA | 有机器可验的验收判据（typecheck / 契约测试 / 结构存在性） | 能自动判定「骨架达标」，而不是靠人眼看 |

---

## 4. 需求池

### P0 —— 必须交付（缺一不可）

| ID | 需求 | 动因 / 依据 | 验收锚点 |
| --- | --- | --- | --- |
| **P0-1** | **现状诊断报告**：梳理架构分层、模块职责、依赖关系（内核→内核 / 内核→runtime / 外壳→内核 / 外壳→plugins 的越界处）、数据流（启动 / 命令 / 事件 / 配置 / 卸载五条主链路）。逐条给出可优化项，每项含**动因 + 影响范围 + 优先级（P0/P1/P2）** | 用户需求 1；B1–B12 已暴露多处结构问题（如 `electron-shell/main.ts:19` 直接 import `plugins/theme-dark/src/index.js`，外壳与示例插件静态耦合） | 报告含分层图 + 依赖矩阵 + ≥10 条带优先级的优化项 |
| **P0-2** | **形式引入评估结论**：对参考文档 5 种形式逐项判定（适配 / 有条件适配 / 不适配），给出理由、落地方式、风险与不适用项，并给出**唯一推荐组合** | 用户需求 2；参考文档 §三 决策表与 §六 建议 | 5 项逐项结论表 + 一个明确推荐 + 被否决项的判据 |
| **P0-3** | **目标架构设计文档**：以「一切皆插件」为核，定义插件的**6 段生命周期**（注册 → 发现 → 加载 → 初始化 → 依赖解析 → 配置 → 卸载；含失败回滚与状态机）、**主机↔插件契约**、**隔离机制**、**主干 vs 插件职责划分**、**扩展点清单**、**扩展流程**（新增一个插件/扩展点需改哪几处） | 用户需求 3 | 生命周期状态机图 + 扩展点表格 + 职责边界表 + 扩展流程 checklist |
| **P0-4** | **骨架代码骨架**：按目标架构重排目录，建立显式扩展点注册表与类型契约 | 用户需求 3 + 只搭骨架 | 目录结构与文档一致；`pnpm typecheck` 通过 |
| **P0-5** | **Svelte 接入设计**：进程与构建边界、renderer 侧组件树、preload 暴露的 IPC 契约面、store↔事件总线的桥接方式、主题类插件（如 `theme-dark`）如何被前端消费、Vite/Svelte 配置策略、HMR 与 CSP 的相容性 | 用户需求 4 | 设计含目录树 + IPC 契约表 + `vite.renderer.config` 目标策略 + 一个最小 `App.svelte` 骨架 |
| **P0-6** | **打包态自洽**：消除 B1–B8 造成的开发态/打包态割裂，明确「什么文件进包、走什么解析、谁负责转译」 | B1–B8；参考文档形式 1/2/5 | 存在一份「打包产物 ↔ 路径 ↔ 解析规则」映射表，且与 forge config / package.json exports 一致 |

### P1 —— 应该做

| ID | 需求 | 动因 |
| --- | --- | --- |
| **P1-1** | 迁移映射表：`旧目录/文件 → 新目录/文件` 的逐条对照 + 破坏式变更清单（删了什么、改了什么语义） | 允许破坏式变更，但需要可执行的迁移指引，否则骨架落地会漏 |
| **P1-2** | 依赖方向规则的**可执行约束**（分层图 + 禁止方向清单），而不只是文档描述 | B11 类越界（外壳 import 插件源码）需要机制而非自觉 |
| **P1-3** | 插件契约版本化与兼容策略（`compatibility.minKernel` / `contractVersion` 已有雏形，需明确演进规则） | 骨架要能长期演进，需先定版本轴 |
| **P1-4** | 错误边界与可观测性骨架：错误分类/传播规则、日志/指标/追踪三个扩展点的接入位 | 「静默失败」是现有实现已踩过的坑（`main.ts:73` 注释自述） |
| **P1-5** | 内核侧与构建相关的配置文件骨架：`tsconfig.build.json`、`tsconfig.shell.json` 的职责划分，以及插件侧独立 tsconfig 约定 | 参考文档 §四① 指出根 tsconfig 不能给插件用 |
| **P1-6** | CLI 与骨架对齐（`scaffold` 生成的插件目录形态需与新骨架一致） | `src/cli/scaffold` 存在但会随目录重排而失效 |

### P2 —— 可选

| ID | 需求 | 动因 |
| --- | --- | --- |
| **P2-1** | 插件契约快照自动生成（若最终选形式 5，`pnpm sync-contract` 骨架） | 参考文档 §五① 指出手抄 `ServiceToken` / `KernelTokens` 有漂移风险 |
| **P2-2** | 6 个示例插件的骨架化重写（只改形态不实现业务） | 现有插件形态是目录重排的活证据；但用户明确「不写业务码」，可延后 |
| **P2-3** | 契约文档从 `docs/04-02-plugin-api.md` 迁到新位置并标注差异 | 避免两份真相 |
| **P2-4** | 插件包签名/信任级别的接口预留（`CandidateSource` 的 `builtin`/`workspace`/`user` 分级已有） | 参考文档 §六 补充提到 `user` 来源的安全模型 |

---

## 5. 交付物清单

### 5.1 文档（落到 `D:\projects\rem2\docs\`）

| 文件名 | 内容 | 对应需求 |
| --- | --- | --- |
| `09-prd-arch-refactor.md` | 本 PRD | — |
| `08-current-state-diagnosis.md` | 现状诊断报告：分层架构、模块职责表、依赖矩阵、5 条主链路数据流、≥10 条优化项（动因/影响面/优先级） | P0-1 |
| `07-form-evaluation.md` | 5 种形式逐项评估表 + 推荐组合 + 风险与不适用项 | P0-2 |
| `03-target-architecture.md` | 目标架构：设计原则、目录结构、插件 6 段生命周期与状态机、契约定义、隔离与权限机制、主干/插件职责边界、扩展点清单、扩展流程 | P0-3 |
| `04-svelte-integration.md` | Svelte 接入设计：进程/构建边界、组件树、IPC 契约面、store↔EventBus 桥、主题消费方式、Vite+`@sveltejs/vite-plugin-svelte` 策略、CSP/HMR 相容性 | P0-5 |
| `06-migration-and-skeletonspec.md` | 旧→新映射表、破坏式变更清单、`tsconfig.build.json` 职责划分、插件侧 tsconfig 约定、依赖方向禁止清单 | P0-6 / P1-1 / P1-2 / P1-5 |
| `05-architecture-skeleton.md` | 骨架落地说明：目录树、每个目录/文件的职责一句话、扩展点注册表如何被填充 | P0-4 |
| `class-diagram-v2.mermaid` / `sequence-diagram-v2.mermaid` | 新架构图（与 `docs/class-diagram.mermaid` 并存，由 P2-3 决定是否替换） | P0-3 |

### 5.2 骨架代码目录形态（建议，仅骨架不含实现）

```
rem2/
├── src/
│   ├── kernel/                  # 极小内核：零第三方依赖（红线不变）
│   │   ├── contracts/           # 纯类型契约 + 少量运行期构造器（ServiceToken 等）
│   │   ├── kernel.ts             # 编排层：状态机 + 生命周期驱动
│   │   ├── extensions/           # 【新】扩展点注册表（唯一「一切皆插件」的挂载面）
│   │   ├── lifecycle/            # 注册/发现/加载/初始化/依赖解析/卸载 六段
│   │   ├── registry/             # 插件注册表
│   │   ├── di/ dependency/       # 容器 + 依赖解析
│   │   ├── discovery/ loader/    # 候选来源发现 + 动态装载
│   │   ├── isolation/ security/  # worker 隔离 + 能力授予/入口沙箱
│   │   ├── observability/        # log / metrics / tracing / health
│   │   ├── config/ events/ scheduler/ semver/ context/ util/
│   │   └── index.ts              # 唯一公共出口（形态需按 P0-2 结论调整）
│   ├── host/                     # 【新】宿主适配层（替代散落的 electron-shell/runtime 二分）
│   │   ├── electron/             # main / preload / renderer 入口
│   │   ├── cli/                  # cli / scaffold / validate / list
│   │   └── ipc/                  # IpcBridge + 通道契约（由 src/runtime 迁入并扩展）
│   └── frontend/                 # 【新】Svelte 前端（渲染进程）
│       ├── app/                  # App.svelte / 路由壳
│       ├── lib/                  # IPC client、store、类型（与内核契约对齐）
│       └── entry-client.ts       # renderer 入口（替换现 index.html 的 /src/renderer.ts）
├── plugins/<plugin-id>/          # 插件单元（形态按 P0-2 结论统一）
│   ├── plugin.json               # manifest（entry 策略需 dev/prod 单一化）
│   └── src/index.ts
├── tests/                        # unit / integration / contract（contract 保持硬断言）
├── tsconfig.json / tsconfig.build.json / tsconfig.shell.json
├── vite.main.config.mts / vite.preload.config.mts / vite.renderer.config.mts  # 均需实质化
└── forge.config.mts              # 需补 extraResource
```

**骨架的「非空」判据**：每个新目录至少有 1 个文件，且该文件承担**类型契约**或**注册表骨架**（可为空实现），而不是空目录占位。

---

## 6. 非目标（Non-Goals）

明确**不做**，避免范围蔓延：

1. **不写任何业务实现**。骨架只允许：类型契约、扩展点注册表（空表）、接口定义、生命周期状态枚举。禁止出现真实业务逻辑、真实插件功能、真实命令处理。
2. **不做竞品分析与市场调研**。本次是内部架构重构，不产出竞品对比或市场报告。
3. **不编写测试用例**。QA 阶段只验证两件事：① 骨架可编译（`pnpm typecheck` / `typecheck:shell` 通过）；② 既有边界契约仍成立（`tests/contract/**` 保持绿）。**不新增测试文件**；若架构师认为需要补契约测试，须先向用户申请。
4. **不保持向后兼容**。旧目录、旧导入路径、旧 `exports` 形态可直接弃用；不写迁移垫片、不做双形态并存。
5. **不重构示例插件的业务逻辑**。6 个插件可被移动目录或改 manifest 字段，但不重新实现其功能。
6. **不实现前端业务界面**。Svelte 侧只到「骨架 + 一个最小挂载点 + IPC 客户端类型」，不做控制台、主题切换器等实际 UI。
7. **不做安装包签名 / 插件市场 / 远程分发**。信任分级接口可预留，实现不做。
8. **不解除 `dependencies` 必须为空的红线**。这是 `tests/contract/kernel-deps.test.ts:120-125` 的硬约束，任何方案不得绕过。
9. **不在代码里写解释性注释**。仅在算法意图反直觉处保留必要注释；不写模块说明式大段注释（现有代码注释密度偏高，属可优化项）。

---

## 7. 验收判据（机器可验证）

| # | 判据 | 验证方式 | 通过标准 |
| --- | --- | --- | --- |
| A1 | 类型检查通过 | `pnpm typecheck` | 退出码 0 |
| A2 | 外壳/渲染层类型检查通过 | `pnpm typecheck:shell` | 退出码 0 |
| A3 | 内核零第三方依赖红线未破 | `pnpm test:run tests/contract` | 2 passed / 0 failed |
| A4 | 现有测试不因重构而系统性崩塌 | `pnpm test:run` | 记录基线（README 声称 222 passing）；**允许**因删除旧路径而减少的用例数，但需在报告中给出「新旧数量对照与每一处差异的原因** |
| A5 | 打包态路径自洽 | 存在「产物 ↔ 路径 ↔ 解析规则」映射表，且表中每个路径在 `forge.config.mts` / `package.json` / vite config 中均有对应配置项 | 逐条可追溯，无孤立项 |
| A6 | 插件 `import` 边界成立 | 扫描 `plugins/**` 的 import 说明符，遵循参考文档 §差异 5 的判定口径 | 无第三方裸包名；形态与 P0-2 结论一致 |
| A7 | 扩展点清单存在且可枚举 | 扩展点注册表导出项 | 清单存在于 `docs/03` 且与 `src/kernel/extensions/` 实际导出**一一对应** |
| A8 | 生命周期 6 段有实现落点 | 状态机定义 | `lifecycle/` 下每段职责有对应导出（或明确的 TODO 标记空实现） |
| A9 | Svelte 接入骨架可编译 | renderer 构建 | `vite.renderer.config.mts` 实质化后能构建出产物；`svelte` 已进 `devDependencies` |
| A10 | 交付物齐全 | 文件存在性检查 | 5.1 表中 7 份文档 + 2 张图全部存在且非空（`08` 为本文件） |
| A11 | 破坏式变更已登记 | `06-migration-and-skeletonspec.md` | 含旧→新映射表与删除清单 |
| A12 | 无业务代码混入 | 人工评审 + 目录检查 | 骨架文件中不存在具体业务实现；无空目录占位 |

---

## 8. 待确认问题（需用户拍板）与默认假设

### Q1. 打包态打通形式选哪条路？——**影响 B1/B6/B8 的解法，也决定内核是否需要 dist**

参考文档结论是「形式 1 单独不成立 = 1+2；形式 5 让内核一字不改」。

**默认假设：采用「形式 1 + 形式 2」组合** —— 内核新增 `tsconfig.build.json` 产出 `dist/kernel/**`，`package.json` 的 `exports` 改为条件化（`development` → `./src/kernel/index.ts`，`default` → `./dist/kernel/index.js`），插件预编译为 `dist/index.js` 通过 `extraResource` 进包。
**理由**：形态最标准、生态最友好、内核未来可作为 npm 包对外分发；且本项目明确「Svelte 前端 + 第三方插件」方向，需要标准化产物。
**若改选形式 5**（插件全自包含 `.cjs`、内核零 dist），则 A5 的映射表内容、B6 的 `extraResource` 范围、插件 manifest 的 `entry` 策略全部要改写。
**风险提示**：无论选哪条，都必须额外解决「Vite 在构建期就解析了 `rem2-kernel`」导致的开发态/打包态割裂（参考文档 §形式 2「致命细节」），需要在 `vite.main.config.mts` 里显式声明 `resolve.conditions` / `ssr.noExternal` 策略。请用户确认是否接受内核引入构建步骤。

### Q2. 破坏式变更的「弃用」处理方式：直接删，还是先移动到 `legacy/` 停用？

**默认假设：直接删除/重命名，不保留 `legacy/`**。理由是用户已授权破坏式变更，保留停用目录会让骨架阶段就背上双份结构。
**若改选保留 `legacy/`**，则 A4 的测试基线会变复杂（legacy 侧仍要能编译），且骨架的「非空判据」需要额外定义。

### Q3. `src/host/` 是否成立？—— 即 `electron-shell` 与 `runtime` 是否合并

现状是两个「宿主」并存：`src/electron-shell/`（4 文件）与 `src/runtime/`（5 文件，含 CLI bootstrap + IPC 桥），职责有交叠（都在做「内核之外的东西」），且 `electron-shell/main.ts:19` 越界 import 了 `plugins/theme-dark/src/index.js`。

**默认假设：合并为 `src/host/{electron,cli,ipc}`**，让「宿主」成为与「内核」并列的第二个顶层概念（`kernel` / `host` / `frontend` 三分）。
**理由**：与「极小内核」形成对称，扩展点清单更容易讲清「谁负责什么」；也顺手解掉 B10（外壳不在主 typecheck 覆盖）的问题——`src/host/` 应纳入主 tsconfig。
**若改选保留 `electron-shell`**，需接受「内核/外壳/runtime」三概念并存，并在文档中明确三者的依赖方向约束。

### Q4. Svelte 版本与渲染层形态：Svelte 5 + 什么 UI 层？

现状 `svelte` 完全未安装，渲染层是手写原生 TS。

**默认假设：Svelte 5 + Vite（`@sveltejs/vite-plugin-svelte`）+ TypeScript，UI 层不引入第三方组件库**（内核/前端一致性优先，零依赖哲学只在 kernel 层强制，前端可放宽但默认不加）。
**需用户确认**：① 是否 Svelte 5（`$state`/`$derived` runes）；② 是否需要组件库（如 unocss / tailwind）；③ 渲染层是否保留 `index.html` 现有的严格 CSP（我的建议是保留，`script-src 'self'` 且不加 `unsafe-eval`）。
**影响**：A9 的验收方式、5.2 中 `src/frontend/` 的内部结构、P0-5 的组件树描述。

### Q5. 6 个示例插件与 CLI scaffold 在本次是否同步骨架化？

**默认假设：`src/cli/scaffold` 必须同步对齐新骨架（P1-6，属 P0-4 隐含要求）**，因为 scaffold 生成的形态若与新骨架不一致会立刻制造第二种真相；但 **6 个示例插件只做目录/manifest 形态对齐，不重写业务实现**（P2-2 降级为可选）。
**需用户确认**：示例插件是否算「业务代码」。若你认为连 manifest 形态调整都算业务改动，则本轮只动 `scaffold`，`plugins/**` 原样不动（P0-1 需在报告中标注 `plugins/**` 为「未审计区」）。

---

## 9. 给架构师的关键约束摘要（务必遵守）

1. **`src/kernel/**` 零第三方依赖是硬红线**，`tests/contract/kernel-deps.test.ts` 会同时扫 `src/kernel` 与 `src/runtime`。若引入 `src/host/`，需确认新路径是否仍落在扫描范围内（当前测试**只扫这两个旧路径**，目录重排后**必须同步更新测试的扫描路径**，否则红线形同虚设 —— 这是 P0-1 必须点出的一条隐藏风险）。
2. **`dependencies` 必须保持为空**，`devDependencies` 可放开（构建期依赖如 esbuild/svelte/tsx 属此类）。
3. **代码注释克制**：不写模块说明式注释，算法意图反直觉处才写。
4. **不写业务实现**。骨架文件应以类型、接口、常量、空注册表为主。
5. 语言：简体中文；文档落 `docs/`，命名为 `09`–`14`（`08` 为本 PRD）。
