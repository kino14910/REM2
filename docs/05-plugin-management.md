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
| 插件配置 / 数据 | 插件目录的 `config/`、`data/`，卸载时迁入 `<userData>/plugin-data/<id>/` |
| 远程来源记录    | `<userData>/plugin-provenance.json`（URL + 发布方摘要 + 安装时间）       |
| 远程包缓存      | `<userData>/plugin-packages/<sha256(url)>.zip`（TTL 10 分钟）            |
| 可用 IPC 方法   | `src/shared/ipc-contract.ts`                                             |

禁用意图与运行态分开保存：启用但启动失败的插件保持 `enabled: true`、运行态 `Failed`，用户可直接重试。

Electron 下目录固定为：

```text
<userData>/
├── plugins/<plugin-id>/          # 用户安装目录（可写）
├── plugin-manager.json           # { version: 1, disabled: string[] }
├── plugin-provenance.json        # { version: 1, entries: { <id>: { kind, url, sha256, … } } }
├── plugin-packages/<hash>.zip    # 远程下载缓存（10 分钟内复用）
└── plugin-data/<plugin-id>/      # 卸载后保留的 config/ 与 data/
```

内置插件来自 `builtinPluginsRoot()`，打包后是 `resources/plugins-dist`，只读且不可卸载。`<userData>` 由 `app.getPath('userData')` 决定，不在仓库内。

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
6. 复制到同卷临时目录 `<userRoot>/.<id>.install-*`：
   - 不跟随符号链接；
   - 目标文件使用排他创建，不覆盖既有文件；
   - 上限 2000 个文件、100 MiB。
7. 复核临时目录中的 manifest / version / entry。
8. 原子 `rename` 到 `<userRoot>/<id>`。
9. 写入禁用意图，默认 `Disabled`，**不执行插件代码**。
10. 任意步骤失败时删除临时目录；已提交则同时删除目标目录，避免半安装。

安装成功不等于启用。用户需在管理页点击 Enable；启动沿用完整生命周期、权限授予与依赖解析。

---

## 5. 远程安装

远程安装拆成 **预览（inspect）→ 用户确认（install）** 两步，renderer 只提供 URL，下载、解压、校验全部在主进程完成。

### 来源与摘要

| 输入                                                            | 解析方式                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `github.com/<owner>/<repo>/releases/download/<tag>/<asset>.zip` | 直链资产；仍会尝试读取同 tag 的 release 元数据以取得摘要                               |
| `github.com/<owner>/<repo>/releases/tag/<tag>`                  | GitHub API `releases/tags/<tag>`，必须有且仅有 1 个 `.zip` 资产                        |
| `github.com/<owner>/<repo>` / `.../releases/latest`             | GitHub API `releases/latest`，同样要求唯一 `.zip` 资产                                 |
| 其它 `https://` 直链（路径以 `.zip` 结尾）                      | 直接下载；版本号尽力从文件名推断，**没有可信摘要**，`inspect` 返回 `sha256: undefined` |

摘要只来自两处：release 资产的 `digest` 字段（`sha256:<hex>`）或同名 `<asset>.sha256` sidecar 文件。两者都没有就返回 `undefined`，绝不使用下载后自算的摘要冒充发布方摘要。

### inspect（`plugin.remote.inspect`）

1. 解析发布元数据 → 得到 `downloadUrl`、版本、发布时间、notes、发布方摘要与大小。
2. 下载到 `<userData>/plugin-packages/<sha256(downloadUrl)>.zip`；命中 10 分钟内的缓存则跳过下载。仅 HTTPS，主机必须在 `github.com` / `api.github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` allowlist 内；重定向手动跟随，拒绝协议降级与跨 allowlist 跳转，最多 5 次；默认 50 MiB 上限、30 s 超时。
3. 若元数据带摘要则校验（`verifyFileDigest`）。
4. 解压到 `<userRoot>/.inspect-*` 临时目录：EOCD + central directory 手工解析，支持 store / deflate，CRC32 校验；拒绝 zip64、加密、多卷、绝对路径、`..`、反斜杠、盘符、符号链接与特殊文件；默认 2000 文件 / 100 MiB / 单文件 25 MiB。
5. 读取并校验 `plugin.json`、entry 存在性、版本兼容性与硬依赖可满足性（复用 `DependencyResolver`）。
6. 返回 `PluginRemoteInspectionDto`；临时目录必删。**不写插件目录、不改禁用意图、不执行代码。**

### install（`plugin.install.remote`）

1. 必须有可信摘要：`release.sha256` 或调用方显式 `sha256`；缺失 → `E_DIGEST_MISSING`，不下载。
2. 同一 id 已安装 → `E_DUPLICATE_ID`（更新走独立方法）。
3. 下载 / 命中缓存 → 摘要校验（不匹配 `E_DIGEST_MISMATCH`）。
4. 解压到 `<userRoot>/.install-*` → 复核 manifest → 原子 `rename` 到 `<userRoot>/<id>` → 写禁用意图。
5. 成功后写 provenance；任一步失败删除已提交目录、回滚禁用意图并删除本次缓存，避免半安装。

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

---

## 6. 更新与回滚

`plugin.update.check`（可选 `pluginId`）按 provenance 记录的发布源解析最新 release：

- 仅比较带 provenance 的用户插件；没有 provenance 的插件不会被检查，指定单插件且缺 provenance 时返回 `E_PROVENANCE_MISSING`。
- 版本比较复用内核 semver（`parseVersion` / `compareVersions`）；无法解析时 `hasUpdate: false`。
- 批量检查会跳过单个不可达来源，定向检查则原样报错。

`plugin.update.install`（`{ operationId, pluginId }`）步骤：

1. 校验 provenance 与来源；最新版本不高于已安装版本 → `changed: false`，不落盘。
2. 解析 / 下载 / 摘要校验 / 解压 / manifest 校验；缺发布摘要 → `E_DIGEST_MISSING`。
3. 用新 manifest 替换旧 candidate 再跑一次 `DependencyResolver`；被 drop → `E_DEPENDENCY`，不落盘。
4. 备份：`<userRoot>/<id>` 原子 rename 到 `<userRoot>/.backup-<id>-<ts>`（同卷）。
5. 新版本 staging → rename 到 `<userRoot>/<id>`；把备份里的 `config/`、`data/` 合并进新目录，**已存在的用户文件不覆盖**。
6. 保持原 `enabled` 意图；原本运行中的插件调用 `Kernel.restartPlugins(state.ids())`，并检查结果是否为 `Active` / `Degraded`。
7. 任一步失败或新版本起不来：删除新目录、把备份 rename 回原位、再次 `restartPlugins` 恢复运行态，provenance 保持旧值，返回 `E_UPDATE_FAILED`；若回滚本身失败则 `E_ROLLBACK_FAILED`，消息里同时带出两个错误。
8. 成功：删除备份、更新 provenance，返回 `restartRequired`（未运行中的插件为 `false`）。

并发：所有管理操作串行执行；同一 `operationId` 不允许重复注册，同一插件不允许并发 update / install（`pendingByPlugin` 检查）。

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

## 9. 启用与禁用

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

## 10. 卸载

1. 仅允许 `source === 'user'`；内置插件返回 `E_BUILTIN_PROTECTED`。
2. 任意已安装插件（无论启用与否）硬依赖目标时返回 `E_DEPENDENTS`。
3. 写入禁用意图并停止运行中的插件。
4. 将插件目录的 `config/`、`data/` 复制到 `<userData>/plugin-data/<id>/`，已存在的保留文件不覆盖。
5. 校验目标 `realpath` 仍在受管用户根目录内，再递归删除该精确目录。
6. 禁用意图与保留数据不删除，重新安装后仍可恢复用户数据。

删除只作用于 `<userData>/plugins/<id>`，不接受 renderer 路径，也不会触碰内置目录、配置状态文件或 `plugin-data/`。

---

## 11. IPC 与 UI

插件管理共 12 个精确白名单方法：

| method                     | 参数                            | 说明                                             |
| -------------------------- | ------------------------------- | ------------------------------------------------ |
| `plugin.list`              | —                               | 完整管理 DTO 列表、磁盘校验 issues、重启待办标记 |
| `plugin.detail`            | `{ pluginId }`                  | 单个插件详情（含 `origin`）                      |
| `plugin.install.directory` | —                               | 主进程目录选择后安装，取消返回 `changed:false`   |
| `plugin.install.remote`    | `{ operationId, url, sha256? }` | 远程安装；无发布摘要时拒绝                       |
| `plugin.remote.inspect`    | `{ url, operationId? }`         | 远程预览；下载 + 校验 + 临时解压，不安装         |
| `plugin.download.cancel`   | `{ operationId }`               | 取消进行中的下载                                 |
| `plugin.update.check`      | `{ pluginId? }`                 | 检查单个或全部远程插件的更新                     |
| `plugin.update.install`    | `{ operationId, pluginId }`     | 执行更新；失败自动回滚                           |
| `plugin.enable`            | `{ pluginId }`                  | 启用并等待生命周期完成                           |
| `plugin.disable`           | `{ pluginId }`                  | 持久禁用意图，运行中的实例等重启才停止           |
| `plugin.uninstall`         | `{ pluginId }`                  | 卸载并保留用户数据                               |
| `plugin.restart`           | —                               | 仅重启插件服务，内核与主进程不动                 |

所有参数在 `host/ipc/validate.ts` 运行时校验（URL 仅 HTTPS 且 ≤ 2048 字符、`operationId` 为 1..64 安全字符、`pluginId` 为合法格式）。错误响应新增可选 `errorCode`，前端 preload 将其挂到 `Error.code`；`message` 保持人类可读。管理操作在 `LocalPluginManager` 内串行执行，防止重复安装、并发启停和状态覆盖。

管理 UI 是宿主常驻的 `PluginManager.svelte`，从顶栏 Plugins 进入。它不依赖 `plugin-inspector`，因此检查器被禁用时仍可恢复。列表、详情、加载、空态、错误和 issues 均由该组件处理；DTO 在 renderer 侧由 `parsePluginList` / `parsePluginOperation` / `parsePluginInspection` / `parsePluginUpdateCheck` / `parseDownloadProgress` 再次校验。

交互约定：

- **禁用不需要二次确认**，点击即写意图；只有卸载保留确认框（会删除安装目录）。
- 当列表或操作结果显示 `restartRequired` 时，顶部出现重启提示与 “Restart plugins” 按钮，调用 `plugin.restart`；提示里的 “pending changes” 可点击，弹出对话框列出仍处于运行态但已写入禁用意图的插件（名称、id、当前状态），确认后再重启。
- **远程安装**：工具栏 “Install from URL…”，输入 → Inspect → 展示来源 URL、id / name / version、发布时间、更新说明、权限声明、依赖与 SHA-256（并标注是否来自发布元数据）→ Confirm install；下载中显示进度条与 Cancel，结束后展示结果或错误码。
- **更新**：工具栏 “Check updates”，列表展示 current → latest、发布时间与 notes 摘要；每条 “Update” 打开确认弹窗（版本 / 来源 / 摘要 / 权限），确认后才执行，**绝不静默安装**。
- 错误统一映射：`Error.code` → 可读文案；`E_DIGEST_MISSING` 明确提示“发布方未提供摘要，已阻止安装”。

---

## 12. 安全边界

- renderer 无 Node / 文件系统能力，只能调用白名单 IPC；管理操作全部在主进程执行。
- 路径 containment 同时做词法检查和 `realpath` 检查；安装拒绝符号链接、特殊文件、绝对/`../` entry 与受管目录互含。
- 复制使用临时目录 + 排他创建 + 同卷原子 rename；卸载只删除 canonical 受管目录。
- 安装默认禁用，避免安装即执行代码。
- 依赖一致性：禁用会级联关闭已加载的依赖者；卸载拒绝仍被已安装插件硬依赖；启用会同步拉起已安装的依赖闭包，只有依赖确实缺失才报错。
- 权限系统只约束内核能力（`requires` → `PermissionManager` → `CapabilityGuard`），**不是操作系统沙箱**。`in-process` 与 `worker` 插件仍可导入 Node API；worker 只提供故障隔离，不是安全沙箱。
- 远程安装额外约束：仅 HTTPS + 主机 allowlist；重定向不得降级或跳出 allowlist，最多 5 次；只接受 ZIP；摘要只来自发布元数据或调用方显式传入；ZIP 解包防 Zip Slip / 绝对路径 / `..` / 反斜杠 / 符号链接 / 特殊文件 / 压缩炸弹，并在解压后再次做词法 + `realpath` containment。
- 当前没有签名校验、来源信誉、漏洞扫描或自动依赖安装。SHA-256 只证明完整性，不证明发布者身份；仅应安装可信插件。

---

## 13. 已知限制

| #   | 限制                                                                     | 影响 / 后续                                      |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| M1  | 远程安装仅支持 ZIP                                                       | 无 tar.gz、无 registry、无构建、无 npm 依赖安装  |
| M2  | 无签名与恶意代码沙箱                                                     | 用户须自行确认来源可信                           |
| M3  | 插件 manifest 在安装后若被外部修改，列表会显示校验 issue，但不会自动修复 | 重新安装或手工修复                               |
| M4  | 卸载保留 `config/`、`data/`，不会自动清理                                | 需要删除用户数据时必须手工处理 `plugin-data`     |
| M5  | 重启只重载插件，不重置主进程或内核内存                                   | 旧模块实例等 GC 回收；这不是进程级重置           |
| M6  | 多窗口管理页依赖各自主动刷新                                             | 未新增 catalog 事件；当前状态事件只覆盖启停      |
| R1  | GitHub 发布必须恰好包含 1 个 `.zip` 资产                                 | 多资产 / 无资产 / 仅 tar.gz 的发布无法自动解析   |
| R2  | 摘要依赖 GitHub API 的 `digest` 或 `.sha256` sidecar                     | 发布方两者都不提供时安装被阻止（设计如此）       |
| R3  | 直链 URL 无法取得可信摘要                                                | 需要用户在调用参数中显式提供 `sha256`            |
| R4  | 更新检查按 provenance 的来源逐个请求，无 token 与缓存                    | GitHub 未认证请求有速率限制                      |
| R5  | 更新只在主进程串行执行，长下载会阻塞同队列的列表 / 详情请求              | 进度事件让 UI 仍可显示状态，但其他管理操作需等待 |
| R6  | 无自动回滚重试、无灰度与降级通道                                         | 回滚失败时需人工检查目录（`E_ROLLBACK_FAILED`）  |
