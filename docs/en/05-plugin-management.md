# 05 · Local plugin management

> For host maintainers and users troubleshooting install or lifecycle issues. Plugin APIs live in [`02-plugin-api.md`](02-plugin-api.md); the IPC allowlist lives in [`03-frontend-ipc.md`](03-frontend-ipc.md).
>
> 中文：[`../05-plugin-management.md`](../05-plugin-management.md)

---

## 1. Sources of truth

| Fact                 | Authority                                                                          |
| -------------------- | ---------------------------------------------------------------------------------- |
| Installed catalog    | `plugin.json` scans under `builtinRoot` and `userRoot`                             |
| Runtime state        | `Kernel.pluginRegistry` + `Kernel.lastStartResult`                                 |
| Disabled intent      | `<userData>/plugin-manager.json`                                                   |
| Plugin config / data | Plugin `config/` and `data/`, moved to `<userData>/plugin-data/<id>/` on uninstall |
| Allowed IPC methods  | `src/shared/ipc-contract.ts`                                                       |

Disabled intent is separate from runtime state: an enabled plugin that fails to start remains `enabled: true` with runtime state `Failed`, so the user can retry.

Electron layout:

```text
<userData>/
├── plugins/<plugin-id>/          # writable user install root
├── plugin-manager.json           # { version: 1, disabled: string[] }
└── plugin-data/<plugin-id>/      # preserved config/ and data/
```

Built-ins come from `builtinPluginsRoot()`; in a packaged app this is the read-only sibling `resources/plugins-dist`. Built-ins cannot be uninstalled. `<userData>` is resolved with `app.getPath('userData')`.

---

## 2. Manifest and package shape

Installation accepts only a pre-built plugin directory. It never runs npm, pnpm, package scripts or builds.

```text
<source>/
├── plugin.json
└── dist/index.js       # or another regular .js / .mjs file referenced by entry
```

The same runtime `validateManifest` used by discovery enforces:

| Field                           | Rule                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `id`                            | Required, `^[a-z0-9]+([._-][a-z0-9]+)*$`, at least 3 characters                       |
| `name`                          | Required, non-empty                                                                   |
| `version`                       | Required semver                                                                       |
| `entry`                         | Required relative `.js` / `.mjs` path; resolved path must stay inside the plugin root |
| `compatibility.minKernel`       | Required semver or range                                                              |
| `compatibility.contractVersion` | Required; major must match the kernel contract                                        |
| `dependencies`                  | Optional hard dependencies; missing or mismatched versions block installation         |
| `optionalDependencies`          | Optional soft dependencies; absence only yields `Degraded`                            |
| `requires`                      | Optional capability names, valid and unique                                           |
| `contributes`                   | Optional declared extension points with unique slot ids                               |
| `isolation`                     | Optional `in-process` / `worker`                                                      |

The entry must exist, be a regular file, and its `realpath` must remain inside the plugin root. Symbolic links are rejected.

---

## 3. States

| State                               | Meaning                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `Disabled`                          | Persisted disabled intent; excluded from dependency candidates on startup and enable |
| `Registered` … `Configured`         | Intermediate kernel lifecycle states                                                 |
| `Active`                            | Started                                                                              |
| `Degraded`                          | Started with a missing soft dependency or non-fatal phase failure                    |
| `Failed`                            | Load, authorization or start failed; `enabled` may still be true and retryable       |
| `Dropped`                           | Enable-time dependency resolution failed                                             |
| `Stopped` / `Unloaded` / `Disposed` | Stopped or released; still installed and enabled plugins display as `Stopped`        |

`Disabled` is a management state, not a kernel `PluginStateT`. Disabling only persists intent: a plugin that is still running keeps running, the DTO's `restartRequired` becomes `true`, and the UI shows a restart entry. `plugin.restart` is what actually stops it, after which it stays disabled.

---

## 4. Installation

1. The renderer sends `plugin.install.directory` with no path.
2. The main process opens the native directory chooser. User selection is the source authorization; the renderer cannot submit arbitrary paths.
3. Validate that the source is a real directory and neither contains nor is contained by a managed root.
4. Validate manifest, entry, compatibility, duplicate id, hard dependencies and soft dependencies.
5. Reject any id already supplied by a built-in plugin.
6. Copy to `<userRoot>/.<id>.install-*` on the same volume:
   - never follow symbolic links;
   - create files exclusively so nothing is overwritten;
   - cap at 2000 files / 100 MiB.
7. Re-read and re-check manifest, version and entry in staging.
8. Atomically rename staging to `<userRoot>/<id>`.
9. Persist disabled intent; the new plugin is `Disabled` and its code is **not executed**.
10. On any failure remove staging; if commit already happened, remove the target too.

Installation does not imply activation. The user must press Enable, which runs the full lifecycle, permission grant and dependency resolution.

---

## 5. Enable and disable

Enable writes `disabled: false` and **also enables the installed hard-dependency closure** before calling `Kernel.enablePlugin(id, disabledIds)`. A prerequisite that is merely disabled is not a broken install, so no `missing hard dependency` error is raised for it; only a dependency that is genuinely absent reaches the resolver and fails with `E_MISSING_DEPENDENCY`. The kernel then rediscovers the catalog, starts the target and required hard dependencies in topological order, skips already active/degraded dependencies, and unloads a previously failed target before retrying. Failure keeps `enabled: true` with `Failed`; kernel rollback and forced reclamation still run.

Disable **cascades**: it disables the target plus the loaded dependent closure (transitive), so a prerequisite and its dependents never end up in a dangling state and `disable dependents first` no longer exists. It only persists intent and does not stop anything in place — an in-place Stop would leave module caches, timers and module-level singletons in an indeterminate state, so a restart is the clean boundary:

- If the target or any cascaded dependent is still running, the result carries `restartRequired: true` and the UI shows "Restart the plugin service to apply pending changes." plus a restart button.
- Repeating disable returns `changed: false` and keeps `restartRequired: true` while the runtime is still out of sync.
- If a state-file write fails, intents written by this call are rolled back.

### Plugin-service restart

`plugin.restart` → `Kernel.restartPlugins(state.ids())`:

1. Stop every loaded plugin in reverse `loadOrder` (Stop → Unload → Dispose, retracting contributions, permissions, health checks and containers). A failing stop hook is logged, not fatal.
2. Rediscover, resolve and start with the current disabled intent, loading with a cache-busting query so module-level state does not survive.
3. **Do not touch** the kernel root container, event bus, command dispatcher, log/trace sinks, Electron main process or window; `kernel.isStarted()` stays `true`.
4. `plugin.state-changed` fires for every plugin during the restart; the renderer coalesces reloads for 60 ms.

So "restart" never recreates the main process or the window — only plugin code and extension contributions are reloaded.

---

## 6. Uninstall

1. Only `source === 'user'` is accepted; built-ins return `E_BUILTIN_PROTECTED`.
2. Any installed hard dependent, enabled or not, blocks with `E_DEPENDENTS`.
3. Persist disabled intent and stop a running plugin.
4. Copy `config/` and `data/` to `<userData>/plugin-data/<id>/` without overwriting existing preserved files.
5. Verify the target `realpath` is still inside the managed user root, then delete that exact directory.
6. Disabled intent and preserved data remain for a future reinstall.

Deletion never touches built-ins, the state file or `plugin-data/`, and renderer-supplied paths are never used.

---

## 7. IPC and UI

Seven exact allowlisted methods were added: `plugin.list`, `plugin.detail`, `plugin.install.directory`, `plugin.enable`, `plugin.disable`, `plugin.uninstall`, `plugin.restart`.

- `plugin.list` / `plugin.install.directory` / `plugin.restart` accept no arguments.
- Detail and lifecycle methods accept `{ pluginId }` and validate its format at runtime.
- Install uses the main-process chooser; cancellation returns `changed: false`.
- Disable persists intent only; a live plugin stops on the next plugin-service restart.
- Errors carry an optional stable `errorCode`; preload exposes it as `Error.code`.
- Mutations are serialized inside `LocalPluginManager` to prevent duplicate installs, concurrent toggles and stale state writes.

`PluginManager.svelte` is a host-owned view opened from the top bar. It does not depend on `plugin-inspector`, so the inspector can be disabled and still recovered. The component covers list, detail, loading, empty and error states. Renderer-side DTO guards (`parsePluginList`, `parsePluginOperation`) validate every payload again.

Disable has **no confirmation** — one click persists intent. Only uninstall asks for confirmation, because it deletes the installed directory. When `restartRequired` is set, a banner with a "Restart plugins" button appears; it calls `plugin.restart`. The "pending changes" text in that banner is clickable and opens a dialog listing every plugin that is disabled on disk but still running (name, id, current state), so the restart can be reviewed before it happens.

---

## 8. Security boundaries

- The renderer has no Node or filesystem access and can only use allowlisted IPC; all file operations happen in the main process.
- Path containment uses both lexical checks and `realpath`; installation rejects symlinks, special files, absolute/`../` entries and overlapping managed roots.
- Copies use staging, exclusive creation and same-volume atomic rename. Uninstall only deletes a canonical managed directory.
- Installs default to disabled, so installation never executes code.
- Dependency consistency: disable cascades to loaded dependents; uninstall refuses while an installed plugin hard-depends on the target; enable pulls in the installed dependency closure and only fails when a dependency is truly absent.
- The permission system constrains kernel capabilities only. It is **not an OS sandbox**: both in-process and worker plugins can import Node APIs. Worker isolation is fault isolation, not a security boundary.
- There is no signature verification, reputation or ZIP unpacking. Install only trusted plugins.

---

## 9. Known limitations

| #   | Limitation                                                         | Impact                                                           |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| M1  | Only pre-built local directories                                   | No ZIP, build or dependency installation                         |
| M2  | No signatures or malicious-code sandbox                            | Users must trust the source                                      |
| M3  | External manifest edits after install surface as validation issues | Reinstall or repair manually                                     |
| M4  | `config/` and `data/` are intentionally preserved                  | Manual cleanup is required to erase user data                    |
| M5  | Restart reloads plugins, not kernel or host memory                 | Old module instances await GC; this is not a process-level reset |
| M6  | Multiple windows refresh independently                             | No catalog event yet; state events only cover start/stop         |
