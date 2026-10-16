# 07 · 形式引入评估

> 评估对象：`D:\Downloads\形式 1 vs 形式 5 · 逐项拆解.md` 的 5 种「打通打包态」形式。
> **本文档不是照抄参考文档的结论**：参考文档分析的是**旧形态**（无 dist、`exports` 直指 `.ts`、插件入口是 `.ts`），本项目现在设计的是**目标形态**（有 dist、插件预编译）。下面所有裁决都在目标形态上重新论证，并给出本轮**实测证据**。

---

## 0. 实测证据（决定裁决的技术前提）

以下 4 条是本轮亲自跑出来的，不是推理。参考文档有两条结论与实测不符，已在§6 标注。

| # | 实测内容 | 命令 / 位置 | 结论 |
| --- | --- | --- | --- |
| **E1** | Vite 8 是否能解析 `import './x.js'` 而磁盘上只有 `x.ts` | 在 `rem2/` 下建临时工程，`entry.js` → `sub/main.js` → `sub/dep.ts`，跑 `vite build` | **能**。`✓ 4 modules transformed`。Vite 8 内部 `isPossibleTsOutput()`（`node_modules/vite/dist/node/chunks/node.js:29105-29121`）显式做 `.js` → `.ts` 回退 |
| **E2** | Node 原生 ESM 能否解析 `.js` → `.ts` | Node 直接 `import('./x.js')` 而磁盘只有 `x.ts` | **不能**（`ERR_MODULE_NOT_FOUND`）。tsc 的 NodeNext 目标保证**转译后**文件真的是 `.js`，所以 `tsc` 产物没问题 |
| **E3** | 内核 `Container` 是否依赖 `ServiceToken` 的**对象身份** | 通读 `src/kernel/di/container.ts` 全文 + `grep -rn "instanceof" src/kernel` | **不依赖**。`registrations: Map<string,…>` 按 `token.id` 索引（`:106,118,130`）、`exported: Set<string>`（`:194,199,204,271`）、`canBeResolvedByChild(id: string, …)` 收字符串。`grep instanceof` 在 `src/kernel` 内**零命中**（除 `Error` 判断） |
| **E4** | Worker(`eval`) 内 `await import()` 对 ESM vs CJS 的差异 | 真实 Windows 路径下在 `worker(eval)` 里分别 `import('plugesm.mjs')` / `import('plugcjs.cjs')` | 两者**都能跑**，但形状不同：ESM → `{X, default: function}`；CJS → `{default: object}`（CJS 的 `module.exports` 整体成为 `default`，需再解一层） |

**E1 + E2 合起来改变了整个选型**：参考文档说「形式 2 单独用，修好打包态却修不好开发态」，原因是它以为 Vite 不做 `.js`→`.ts` 映射。**实测 Vite 做**。所以「开发态炸」这个论断不成立 —— 但成立的原因换了，见 §2。

---

## 1. 逐项裁决总表

| 形式 | 一句话定义 | 裁决 | 决定性理由 |
| --- | --- | --- | --- |
| **形式 1** | 插件预编译为 JS + `extraResource` 进包 | ✅ **适配（必需基座）** | 插件是运行时 `import()`，不经 Vite。E2 证明只有预编译才能在 Node 侧成立 |
| **形式 2** | 内核 `tsc` 产出 `dist/kernel/**` + 条件 `exports` | ⚠️ **有条件适配（降级为「类型 + 分发」）** | E1 证明宿主三端走 Vite 时**不需要** dist；dist 的真实价值只剩 `.d.ts` 与 npm 分发。不分 dev/prod 条件 |
| **形式 3** | 内核自带 TS 转译器（`dependencies` 含 tsx / Node strip-only） | ❌ **不适配** | 直接破 `tests/contract/kernel-deps.test.ts:120-125` 的 `dependencies` 空断言与 PRD §9.1 硬红线 |
| **形式 4** | 整仓 + `node_modules` 塞进 asar，运行时解析 | ❌ **不适配** | ① 破零依赖红线；② asar 内 `import()` 指向 `node_modules` 的深层路径在 Electron 打包态不可靠；③ 无法对第三方插件给出可复现的最小包 |
| **形式 5** | 每个插件自带 `.cjs` 单文件（自包含）+ 手抄契约快照 | ⚠️ **部分不适配（优点被吸收进形式 1）** | 「自包含」是必需（见 §2），但 `.cjs` 形态与 E4 的双层解包、`type: module` 方向、手抄 `KernelTokens` id 的漂移风险三项皆劣。改为 **ESM bundle** 形态 |

---

## 2. 深度裁决

### 2.1 形式 1 —— ✅ 适配（必需基座，不可否决）

**为什么不可否决**：内核的 loader 用**运行时 `import()`** 装载插件（`src/kernel/loader/loader.ts:103`）。这条代码路径**不经过 Vite**（Vite 只 bundle main / preload / renderer 三个入口）。因此插件入口在磁盘上**必须是 Node 原生可解析的真实文件**。E2 已证明 Node 无法解析 `.js` → `.ts`。

参考文档 §形式 1「关键坑」表里第4 条说「双份入口维护，`entry` 字段必须在两个 `plugin.json` 之间切换，容易漂移」。这个诊断正确，但**它开的药方（让 `entry` 支持数组 / 读环境变量）是错的** —— 那只是把「两份 manifest」换成「一份 manifest 两份语义」，漂移风险从「文件不同步」变成「行为依赖环境」，后者更难测。

**本项目的解法**：**只有一种形态**。`entry` 是**单一值**，永远指向构建产物；开发态也用产物（先构建）。

```jsonc
// plugins/<id>/plugin.json —— 唯一形态，dev/prod 完全相同
{ "id": "com.rem2.hello-command", "entry": "dist/index.js" }
```

代价是「改插件 `.ts` 后必须 rebuild」。缓解：`pnpm dev` 并行跑 `esbuild --watch plugins/*/src/index.ts`（esbuild 已在 `node_modules/.bin`，来自 vite 的传递依赖；显式提升为 `devDependencies`）。6 个示例插件的增量构建 < 100ms，不是问题。

**收益**：dev 态与打包态走**完全同一条**装载代码路径。「打包态自洽」的真谛不是「让两种形态各自能跑」，而是**只保留一种形态**。

**落地写法**

```jsonc
// plugins/<id>/package.json（新增，pnpm-workspace.yaml 需加 packages: ['plugins/*']）
{
  "name": "@rem2/plugin-hello-command",
  "private": true,
  "type": "module",                 // ← 决定产物 .js 被 Node 视为 ESM
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/index.js"
  }
}
```

```ts
// forge.config.mts
packagerConfig: {
  asar: true,
  extraResource: [
    { from: 'plugins-dist', to: 'rem2-plugins', filter: ['**/*'] },
  ],
}
```

> 目录名用 `plugins-dist/`（构建输出聚合目录）而非直接 `plugins/`，避免把 `src/`、`node_modules/`、`tsconfig.json` 一并塞进安装包。

**风险**：① 构建产物与源码不同步（用 `predev` / `premake` 钩子消除）；② esbuild bundle 会把 `rem2-kernel` 的被引用片段内联进插件 → 见 §3 的类型身份裁决。

### 2.2 形式 2 —— ⚠️ 有条件适配（从「必需」降级为「类型 + 分发」）

**参考文档的核心论断需要修正。** 它说：

> 致命细节：Electron 主进程被 Vite/Rollup 打成 `main.cjs`，它 import `rem2-kernel` 的那一行在构建期就被解析了。开发态 Vite 会命中 `development` → 内联 `src/kernel/index.ts` → 那 255 处 `./x.js` 又指向不存在的 `.js` → ❌ 还是炸。

**实测推翻**（E1）：Vite 8 的 `isPossibleTsOutput` 就是为这件事设计的，`./x.js` → `.ts` 自动回退。所以：

- Electron main / preload / renderer 三个入口**无论 dev 还是 prod，都由 Vite 把 `src/kernel/*.ts` 直接打进产物**，`253` 处 `.js` 后缀导入在两种形态下都成立。
- **内核 dist 对宿主三端是零需求。**

那 dist 还剩什么价值？两件事，且都真实：

| 价值 | 说明 |
| --- | --- |
| **类型分发** | 第三方插件作者需要 `rem2-kernel` 的 `.d.ts`。项目方向明确是「第三方插件 + Svelte 前端」，这条是刚需 |
| **npm 包身份** | `package.json` 的 `exports` 直指 `.ts` 时，包**不可被外部消费**（Node 不认 `.ts` 入口）。`private: true` 可以挡住误发布，但一旦要做包分发就必须有 dist |

**因此本项目的裁决**：

```jsonc
// package.json —— 单一条件，不做 dev/prod 分叉
"exports": {
  ".": {
    "types": "./dist/kernel/index.d.ts",
    "default": "./dist/kernel/index.js"
  },
  "./package.json": "./package.json"
},
"scripts": {
  "build:kernel": "tsc -p tsconfig.build.json",
  "predev": "pnpm build:kernel && pnpm build:plugins",
  "premake": "pnpm build:kernel && pnpm build:plugins"
}
```

**为什么删掉 `development` 条件**：参考文档自己指出「`development` 是自定义条件，不是 Node 内建的，必须在每个宿主显式声明」（CLI / vitest / Electron 三处各写一遍），并自评「条件顺序写错 → 静默走 default」。本项目已经决定 dev 也用产物（§2.1），那么 `development` 条件**没有任何宿主会命中它** —— 留着一个永不被命中的条件，就是给未来留一个静默陷阱。

**`tsconfig.build.json`**

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "module": "NodeNext",        // 保留 .js 后缀不变（E2：转译后文件真的是 .js）
    "types": ["node"]
  },
  "include": ["src/kernel/**/*.ts"],
  "exclude": ["src/host/**", "src/frontend/**", "tests/**"]
}
```

⚠️ **不要开 `rewriteRelativeImportExtensions`**。开了它tsc 会把 `./x.js` 改写成 `./x.ts`，产物 `dist/kernel/**/*.js` 里的 `./x.ts` 在 Node 侧会直接炸（E2）。NodeNext + `.js` 后缀本来就是对的。

**Vite 侧的 alias 必须显式指向源码**（这是 dev/prod 唯一需要区分的地方，且只存在于**构建配置**里，不存在于产物里）：

```ts
// vite.shared.mts
export const KERNEL_ALIAS = {
  // 内核源码（TS 形态）：Vite 会把内部 .js 后缀导入解析到 .ts（E1）
  'rem2-kernel': fileURLToPath(new URL('./src/kernel/index.ts', import.meta.url)),
};
```

**风险**：① dev 改了内核但忘了 build（用 `predev`/`premake` 消除）；② dist 与源码双份真相（dist 只用于类型与分发，**不允许被宿主直接 import**，这条要写进依赖方向禁止清单）。

### 2.3 形式 3 —— ❌ 不适配

两种子形态都破红线：

| 子形态 | 破线位置 |
| --- | --- |
| 内核 `dependencies` 加 `tsx` | `tests/contract/kernel-deps.test.ts:120-125` 直接红 |
| 依赖 Electron 的 Node 原生 strip-only | strip-only **不支持参数属性 / enum / namespace**。现状 `health-http` 插件与内核大量使用参数属性（`config-service.ts:54`、`permission-manager.ts:19-24`、`log-service.ts:20-25`…）。`src/electron-shell/main.ts:46-51` 的注释已经自己写明这一点 |

**结论**：形式 3 就是现状（`main.ts:57-65` 的 `registerTsLoader()`），是本轮要**删除**的东西，不是候选方案。

### 2.4 形式 4 —— ❌ 不适配

除破红线外，还有两个实质问题：

1. **asar 内动态 import 深层路径不可靠**。Electron 对 asar 内 `require` 有原生支持，但插件是 `import()` + 任意深度相对路径，asar 的文件系统补丁在 ESM loader 上覆盖不完整（ESM loader 走的是 Node 内部 fs binding，不经过 Electron 的 patch）。
2. **无法给第三方插件一个可复现的最小包**。整仓塞进 asar 意味着「装 rem2 就装走全部示例插件与测试残留」，与「一切皆插件」的可插拔叙事直接矛盾。

**结论**：与「极小内核」的根本假设冲突。

### 2.5 形式 5 —— ⚠️ 部分不适用（「自包含」吸收，其余否决）

**吸收的部分（重要）**：形式 5 的核心洞察 —— **插件产物必须自包含，运行期与内核零 import 关系** —— 是**必需的**，且已经被形式 1 的 esbuild `--bundle` 方案满足。参考文档 §二 说「形式 1 要 import，形式 5 不要」，这个区分在**纯转译（tsc）方案**下成立，在 **bundle 方案**下不成立。我们选的就是 bundle 方案，所以直接拿到形式 5 的收益。

**否决的部分（三项，各有实测/代码依据）**：

| 否决点 | 依据 |
| --- | --- |
| **① `.cjs` 形态** | E4 实测：Worker 内 `import('.cjs')` 得到 `{default: <module.exports 对象>}`，比 ESM 多一层解包；且项目 `"type": "module"`、产物是 ESM，统一用 `.js`/ESM 可让 `instantiatePlugin` 的形态判定从 4 种收敛到 1 种（见 `03-target-architecture.md` §3.3） |
| **② 手抄 `ServiceToken` / `KernelTokens`** | 参考文档 §五① 自己承认「`KernelTokens.*.id` 抄错一个字符 → 运行期 `NoProviderError`，只有跑到才暴露」。而 **bundle 方案不存在手抄**：esbuild 从 `src/kernel/contracts/kernel-tokens.ts` 直接内联，id 永远与内核一致。**这是 bundle 优于手抄快照的决定性理由** |
| **③ 插件产物内联整个内核片段** | 本项目内核很小，无膨胀问题；反而带来 §3 讨论的类型身份分裂。处理方式见下节 |

---

## 3. 重点裁决：`ServiceToken` 类型身份

### 3.1 事实确认（E3）

参考文档说「本项目靠 `token.id` 字符串匹配，所以安全」—— **核实通过**。`Container` 全程按 `token.id` 字符串索引，`src/kernel` 内无任何 `instanceof` 判断。所以**形式 5 / bundle 方案在当前实现下确实安全**。

### 3.2 但「当前安全」不等于「应该继续依赖」

**结论：目标架构不应把「token.id 字符串匹配」当隐式契约，而应把它升级为显式契约 —— 具体做法是把 `ServiceToken` 从「类」降格为「品牌化字符串 + 纯函数工厂」。**

理由三条：

1. **bundle 让「构造器身份分裂」从假设变成必然**。每个插件产物里都有一份 `ServiceToken` 的独立副本；Electron main.cjs 里还有一份。这些副本的 `===` 恒为 false。既然分裂不可避免，就必须承认并消除其危险性，而不是假装它不存在。
2. **一旦 `ServiceToken` 获得状态，裂缝立刻出现**。只要它持有任何模块级引用（注册表引用、订阅句柄、计数器），副本与本体就会行为分叉，且是「编译时对、运行时错」—— 只在跨插件服务消费时暴露，本地测试全绿。
3. **当前没有任何测试守住这条不变量**。`tests/unit/container.test.ts` 测的是行为，不是「ServiceToken 必须无状态」。

### 3.3 目标形态：把危险在类型层面消灭

```ts
// src/kernel/contracts/service-token.ts —— 终态
export interface ServiceDescriptor<T> {
  readonly id: string;
  readonly describe: string;
  readonly capability?: string;
  /** 幻影字段，仅参与类型推导，运行期不存在 */
  readonly __type?: T;
}

/**
 * 令牌是「品牌化字符串」，不是类。
 * 契约只有一条：同一 id 在全进程内必须指向同一服务。
 */
export interface ServiceToken<T> extends ServiceDescriptor<T> {
  readonly [TOKEN_BRAND]: true;
}

export function defineToken<T>(d: ServiceDescriptor<T>): ServiceToken<T>;
```

关键点：

- `defineToken` 是**纯函数**，无模块级 `Map`、无副作用、无原型方法 → **任何副本的行为完全一致**，分裂无害。
- `TOKEN_BRAND` 是 `unique symbol`，只能由 `defineToken` 产生 → 插件**不能手搓一个假令牌**（必须调用工厂，而这个工厂会被 esbuild 正确内联）。
- 迁移影响：`new ServiceToken()` 私有构造器消失，`ServiceToken.create()` 改名为 `defineToken()`（破坏式变更，允许）。
- 新增一条单测断言不变量：`Object.keys(defineToken({id:'x',describe:'x'}))` 恰好等于 `['id','describe','capability']`（按 presence），且两次调用同一 id 得到的对象 `JSON.stringify` 相等。

**这样，参考文档里「形式 5 的类型身份漂移风险」被彻底消灭 —— 不是靠「当前恰好安全」，而是靠「让不安全在类型层面不可表达」。**

---

## 4. worker 隔离插件在各形式下的可用性

### 4.1 结论

| 形态 | worker 内可加载 | 判定 |
| --- | --- | --- |
| 源码 `.ts` + `registerTsLoader()` | dev 靠 tsx 可以；**打包态不可能**（tsx 是 devDependency，`FuseV1Options.EnableNodeOptionsEnvironmentVariable: false` 又封死了 `NODE_OPTIONS` 通道，`forge.config.mts:51`） | ❌ 删除 |
| bundle 产物 `dist/index.js`（ESM） | ✅ **推荐**。E4 实测 `{X, default: function}`，`instantiatePlugin` 只需取 `default` |
| 自包含 `.cjs` | ✅ 能跑（E4），但 `default` 是 CJS namespace 对象，**多一层解包** | ⚠️ 次选 |

### 4.2 布局：`extraResource` 必须把插件放在 asar **外**

```
resources/
├── app.asar               ← Electron 默认加载（OnlyLoadAppFromAsar: true）
└── rem2-plugins/          ← extraResource 落点，在 asar 外
    ├── com.rem2.hello-command/
    │   ├── plugin.json
    │   └── dist/index.js
    └── com.rem2.notify-worker/
        ├── plugin.json
        └── dist/index.js
```

理由：Worker 内 `import()` 与主进程内 `import()` 都走 Node ESM loader；asar 的 fs 补丁主要覆盖 `require`，把动态 `import()` 指向 asar 内路径在打包态不可靠。放 asar 外是唯一稳妥解。

### 4.3 worker-bootstrap 如何拿到产物路径 —— 现状设计正确，保留

`worker-bootstrap.ts` 是 `eval: true` 注入的**纯 JS 字符串**，没有任何硬编码路径。产物路径由 `WorkerPluginHost.ensureStarted()` 在 `init` 消息里传：

```
kernel → worker: { t:'init', entrySpecifier: <绝对 file URL>, manifest, rootDir, configSnapshot, permissions }
worker: await import(msg.entrySpecifier)
```

（`worker-host.ts:133-154`、`worker-bootstrap.ts:183`）

**这个设计要原样保留**：eval 字符串不需要知道任何路径，因此同一份字符串在 dev / test / prod 三态下都成立。若改成「worker 里 `import('rem2-plugins/…')` 裸包名」，就等于把路径知识塞回 bootstrap，立刻引入三态差异。

**唯一要改的**：`resolveEntry()` 不再补全 `.ts`（见 §5 映射表），因此 `entrySpecifier` 恒为 `.js` / `.mjs`。

---

## 5. 「打包产物 ↔ 路径 ↔ 解析规则」映射表（P0-6 核心交付物）

| 消费方 | dev 态（`pnpm dev` / `pnpm start` / `pnpm test`） | 打包态（`pnpm make` 后运行） | 谁负责转译 | 解析规则 |
| --- | --- | --- | --- | --- |
| **Electron main** | Vite dev（`electron-forge start` 的 serve）→ 内存 bundle | Vite build → `.vite/build/main.cjs` | **Vite**（E1 证明 `.js`→`.ts` 成立） | alias `rem2-kernel` → `src/kernel/index.ts`；`electron` 标 external |
| **Electron preload** | 同上 | 同上 → `.vite/build/preload.cjs` | **Vite** | 同上；`contextIsolation: true` 保留 |
| **renderer（Svelte）** | Vite dev server（`MAIN_WINDOW_VITE_DEV_SERVER_URL`）+ HMR | `loadFile('../renderer/main_window/index.html')` | **Vite + @sveltejs/vite-plugin-svelte** | renderer **不得** import 内核；只经 preload IPC |
| **插件（in-process）** | `plugins-dist/<id>/dist/index.js`（真实文件） | `resources/rem2-plugins/<id>/dist/index.js`（asar 外） | **esbuild（构建期）** | `loader.resolveEntry()` → 绝对 file URL → `import()` |
| **插件（worker）** | 同上 | 同上 | **esbuild** | `WorkerPluginHost` 传 `entrySpecifier`；bootstrap `await import()` |
| **CLI** | `node --import tsx src/host/cli/run.ts` | 不随包分发（开发工具）；如需分发则走 dist | **tsx**（dev）/ 无（dist 态） | tsx 兜 `.js`→`.ts`；dist 态是纯 `.js` |
| **vitest** | Vite-node transform | — | **Vite** | `vitest.config.ts` 的 alias 与 vite.shared 共用同一常量 |
| **`import type` 解析** | `tsconfig.json` paths → `src/kernel/index.ts` | 同左（tsc 侧与运行态解耦） | **tsc** | 与运行期解析**故意不同**，这是设计而非缺陷 |

### 5.1 插件 `entry` 在两态分别指向什么 —— **同一个值**

```jsonc
{ "entry": "dist/index.js" }   // dev 与 prod 完全相同
```

**推论（重要）**：`module-resolver.ts:56-65` 的扩展名补全顺序 `[.ts, .js, .mjs, .cjs, index.ts, …]` 必须**删除 `.ts` 与 `index.ts`**。目标形态下 `.ts` 入口不存在，补全 `.ts` 只会让「忘记 build」的错误静默指向源码或产生误导性候选。终态补全列表：`[.js, .mjs, index.js, index.mjs]`。

---

## 6. 与参考文档结论的差异汇总（诚实标注）

| 参考文档结论 | 本轮裁决 | 依据 |
| --- | --- | --- |
| 「形式 2 单独用修不好开发态，因为 Vite 不做 `.js`→`.ts`」 | **推翻**。Vite 8 做了 | E1 实测 + `node.js:29105-29121` 源码 |
| 「形式 1 需要双份 `plugin.json` 或 entry 数组」 | **推翻**。单一 entry，开发态也用产物 | 消除「行为依赖环境」这一更难测的漂移 |
| 「推荐形式 5 + 契约快照自动化」 | **部分采纳**。采纳「自包含」，否决 `.cjs` 与手抄快照 | E4；bundle 从源码内联，无手抄 |
| 「`ServiceToken` 类型身份丢失，但当前靠 id 匹配所以安全」 | **事实确认 + 前进一步**。把 `ServiceToken` 降格为品牌化字符串 + 纯函数工厂，使不安全不可表达 | E3 |
| 「形式 2 的 `development` 条件必须每个宿主显式声明」 | **采纳问题、否决方案**。因为 dev 也用产物，该条件永不被命中 → 删除 | §2.1/§2.2 |
| 「`tsconfig.build.json` 不要开 `rewriteRelativeImportExtensions`」 | **完全采纳** | E2 |

---

## 7. 插件侧 tsconfig：独立 vs 用根 tsconfig

**裁决：插件侧必须独立 tsconfig。** 参考文档 §四① 的判断正确，理由补一条更硬的：

| 维度 | 根 tsconfig | 插件独立 tsconfig |
| --- | --- | --- |
| `moduleResolution` | `NodeNext`（为了 `tsc` 转译内核 `.js` 后缀） | 同样 `NodeNext`，但**不 emit**，只做类型检查 |
| `outDir` / `declaration` | 无（`noEmit` 走 typecheck 脚本） | 无（emit 交给 esbuild） |
| `paths` | 有（`rem2-kernel` + `rem2-kernel/*` 通配） | **只保留 `rem2-kernel` 一条，删掉 `rem2-kernel/*`** ← 见下 |
| `include` | 覆盖 `src` + `plugins` + `tests` | 只覆盖自身 `src` |
| `resolveJsonModule` | 开 | 开（插件 manifest 用 JSON） |

**关键改动**：`tsconfig.json:28` 的 `"rem2-kernel/*": ["src/kernel/*"]` 必须删除。它让插件可以写 `import { Container } from 'rem2-kernel/di/container.js'` 直接深链内核实现，而现有契约测试 `plugin-contract.test.ts:60-72` 只拦字面量含 `src/kernel` 的说明符，**拦不住这种裸包名深链**（诊断报告 O21 已记录）。删掉通配后，插件侧的「只能从公共出口引用」从**约定**变成**类型系统强制**。

```jsonc
// plugins/<id>/tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "baseUrl": ".",
    // 只指向内核公共出口，不开 /* 通配（防止深链实现层）
    "paths": { "rem2-kernel": ["../../src/kernel/index.ts"] }
  },
  "include": ["src/**/*.ts"]
}
```

**注意 `paths` 只影响类型，产物里没有 `rem2-kernel`** —— 因为 esbuild `--bundle` 会把它内联（或按 §3.3 的 `defineToken` 内联）。这正是我们想要的：**类型解析走源码（改内核即时生效），运行期零耦合**。

---

## 8. 唯一推荐组合

> **形式 1（插件 esbuild ESM bundle + `extraResource` 到 asar 外）**
> **+ 形式 2 的「内核 dist」降级版（仅 `.d.ts` + npm 分发，不做 dev/prod 条件 exports）**
> **+ 形式 5 的「自包含」收益（已被 bundle 方案吸收）**
> **+ 形式 5 不可采纳的部分全部否决（`.cjs`、手抄契约快照）**
> **+ 一条本轮新增的硬约束：`ServiceToken` 降格为品牌化字符串 + 纯函数工厂**

### 三条决定性理由

1. **插件走 Node 原生 `import()`，不经 Vite（E2）→ 必须预编译**。这条锁死了形式 3 / 4 全部出局，也锁死了「插件入口指向 `.ts`」这种形态。
2. **bundle 一次性拿到三个收益**：自包含（形式 5 的核心价值）、无手抄（`KernelTokens` id 由 esbuild 从源码内联，永不漂移）、dev/prod 单一 entry（消除双份维护）。参考文档把「bundle」归为形式 1 的一个子选项，本轮把它提升为**唯一插件构建方式**。
3. **形式 2 的价值被 E1 重新定位**。Vite 8 自带 `.js`→`.ts` 回退，所以内核 dist 对宿主三端零需求；dist 只剩「类型分发 + 包身份」两项价值。据此**删掉 `development` 条件**（永不被命中的条件 = 静默陷阱），并保留 `tsc -p tsconfig.build.json` 作为类型分发产物。

### 被否决项及判据

| 被否决 | 判据 |
| --- | --- |
| 形式 3（内核自带转译器） | `tests/contract/kernel-deps.test.ts:120-125` 断言 `dependencies` 为空；且 strip-only 不支持本项目大量使用的参数属性（`config-service.ts:54`、`permission-manager.ts:19-24`） |
| 形式 4（整仓 + node_modules 进 asar） | 破零依赖红线；asar 内 ESM loader 对深层动态 `import()` 覆盖不可靠；无法给第三方插件可复现的最小包 |
| 形式 5 的 `.cjs` 形态 | E4 实测多一层解包；与 `"type": "module"` 方向相反；使插件形态判定从 1 种退回 4 种 |
| 形式 5 的手抄契约快照 | esbuild 从源码内联，无手抄即无漂移；手抄 `KernelTokens.*.id` 的错误只在跨插件消费时暴露 |
| `development` 条件 exports | dev 也用产物，该条件无宿主会命中；留着等于给未来留静默陷阱 |
| `tsconfig.json` 的 `rem2-kernel/*` 通配 | 使「只能从公共出口引用」从约定变成可绕过的约定；现有契约测试拦不住 |
| `rewriteRelativeImportExtensions` | E2：产物里的 `./x.ts` 在 Node 侧必然 ENOENT |

---

## 9. 形式选型带来的连带决策清单（供工程师）

| # | 决策 | 影响文件 |
| --- | --- | --- |
| 1 | 删除 `registerTsLoader()` 及其动态 import | `src/electron-shell/main.ts:57-65, 71` |
| 2 | `resolveEntry` 补全列表去掉 `.ts` / `index.ts` | `src/kernel/loader/module-resolver.ts:56-65` |
| 3 | `ServiceToken` 类 → 接口 + `defineToken` 纯函数 | `src/kernel/contracts/service-token.ts` 全文 |
| 4 | `tsconfig.build.json` 新增 | 新文件 |
| 5 | `exports` 条件化（只有 `types` + `default`）、加 `build:kernel` / `build:plugins` / `predev` / `premake` | `package.json` |
| 6 | `pnpm-workspace.yaml` 加 `packages: ['plugins/*']` | `pnpm-workspace.yaml` |
| 7 | 6 个插件各补 `package.json`（`type: module` + esbuild build 脚本） | `plugins/*/package.json` × 6 |
| 8 | 6 个插件 `entry` 统一改 `dist/index.js` | `plugins/*/plugin.json` × 6 |
| 9 | 插件产物聚合到 `plugins-dist/`；`.gitignore` 加之 | 新增 `.gitignore` 条目 |
| 10 | `forge.config.mts` 加 `extraResource` | `forge.config.mts:11-13` |
| 11 | `vite.shared.mts` 新增（alias 单源） | 新文件 |
| 12 | 三个 vite config 各自实质化 | `vite.{main,preload,renderer}.config.mts` |
| 13 | `tsconfig.json` 删 `rem2-kernel/*` 通配 | `tsconfig.json:28` |
| 14 | `vitest.config.ts` 的 alias 改为 import `vite.shared.mts` | `vitest.config.ts:52-56` |