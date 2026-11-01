# 05 · 本地插件管理

> 面向宿主维护者与需要排查安装 / 启停问题的用户。插件 API 见 [`02-plugin-api.md`](02-plugin-api.md)，IPC 白名单见 [`03-frontend-ipc.md`](03-frontend-ipc.md)。
>
> English: [`en/05-plugin-management.md`](en/05-plugin-management.md)

---

## 1. 事实来源

| 事实            | 权威来源                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| 已安装清单      | 扫描 `builtinRoot` 与 `userRoot` 下的 `plugin.json`                      |
| 运行态          | `Kernel.pluginRegistry` + `Kernel.lastStartResult`                       |
| 禁用意图        | `<userData>/plugin-manager.json`                                         |
| 显式能力授权    | `<userData>/plugin-grants.json`（用户插件声明能力的授权集合）            |
| 插件配置 / 数据 | 插件目录的 `config/`、`data/`，卸载时迁入 `<userData>/plugin-data/<id>/` |
| 远程来源记录    | `<userData>/plugin-provenance.json`（URL + 发布方摘要 + 安装时间）       |
| 更新事务日志    | `<userData>/plugin-transactions/<id>.json`（启动时恢复未完成更新）       |
| 远程包缓存      | `<userData>/plugin-packages/<sha256(url[+digest])>.zip`（TTL 10 分钟）   |
| 宿主代理设置    | `<userData>/proxy-settings.json`（system / direct / manual）             |
| 可用 IPC 方法   | `src/shared/ipc-contract.ts`                                             |

禁用意图与运行态分开保存：启用但启动失败的插件保持 `enabled: true`、运行态 `Failed`，用户可直接重试。

Electron 下目录固定为：

```text
<userData>/
├── plugins/<plugin-id>/          # 用户安装目录（可写）
├── plugin-manager.json           # { version: 1, disabled: string[] }
├── plugin-grants.json            # { version: 1, entries: { <id>: capability[] } }
├── plugin-provenance.json        # { version: 1, entries: { <id>: { kind, url, sha256, … } } }
├── plugin-transactions/<id>.json # 更新事务日志；启动时先恢复再启动插件
├── plugin-packages/<hash>.zip    # 远程下载缓存（10 分钟内复用）
├── proxy-settings.json           # { version: 1, proxy: { mode, address?, bypass? } }
└── plugin-data/<plugin-id>/      # 卸载后保留的 config/ 与 data/
```

内置插件来自 `builtinPluginsRoot()`，打包后是 `resources/plugins-dist`（仅内置示例插件），只读且不可卸载。外部插件（如 `theme-switcher`）构建到 `plugins-external-dist`，通过 GitHub Release 安装到 `<userData>/plugins`。`<userData>` 由 `app.getPath('userData')` 决定，不在仓库内。

---

## 2. Manifest 与安装包

本地安装只接受**已构建插件目录**，不执行 npm / pnpm / 构建脚本。目录至少包含：

```text
<source>/
├── plugin.json
└── dist/index.js       # 或 manifest.entry 指向的其他 .js / .mjs 常规文件
```

清单由运行时 `validateManifest` 校验，与发现阶段使用同一实现：

| 字段                            | 规则                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `id`                            | 必填，`^[a-z0-9]+([._-][a-z0-9]+)*$`，至少 3 字符           |
| `name`                          | 必填，非空                                                  |
| `version`                       | 必填，semver                                                |
| `entry`                         | 必填，相对路径，仅 `.js` / `.mjs`，解析后必须留在插件目录内 |
| `compatibility.minKernel`       | 必填，semver 或 range                                       |
| `compatibility.contractVersion` | 必填，主版本必须与内核契约一致                              |
| `dependencies`                  | 可选；缺失或不满足版本时拒绝安装                            |
| `optionalDependencies`          | 可选；缺失只会使插件 `Degraded`                             |
| `requires`                      | 可选；能力名必须合法且不重复                                |
| `contributes`                   | 可选；扩展点必须是已声明 id，同一槽位不得重复               |
| `isolation`                     | 可选；`in-process` / `worker`                               |

`entry` 必须真实存在、是普通文件，且 `realpath` 仍在插件目录内。符号链接一律拒绝。

---

## 3. 状态定义

管理界面同时展示两类状态，不互相替代：

| 状态                                | 含义                                                   |
| ----------------------------------- | ------------------------------------------------------ |
| `Disabled`                          | 持久禁用意图为 true；启动与启用解析时不会成为依赖候选  |
| `Registered` … `Configured`         | 内核生命周期中间态                                     |
| `Active`                            | 已启动                                                 |
| `Degraded`                          | 已启动但有软依赖缺失或非致命阶段失败                   |
| `Failed`                            | 加载、授权或启动失败；`enabled` 仍可为 true，可重试    |
| `Dropped`                           | 启停时依赖解析失败（缺硬依赖、版本不符、不兼容或成环） |
| `Stopped` / `Unloaded` / `Disposed` | 已停止或已释放；仍安装且未禁用时显示为 `Stopped`       |

`Disabled` 是对外管理状态，不属于内核 `PluginStateT`。禁用只写持久意图：若插件当前仍在运行，运行态不会立即改变，DTO 的 `restartRequired` 为 `true`，UI 显示重启入口；执行 `plugin.restart` 后插件才真正停止，并从此保持禁用。

---

## 4. 安装

1. renderer 只发送 `plugin.install.directory`，不带路径参数。
2. 主进程打开原生目录选择框，用户选择目录即视为授权来源；renderer 不能提交任意路径。
3. 校验源目录为真实目录，且不能位于受管根目录内或包含受管根目录。
4. 读取并校验 manifest、entry、兼容性、重复 id、硬依赖与软依赖。
5. 拒绝内置插件同 id 覆盖；不允许用户插件替换内置实现。
6. 读取 manifest 并弹出原生确认框，列出 id、版本与声明能力；确认即授权这些能力并同意“安装并启用”。
7. 复制到同卷临时目录 `<userRoot>/.<id>.install-*`：
   - 不跟随符号链接；
   - 目标文件使用排他创建，不覆盖既有文件；
   - 上限 2000 个文件、100 MiB。
8. 复核临时目录中的 manifest / version / entry 与已批准能力。
9. **先持久化已批准的授权并清除旧的禁用标记**，再原子 `rename` 到 `<userRoot>/<id>`。
10. 新插件为启用状态：同步启用硬依赖闭包，并由 `Kernel.enablePlugin` 立即启动。插件自身 `onStart` 失败时仍保持已安装、已启用并显示健康错误。
11. 任意步骤失败时删除临时目录；已提交则删除目标目录、本次写入的授权，并恢复禁用标记。

安装流程已包含启用：能力授权发生在复制任何文件之前，不再有“安装完成后再启用并授权”的独立步骤。

---

## 5. 远程安装

远程安装拆成 **预览（inspect）→ 用户确认（install）** 两步，renderer 只提供 URL，下载、解压、校验全部在主进程完成。

### 来源与摘要

| 输入                                                            | 解析方式                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `github.com/<owner>/<repo>/releases/download/<tag>/<asset>.zip` | 直链资产；仍会尝试读取同 tag 的 release 元数据以取得摘要                                                             |
| `github.com/<owner>/<repo>/releases/tag/<tag>`                  | GitHub API `releases/tags/<tag>`，必须有且仅有 1 个 `.zip` 资产                                                      |
| `github.com/<owner>/<repo>` / `.../releases/latest`             | GitHub API `releases/latest`，同样要求唯一 `.zip` 资产                                                               |
| allowlist 内其它主机的 `https://` 直链（路径以 `.zip` 结尾）    | 直接下载；版本号尽力从文件名推断，**没有可信摘要**，`inspect` 返回 `sha256: undefined`；其它主机的直链在解析阶段拒绝 |

摘要只来自两处：release 资产的 `digest` 字段（`sha256:<hex>`）或同名 `<asset>.sha256` sidecar 文件。两者都没有就返回 `undefined`，绝不使用下载后自算的摘要冒充发布方摘要。

### inspect（`plugin.remote.inspect`）

1. 解析发布元数据 → 得到 `downloadUrl`、版本、发布时间、notes、发布方摘要与大小。
2. 下载到 `<userData>/plugin-packages/<sha256(downloadUrl [+ "\0" + 可信摘要])>.zip`；摘要已知时参与缓存键，命中 10 分钟内的缓存则跳过下载。仅 HTTPS，主机必须在 `github.com` / `api.github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` allowlist 内。生产环境使用 Electron `ClientRequest` 适配器（同样遵循设置页代理），手动跟随重定向并逐跳校验主机、协议与最多 5 跳；默认 50 MiB 上限、30 s 超时。
3. 若元数据带摘要则校验（`verifyFileDigest`）。
4. 解压到 `<userRoot>/.inspect-*` 临时目录：EOCD + central directory 手工解析，支持 store / deflate，CRC32 校验；拒绝 zip64、加密、多卷、绝对路径、`..`、反斜杠、盘符、符号链接与特殊文件；默认 2000 文件 / 100 MiB / 单文件 25 MiB。
5. 读取并校验 `plugin.json`、entry 存在性、版本兼容性与硬依赖可满足性（复用 `DependencyResolver`）。
6. 返回 `PluginRemoteInspectionDto`；临时目录必删。**不写插件目录、不改禁用意图、不执行代码。**

### install（`plugin.install.remote`）

1. 请求参数为 `{ operationId, url, sha256?, capabilities? }`；`capabilities` 是用户在预览中批准的能力声明，主进程会对照解压出的 manifest 校验（否则 `E_CAPABILITY_INVALID`）。同时必须有可信摘要：`release.sha256` 或调用方显式 `sha256`；缺失 → `E_DIGEST_MISSING`，不下载。
2. 同一 id 已安装 → `E_DUPLICATE_ID`（更新走独立方法）。
3. 下载 / 命中缓存 → 摘要校验（不匹配 `E_DIGEST_MISMATCH`）。
4. 解压到 `<userRoot>/.install-*` → 复核 manifest 与已批准能力 → **先持久化授权并清除旧的禁用标记** → 原子 `rename` 到 `<userRoot>/<id>`。
5. 成功后写 provenance，再启用硬依赖闭包并启动插件。任一步失败删除已提交目录、本次写入的授权与 provenance，并删除本次缓存，随后恢复禁用标记：即使目录清理失败，下次启动也不会执行一个安装已报告失败的插件。成功结果直接由已校验 candidate 投影；插件自身生命周期失败时保持已安装、已启用并显示健康错误。

### 进度与取消

- `operationId` 由 renderer 生成（1..64 安全字符），inspect / install / update 的下载与校验阶段通过 `plugin.download.progress` 事件推送 `{ operationId, phase, receivedBytes?, totalBytes? }`，phase 为 `downloading` / `verifying` / `extracting` / `installing`。
- `plugin.download.cancel` 按 `operationId` 中止对应的 `AbortController`；下载中的 `.part-*` 临时文件会被清理，重复取消幂等（第二次返回 `cancelled: false`）。

### 远程错误码

| code                  | 含义                                                      |
| --------------------- | --------------------------------------------------------- |
| `E_SOURCE_INVALID`    | 非 HTTPS、主机不在 allowlist、重定向违规或 URL 形式不支持 |
| `E_DOWNLOAD`          | 非 2xx、网络失败或响应缺少 body                           |
| `E_DOWNLOAD_TIMEOUT`  | 超过总超时（默认 30 s）                                   |
| `E_CANCELLED`         | 调用方取消或外部 signal 中止                              |
| `E_PACKAGE_TOO_LARGE` | 声明或流式超过大小上限；解压文件数 / 总字节超限           |
| `E_PACKAGE_INVALID`   | 非 ZIP、zip64、加密、多卷、未知压缩、CRC 或结构损坏       |
| `E_PATH_ESCAPE`       | ZIP 条目绝对路径 / `..` / 反斜杠 / 盘符 / NUL             |
| `E_UNSAFE_TREE`       | ZIP 条目为符号链接或特殊文件                              |
| `E_DIGEST_MISSING`    | 发布方未提供摘要，安装被阻止                              |
| `E_DIGEST_INVALID`    | 摘要不是 64 位十六进制                                    |
| `E_DIGEST_MISMATCH`   | 下载实体与可信摘要不一致                                  |

管理操作还可能返回 `E_CONFIRMATION_DENIED`（主进程确认被取消）、`E_CONFIRMATION_UNAVAILABLE`（宿主无法确认）、`E_TARGET_CHANGED`（确认期间插件版本/摘要变化）、`E_UPDATE_CHANGED`（确认后发布变化）或 `E_UPDATE_COMMITTED`（更新已提交但状态投影失败）。

---

## 6. 更新与回滚

`plugin.update.check`（可选 `pluginId`）按 provenance 记录的发布源解析最新 release：

- 仅比较带 provenance 的用户插件；没有 provenance 的插件不会被检查，指定单插件且缺 provenance 时返回 `E_PROVENANCE_MISSING`。
- 版本比较复用内核 semver（`parseVersion` / `compareVersions`）；无法解析时 `hasUpdate: false`。
- 批量检查会跳过单个不可达来源，但把失败写入 `issues`，不会把网络故障伪装成“无更新”；定向检查则原样报错。
- 可更新但发布方缺少摘要时，`issues` 会说明该条更新无法应用。

`plugin.update.install`（`{ operationId, pluginId, expectedVersion, expectedSha256 }`）步骤：

1. 校验 provenance 与来源；最新版本不高于已安装版本 → `changed: false`，不落盘。
2. **绑定确认值**：重新解析出的版本 / 摘要必须与 `expectedVersion` / `expectedSha256` 完全一致；发布在检查后变化 → `E_UPDATE_CHANGED`，不下载。
3. 下载 / 摘要校验 / 解压 / manifest 校验；缺发布摘要 → `E_DIGEST_MISSING`；包内 manifest 版本与 release 版本不一致 → `E_MANIFEST_INVALID`。
4. 用新 manifest 替换旧 candidate 再跑一次 `DependencyResolver`；被 drop → `E_DEPENDENCY`，不落盘。
5. 备份：`<userRoot>/<id>` 原子 rename 到 `<userRoot>/.backup-<id>-<ts>`（同卷）。在第一次破坏性 rename 前写入 `<userData>/plugin-transactions/<id>.json`，记录阶段、备份/工作目录、旧禁用意图、旧/新 provenance。
6. 新版本 staging → rename 到 `<userRoot>/<id>`；把备份里的 `config/`、`data/` **覆盖**到新目录，**用户旧文件优先于新包默认文件**。更新前若 `config` / `data` 是符号链接或特殊文件，直接 `E_UNSAFE_TREE`，不做破坏性操作。
7. 保持原 `enabled` 意图；原本运行中的插件调用 `Kernel.restartPlugins(state.ids())`，并检查结果是否为 `Active` / `Degraded`。若新 manifest 引入尚未授权的能力，更新安装为 `Disabled` 并提示重新授权，不静默以受限权限启动。
8. 提交前失败或新版本起不来：删除新目录、把备份 rename 回原位、恢复旧禁用意图与 provenance，再次 `restartPlugins` 恢复运行态，返回 `E_UPDATE_FAILED`；若回滚本身失败则 `E_ROLLBACK_FAILED`，保留事务日志供下次启动重试。
9. 成功：更新 provenance 并写入 `committed` 阶段后视为已提交；删除备份/journal 失败只作为清理提示，不触发回滚。提交后的状态投影失败返回 `E_UPDATE_COMMITTED`，不会删除唯一有效目录。
10. 启动时 `prepare()` 在 `kernel.start()` 之前读取事务日志：未提交事务恢复到旧目录/旧 provenance；已提交事务清理备份；无日志的孤立 `.backup-*` 与 staging 也会恢复/清理。**只有恢复完整成功才删除 `/plugin-transactions/<id>.json`**；清理备份失败时保留记录，下次启动继续重试。

并发：变更操作串行执行；同一 `operationId` 不允许重复注册。取消句柄在进入队列前注册，排队中的操作可取消；一旦进入 `installing` 提交临界区，取消返回 `cancelled: false`。`plugin.list` / `plugin.detail` 会等待/重试跨越提交临界区，不会观察到插件消失或新旧 origin 混合的快照。

---

## 7. 来源记录（provenance）

`<userData>/plugin-provenance.json` 只记录**远程来源**：

```json
{
  "version": 1,
  "entries": {
    "com.acme.hello": {
      "kind": "remote",
      "url": "https://github.com/acme/hello",
      "sha256": "<发布方摘要>",
      "publishedAt": "2026-01-01T00:00:00Z",
      "installedAt": "2026-02-01T00:00:00Z"
    }
  }
}
```

- 原子写入；文件损坏或字段非法 → `E_STATE_INVALID`；写入失败回滚内存并 `E_STATE_WRITE`。
- `PluginDetailDto.origin` 由它投影而来（`kind: 'remote'` + URL + 摘要 + 发布时间）；renderer 只展示 URL 与摘要前 12 位，不拿路径。
- 卸载时删除对应条目，避免对已不存在的插件继续提示更新。
- 更新检查与更新安装只信任这里记录的 URL，不接受 renderer 传入的更新来源。

---

## 8. 完整性 vs 真实性

- **SHA-256 只证明完整性**：下载内容与发布方给出的摘要一致，不证明发布者身份，也不能阻止发布者自己发布恶意包。
- 当前**没有**签名验证、来源信誉评分、漏洞扫描或证书固定；GitHub 账号被盗即等于来源被盗。
- 权限声明（`requires`）不是沙箱：远程插件与本地插件一样走 `requires → PermissionManager → CapabilityGuard`，不能获得额外 Electron 主进程能力；`in-process` 插件仍可导入 Node API。
- 因此 UI 在预览与更新确认框里同时展示来源 URL、版本、发布时间、权限声明与摘要，并明确写出上述限制；安装按钮在缺少摘要时禁用。

---

## 9. 能力授权（沙箱插件）

`source === 'builtin'` 的插件是 `trusted`，声明能力按策略授予；用户安装的插件是 `sandboxed`，默认只授予 `log.sink`，其余能力（包括 `ui.theme` / `ui.panel` / `ui.route`）在策略层被拒绝，贡献扩展点时抛 `CapabilityDeniedError`，插件启动为 `Failed`。

显式授权流程：

1. 详情 DTO 的 `permissions` 给出当前 `{ granted, denied }`（已持久化授权会覆盖策略拒绝）。
2. `plugin.permission.grant`（`{ pluginId, capabilities }`）只接受 manifest `requires` 中声明过的能力；未声明 → `E_CAPABILITY_INVALID`；内置插件 → `E_BUILTIN_PROTECTED`。
3. 授权写入 `<userData>/plugin-grants.json`（原子写，键为插件 id，值为能力数组），启动时由内核在信任策略判定后逐个应用，且只应用 manifest 声明过的能力，授权文件不能放大插件权限。
4. 授权在安装阶段完成：两种安装路径都先读取 manifest 并弹出原生确认框，逐项列出声明能力。确认后持久化授权并以启用状态安装，插件首次启动即拥有全部已批准能力。`plugin.enable { pluginId, capabilities }` 保留为“授权并启用”兜底路径，适用于早已安装且仍被拒绝能力的插件（例如在此流程上线前安装的插件）；已 `Failed` 的插件授权后 Enable 会先卸载再重启。
5. 卸载会在删除代码前清理该插件的授权条目；清理失败时卸载失败且插件保持禁用，避免重装后继承旧授权。

---

## 10. 启用与禁用

### 启用

- 先写 `disabled: false`，再调用 `Kernel.enablePlugin(id, disabledIds)`。
- 若硬依赖只是被禁用（已安装），启用时会**同步启用整条硬依赖闭包**，不会报 `missing hard dependency`：用户眼里“前置被关掉”不等于“安装损坏”。
- 只有依赖确实不存在时，才由解析器报错（`E_MISSING_DEPENDENCY: missing hard dependency: <id>@<range>`）。
- 重新发现并解析当前安装集合；按拓扑顺序启动目标及其所需硬依赖，已 `Active` / `Degraded` 的依赖跳过。
- 已 `Failed` 的目标会先卸载再重试。
- 启动失败时保留 `enabled: true` 和 `Failed`，错误原样返回管理 UI；资源由内核回滚与回收。

### 禁用

- **级联禁用**：与目标同时被禁用的是“已加载的依赖者闭包”（传递闭包）。不再抛 `disable dependents first`，也不会出现“前置被关、依赖者仍启用”的悬空状态。
- 只改持久意图，不原地停止运行中的插件：原地 Stop 之后模块缓存、定时器和模块级单例都处于不确定状态，重启才是干净的语义。
- 目标或其依赖者仍在运行时，结果 `restartRequired: true`，UI 显示 "Restart the plugin service to apply pending changes." 与重启按钮。
- 重复禁用返回 `changed: false`；若运行态仍未同步，`restartRequired` 继续为 `true`，不会把待办吞掉。
- 意图文件写入失败时，回滚本次已写入的禁用意图，避免半套状态。

### 重启插件服务

`plugin.restart` → `Kernel.restartPlugins(state.ids())`：

1. 按 `loadOrder` 逆序停止所有已加载插件，执行 Stop → Unload → Dispose，撤回扩展点、权限、健康检查与子容器（单个停止钩子失败只记日志，不阻断其余插件）。
2. 以当前禁用意图重新发现、解析、按拓扑启动；加载时带 cache-busting 查询，模块级状态不会跨重启残留。
3. **不触碰**内核根容器、事件总线、命令分发器、日志/追踪 sink、Electron 主进程与窗口；`kernel.isStarted()` 始终为 `true`。
4. 重启期间 `plugin.state-changed` 会连续触发，renderer 侧做了 60 ms 合并，避免面板/路由被重复拉取。

因此“重启”不会重建主进程，也不会重新打开窗口；只有插件代码与扩展点被重新装载。

---

## 11. 卸载

1. 仅允许 `source === 'user'`；内置插件返回 `E_BUILTIN_PROTECTED`。
2. 任意已安装插件（无论启用与否）硬依赖目标时返回 `E_DEPENDENTS`。
3. **任何副作用之前**校验目标 `realpath` 仍在受管用户根目录内，并确认 `config/`、`data/` 是真实目录或不存在。
4. `config` / `data` 为符号链接或特殊文件时返回 `E_UNSAFE_TREE`，不跟随、不删除，避免丢失链接目标数据。
5. 写入禁用意图并停止运行中的插件。
6. 将插件目录的 `config/`、`data/` 复制到 `<userData>/plugin-data/<id>/`，**覆盖**旧保留快照，保证重复卸载保留的是最新配置。
7. 在删除代码前写入 `<userData>/plugin-removed.json` 卸载记录：manifest 快照、安装来源（远程记录 URL 与摘要，目录来源标记为 local directory）与卸载时间。
8. 清理授权与 provenance；任一清理失败则卸载失败、撤销本次卸载记录并保留禁用状态，可安全重试。
9. 递归删除精确插件目录；禁用意图与保留数据不删除，重新安装后仍可恢复用户数据。
10. **插件不会从列表消失**：卸载后的条目以 `NotInstalled` 状态保留在插件管理列表中，并提供 Install 操作。远程插件按记录的确切 URL + 摘要重装同一版本（安装时再次确认能力）；目录插件需重新选择目录（`plugin.install.directory`）。重新安装成功后删除该卸载记录。

删除只作用于 `<userData>/plugins/<id>`，不接受 renderer 路径，也不会触碰内置目录、配置状态文件或 `plugin-data/`。

---

## 12. IPC 与 UI

插件管理方法均为精确白名单：

| method                     | 参数                                                         | 说明                                                                             |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `plugin.list`              | —                                                            | 完整管理 DTO 列表、磁盘校验 issues、重启待办标记                                 |
| `plugin.detail`            | `{ pluginId }`                                               | 单个插件详情（含 `origin`）                                                      |
| `plugin.install.directory` | —                                                            | 主进程目录选择后先读取 manifest 确认能力，再安装并启用；取消返回 `changed:false` |
| `plugin.install.remote`    | `{ operationId, url, sha256?, capabilities? }`               | 远程安装；批准的能力需在 manifest 声明，无发布摘要时拒绝                         |
| `plugin.reinstall`         | `{ pluginId }`                                               | 按卸载记录重装远程插件（固定原版本摘要），安装前再次确认能力                     |
| `plugin.remote.inspect`    | `{ url, operationId? }`                                      | 远程预览；下载 + 校验 + 临时解压，不安装                                         |
| `plugin.download.cancel`   | `{ operationId }`                                            | 取消进行中的下载                                                                 |
| `plugin.update.check`      | `{ pluginId? }`                                              | 检查单个或全部远程插件的更新                                                     |
| `plugin.update.install`    | `{ operationId, pluginId, expectedVersion, expectedSha256 }` | 执行已确认的更新；发布变化则拒绝，失败自动回滚                                   |
| `plugin.enable`            | `{ pluginId, capabilities? }`                                | 启用并等待生命周期完成；带 capabilities 时先授权再启动                           |
| `plugin.permission.grant`  | `{ pluginId, capabilities }`                                 | 为用户插件授予其声明的能力（由启用确认框调用）                                   |
| `plugin.disable`           | `{ pluginId }`                                               | 持久禁用意图，运行中的实例等重启才停止                                           |
| `plugin.uninstall`         | `{ pluginId }`                                               | 卸载并保留用户数据                                                               |
| `plugin.restart`           | —                                                            | 仅重启插件服务，内核与主进程不动                                                 |

所有参数在 `host/ipc/validate.ts` 运行时校验（URL 仅 HTTPS 且 ≤ 2048 字符、`operationId` 为 1..64 安全字符、`pluginId` 为合法格式、更新必须携带确认过的版本与 SHA-256）。错误响应新增可选 `errorCode`，前端 preload 将其挂到 `Error.code`；`message` 保持人类可读。变更操作在 `LocalPluginManager` 内串行执行，防止重复安装、并发启停和状态覆盖。

renderer 对话框不是信任边界：生产主进程对启用、授权、两种安装方式、重装、更新和代理修改再次调用原生确认框，展示已校验的 id、版本、来源、摘要、能力或代理地址。渲染进程即使直接调用 IPC，也不能绕过该确认；取消返回 `E_CONFIRMATION_DENIED`，宿主无法显示确认框时以 `E_CONFIRMATION_UNAVAILABLE` 失败关闭。**卸载没有确认横幅，也没有原生确认框**：Uninstall 按钮本身就是确认。

管理 UI 是宿主常驻的 `PluginManager.svelte`，从顶栏 Plugins 进入。它不依赖 `plugin-inspector`，因此检查器被禁用时仍可恢复。列表、详情、加载、空态、错误和 issues 均由该组件处理；DTO 在 renderer 侧由 `parsePluginList` / `parsePluginOperation` / `parsePluginInspection` / `parsePluginUpdateCheck` / `parseDownloadProgress` 再次校验。顶栏 Settings 是另一个宿主视图，通过 `settings.proxy.get` / `settings.proxy.set` 修改系统/直连/手动代理，保存后立即作用于默认 Electron session，因此窗口请求、插件下载与 release 元数据都走同一代理。

交互约定：

- **禁用与卸载不需要二次确认**，点击即写意图或删除安装目录。启用、授权、两种安装方式、重装、更新和代理修改还会分别经过主进程原生确认。
- 卸载后的插件不会从列表消失：保留为 `NotInstalled` 行，详情显示来源与保留数据说明，操作区提供 `Install`。远程来源按记录 URL + 摘要重装同一版本；目录来源点击 Install 会重新打开目录选择框。
- 当列表或操作结果显示 `restartRequired` 时，顶部出现重启提示与 “Restart plugins” 按钮，调用 `plugin.restart`；提示里的 “pending changes” 可点击，弹出对话框列出仍处于运行态但已写入禁用意图的插件（名称、id、当前状态），确认后再重启。
- **远程安装**：工具栏 “Install from URL…”，输入 → Inspect → 展示来源 URL、id / name / version、发布时间、更新说明、权限声明、依赖与 SHA-256（并标注是否来自发布元数据）→ Approve capabilities & install / Install & enable。确认即在安装前批准这些能力，插件安装后立即启用；原生确认框同样列出这些能力。下载中显示进度条与 Cancel，结束后展示结果或错误码。
- **能力授权**：详情页 “Required capabilities” 逐项显示 granted / denied，但不再提供单独授权按钮。安装在读取 manifest 后即请求授权并默认启用；仅当插件早已安装且仍存在 denied 能力时，点击 Enable 才弹出授权确认框，确认后调用一次 `plugin.enable { pluginId, capabilities }`。
- **更新**：工具栏 “Check updates”，列表展示 current → latest、发布时间与 notes 摘要；每条 “Update” 打开确认弹窗（版本 / 来源 / 摘要 / 权限），确认后才执行，**绝不静默安装**。
- 错误统一映射：`Error.code` → 可读文案；`E_DIGEST_MISSING` 明确提示“发布方未提供摘要，已阻止安装”。

---

## 13. 安全边界

- renderer 无 Node / 文件系统能力，只能调用白名单 IPC；管理操作全部在主进程执行。
- 路径 containment 同时做词法检查和 `realpath` 检查；安装拒绝符号链接、特殊文件、绝对/`../` entry 与受管目录互含。
- 复制使用临时目录 + 排他创建 + 同卷原子 rename；卸载只删除 canonical 受管目录。
- 安装即启用，但启用前必须先通过安装确认：复制文件前读取 manifest、列出声明能力并由用户显式授权，因此“默认启用”不等于“未经同意执行代码”。
- 依赖一致性：禁用会级联关闭已加载的依赖者；卸载拒绝仍被已安装插件硬依赖；启用会同步拉起已安装的依赖闭包，只有依赖确实缺失才报错。
- 权限系统只约束内核能力（`requires` → `PermissionManager` → `CapabilityGuard`），**不是操作系统沙箱**。`in-process` 与 `worker` 插件仍可导入 Node API；worker 只提供故障隔离，不是安全沙箱。
- 远程安装额外约束：仅 HTTPS + 主机 allowlist；只接受 ZIP 且发布必须提供摘要；摘要只来自发布元数据或调用方显式传入；ZIP 解包防 Zip Slip / 绝对路径 / `..` / 反斜杠 / 符号链接 / 特殊文件 / 压缩炸弹，并在解压后再次做词法 + `realpath` containment。
- 生产环境的 Electron `ClientRequest` 适配器使用 session 代理并手动跟随重定向；release 元数据、sidecar 和包下载都逐跳校验主机/协议，最多 5 跳，无法校验则 fail closed。
- 当前没有签名校验、来源信誉、漏洞扫描或自动依赖安装。SHA-256 只证明完整性，不证明发布者身份；仅应安装可信插件。

---

## 14. 已知限制

| #   | 限制                                                                     | 影响 / 后续                                                       |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| M1  | 远程安装仅支持 ZIP                                                       | 无 tar.gz、无 registry、无构建、无 npm 依赖安装                   |
| M2  | 无签名与恶意代码沙箱                                                     | 用户须自行确认来源可信                                            |
| M3  | 插件 manifest 在安装后若被外部修改，列表会显示校验 issue，但不会自动修复 | 重新安装或手工修复                                                |
| M4  | 卸载保留 `config/`、`data/`，不会自动清理                                | 需要删除用户数据时必须手工处理 `plugin-data`                      |
| M5  | 重启只重载插件，不重置主进程或内核内存                                   | 旧模块实例等 GC 回收；这不是进程级重置                            |
| M6  | 多窗口管理页依赖各自主动刷新                                             | 未新增 catalog 事件；当前状态事件只覆盖启停                       |
| R1  | GitHub 发布必须恰好包含 1 个 `.zip` 资产                                 | 多资产 / 无资产 / 仅 tar.gz 的发布无法自动解析                    |
| R2  | 摘要依赖 GitHub API 的 `digest` 或 `.sha256` sidecar                     | 发布方两者都不提供时安装被阻止（设计如此）                        |
| R3  | 直链 URL 无法取得可信摘要                                                | 需要用户在调用参数中显式提供 `sha256`                             |
| R4  | 更新检查按 provenance 的来源逐个请求，无 token 与缓存                    | GitHub 未认证请求有速率限制                                       |
| R5  | 变更操作在主进程串行执行，长下载会阻塞后续变更                           | 列表/详情可读取稳定快照并重试跨越提交窗口；其他变更需等待         |
| R6  | 原生确认或目录选择框会一直等待用户操作                                   | 不设置 IPC 超时以避免“界面已失败、后台仍提交”；由用户关闭应用中止 |
| R7  | 无自动回滚重试、无灰度与降级通道                                         | 回滚失败时需人工检查目录（`E_ROLLBACK_FAILED`）                   |
