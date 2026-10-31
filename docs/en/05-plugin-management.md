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
| Explicit grants      | `<userData>/plugin-grants.json` (capabilities approved for user plugins)           |
| Plugin config / data | Plugin `config/` and `data/`, moved to `<userData>/plugin-data/<id>/` on uninstall |
| Remote provenance    | `<userData>/plugin-provenance.json` (URL + publisher digest + install time)        |
| Remote package cache | `<userData>/plugin-packages/<sha256(url)>.zip` (10-minute TTL)                     |
| Allowed IPC methods  | `src/shared/ipc-contract.ts`                                                       |

Disabled intent is separate from runtime state: an enabled plugin that fails to start remains `enabled: true` with runtime state `Failed`, so the user can retry.

Electron layout:

```text
<userData>/
├── plugins/<plugin-id>/          # writable user install root
├── plugin-manager.json           # { version: 1, disabled: string[] }
├── plugin-grants.json            # { version: 1, entries: { <id>: capability[] } }
├── plugin-provenance.json        # { version: 1, entries: { <id>: { kind, url, sha256, … } } }
├── plugin-packages/<hash>.zip    # remote download cache (reused for 10 minutes)
└── plugin-data/<plugin-id>/      # preserved config/ and data/
```

Built-ins come from `builtinPluginsRoot()`; in a packaged app this is the read-only sibling `resources/plugins-dist` (6 built-in samples only). External plugins (such as `theme-switcher`) build into `plugins-external-dist` and install from a GitHub release into `<userData>/plugins`. Built-ins cannot be uninstalled. `<userData>` is resolved with `app.getPath('userData')`.

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

## 5. Remote installation

Remote installation is split into **inspect → explicit confirmation**, so the renderer only supplies a URL; download, extraction and verification all happen in the main process.

### Sources and digests

| Input                                                           | Resolution                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `github.com/<owner>/<repo>/releases/download/<tag>/<asset>.zip` | direct asset; release metadata is still fetched when available to obtain a digest               |
| `github.com/<owner>/<repo>/releases/tag/<tag>`                  | GitHub API `releases/tags/<tag>`; must contain exactly one `.zip` asset                         |
| `github.com/<owner>/<repo>` / `.../releases/latest`             | GitHub API `releases/latest`; same single-`.zip` requirement                                    |
| Any other `https://` link whose path ends in `.zip`             | direct download; version inferred from the filename, **no trusted digest** (`sha256` undefined) |

A digest comes only from the release asset's `digest` field (`sha256:<hex>`) or a sibling `<asset>.sha256` sidecar. When neither exists the inspection returns `undefined`; the digest computed from the download is never presented as a publisher digest.

### inspect (`plugin.remote.inspect`)

1. Resolve release metadata → `downloadUrl`, version, publish time, notes, publisher digest and size.
2. Download into `<userData>/plugin-packages/<sha256(downloadUrl)>.zip`; a cache entry younger than 10 minutes is reused. HTTPS only, host must be one of `github.com` / `api.github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com`; redirects are followed manually, protocol downgrades and jumps outside the allowlist are rejected, at most 5 hops; 50 MiB cap and 30 s timeout by default.
3. Verify the digest when metadata provides one.
4. Extract into a temporary `<userRoot>/.inspect-*` directory: hand-written EOCD + central-directory parser, store/deflate support, CRC32 verification, no zip64/encryption/multi-volume/unknown compression; absolute paths, `..`, backslashes, drive letters, symlinks and special files are rejected; 2000 files / 100 MiB / 25 MiB per file by default.
5. Read and validate `plugin.json`, entry existence, kernel compatibility and hard-dependency satisfiability (reusing `DependencyResolver`).
6. Return `PluginRemoteInspectionDto`; the temporary directory is always removed. **No plugin directory, disabled intent or plugin code is touched.**

### install (`plugin.install.remote`)

1. A trusted digest is mandatory: `release.sha256` or an explicit caller `sha256`; otherwise `E_DIGEST_MISSING` without downloading.
2. An already installed id → `E_DUPLICATE_ID` (updates use their own method).
3. Download or reuse the cache, then verify the digest (`E_DIGEST_MISMATCH` on failure).
4. Extract into `<userRoot>/.install-*` → re-check the manifest → atomically rename to `<userRoot>/<id>` → persist disabled intent.
5. Write provenance on success; any failure removes the committed directory, reverts the disabled intent and deletes this cache entry, so no half-install survives.

### Progress and cancellation

- `operationId` is generated by the renderer (1..64 safe characters). Inspect/install/update publish `plugin.download.progress` with `{ operationId, phase, receivedBytes?, totalBytes? }`; phase is one of `downloading`, `verifying`, `extracting`, `installing`.
- `plugin.download.cancel` aborts the matching `AbortController`; `.part-*` files are cleaned up and a repeated cancel is idempotent (`cancelled: false`).

### Remote error codes

| code                  | Meaning                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `E_SOURCE_INVALID`    | non-HTTPS, host outside the allowlist, illegal redirect, or unsupported URL shape       |
| `E_DOWNLOAD`          | non-2xx status, network failure, or a response without a body                           |
| `E_DOWNLOAD_TIMEOUT`  | total timeout exceeded (30 s by default)                                                |
| `E_CANCELLED`         | canceller or external signal aborted the operation                                      |
| `E_PACKAGE_TOO_LARGE` | declared/streamed size cap, file count or extracted byte cap exceeded                   |
| `E_PACKAGE_INVALID`   | not a ZIP, zip64, encrypted, multi-volume, unknown compression, CRC or structure damage |
| `E_PATH_ESCAPE`       | ZIP entry with an absolute path, `..`, backslash, drive letter or NUL                   |
| `E_UNSAFE_TREE`       | ZIP entry is a symbolic link or special file                                            |
| `E_DIGEST_MISSING`    | publisher provided no digest; installation is blocked                                   |
| `E_DIGEST_INVALID`    | digest is not 64 hexadecimal characters                                                 |
| `E_DIGEST_MISMATCH`   | downloaded entity does not match the trusted digest                                     |

---

## 6. Updates and rollback

`plugin.update.check` (optional `pluginId`) resolves the latest release from the recorded provenance:

- Only user plugins with provenance are compared. Without provenance a bulk check skips them; a targeted check returns `E_PROVENANCE_MISSING`.
- Comparison reuses kernel semver (`parseVersion` / `compareVersions`); unparsable versions yield `hasUpdate: false`.
- Bulk checks skip one unreachable source; a targeted check reports it.

`plugin.update.install` (`{ operationId, pluginId }`) steps:

1. Validate provenance and source; if the latest version is not newer → `changed: false`, nothing is written.
2. Resolve/download/verify/extract/validate the manifest; a missing release digest → `E_DIGEST_MISSING`.
3. Re-run `DependencyResolver` with the new manifest replacing the old candidate; dropped → `E_DEPENDENCY` and no disk change.
4. Backup: atomically rename `<userRoot>/<id>` to `<userRoot>/.backup-<id>-<ts>` (same volume).
5. Install the new version (staging → rename) and merge `config/` and `data/` from the backup, **never overwriting files the user already has**.
6. Keep the existing `enabled` intent; when the plugin was running, call `Kernel.restartPlugins(state.ids())` and require `Active` / `Degraded`.
7. Any failure, or the new version failing to start: delete the new directory, rename the backup back, run `restartPlugins` again to restore runtime, keep the old provenance, and return `E_UPDATE_FAILED`. If rollback itself fails → `E_ROLLBACK_FAILED` with both errors in the message.
8. On success: delete the backup, update provenance, return `restartRequired` (`false` for plugins that were not running).

Concurrency: every management operation is serialized; one `operationId` cannot be registered twice, and one plugin cannot run concurrent update/install (the `pendingByPlugin` guard).

---

## 7. Provenance

`<userData>/plugin-provenance.json` records **remote origins only**:

```json
{
  "version": 1,
  "entries": {
    "com.acme.hello": {
      "kind": "remote",
      "url": "https://github.com/acme/hello",
      "sha256": "<publisher digest>",
      "publishedAt": "2026-01-01T00:00:00Z",
      "installedAt": "2026-02-01T00:00:00Z"
    }
  }
}
```

- Atomic writes; corrupt files or invalid fields → `E_STATE_INVALID`; a failed write rolls back memory and returns `E_STATE_WRITE`.
- `PluginDetailDto.origin` is projected from it (`kind: 'remote'` + URL + digest + publish time); the renderer shows only the URL and the first 12 digest characters, never paths.
- Uninstall removes the entry so a deleted plugin cannot keep advertising updates.
- Update checks and update installs trust only the recorded URL, never a renderer-supplied update source.

---

## 8. Integrity vs authenticity

- **SHA-256 only proves integrity**: the download matches the digest the publisher provided. It does not prove who published it, and it cannot stop a publisher from shipping a malicious package.
- There is **no** signature verification, source reputation, vulnerability scanning or certificate pinning; a compromised GitHub account is a compromised source.
- Capability declarations (`requires`) are not a sandbox: remote plugins go through the same `requires → PermissionManager → CapabilityGuard` path and gain no extra Electron main-process capability; in-process plugins can still import Node APIs.
- The preview and update dialogs therefore show source URL, version, publish time, declared capabilities and digest together, state these limits explicitly, and disable the install button when the digest is missing.

---

## 9. Capability grants (sandboxed plugins)

`source === 'builtin'` plugins are `trusted` and receive their declared capabilities by policy. User-installed plugins are `sandboxed`: only `log.sink` is granted by default, and everything else (including `ui.theme` / `ui.panel` / `ui.route`) is denied. Contributing to a UI extension point then throws `CapabilityDeniedError` and the plugin starts as `Failed`.

Explicit grant flow:

1. The detail DTO exposes the current `permissions` `{ granted, denied }`; persisted grants override policy denials.
2. `plugin.permission.grant` (`{ pluginId, capabilities }`) accepts only capabilities declared in the manifest `requires`; undeclared → `E_CAPABILITY_INVALID`; built-ins → `E_BUILTIN_PROTECTED`.
3. Grants persist atomically to `<userData>/plugin-grants.json`. On startup the kernel applies them after the trust-policy decision, and only for declared capabilities — a grant file cannot escalate a plugin beyond its own manifest.
4. Grants apply on the next start: a freshly installed plugin stays `Disabled`, so grant and then Enable; a `Failed` plugin is unloaded and restarted by Enable.
5. Uninstall removes the plugin's grants, so a reinstall asks again.

---

## 10. Enable and disable

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

## 11. Uninstall

1. Only `source === 'user'` is accepted; built-ins return `E_BUILTIN_PROTECTED`.
2. Any installed hard dependent, enabled or not, blocks with `E_DEPENDENTS`.
3. Persist disabled intent and stop a running plugin.
4. Copy `config/` and `data/` to `<userData>/plugin-data/<id>/` without overwriting existing preserved files.
5. Verify the target `realpath` is still inside the managed user root, then delete that exact directory.
6. Disabled intent and preserved data remain for a future reinstall.

Deletion never touches built-ins, the state file or `plugin-data/`, and renderer-supplied paths are never used.

---

## 12. IPC and UI

Thirteen exact allowlisted methods cover plugin management: `plugin.list`, `plugin.detail`, `plugin.install.directory`, `plugin.install.remote`, `plugin.remote.inspect`, `plugin.download.cancel`, `plugin.update.check`, `plugin.update.install`, `plugin.enable`, `plugin.permission.grant`, `plugin.disable`, `plugin.uninstall`, `plugin.restart`.

- `plugin.list` / `plugin.install.directory` / `plugin.restart` accept no arguments.
- Detail and lifecycle methods accept `{ pluginId }` and validate its format at runtime.
- Remote methods validate HTTPS URLs (≤ 2048 characters), `operationId` (1..64 safe characters) and digests before any network or filesystem work.
- Install uses the main-process chooser; cancellation returns `changed: false`.
- Disable persists intent only; a live plugin stops on the next plugin-service restart.
- Updates and remote installs never happen silently: the renderer must request them after showing the preview.
- Errors carry an optional stable `errorCode`; preload exposes it as `Error.code`.
- Mutations are serialized inside `LocalPluginManager` to prevent duplicate installs, concurrent toggles and stale state writes.

`PluginManager.svelte` is a host-owned view opened from the top bar. It does not depend on `plugin-inspector`, so the inspector can be disabled and still recovered. The component covers list, detail, loading, empty and error states. Renderer-side DTO guards (`parsePluginList`, `parsePluginOperation`, `parsePluginInspection`, `parsePluginUpdateCheck`, `parseDownloadProgress`) validate every payload again.

Disable has **no confirmation** — one click persists intent. Only uninstall asks for confirmation, because it deletes the installed directory. When `restartRequired` is set, a banner with a "Restart plugins" button appears; it calls `plugin.restart`. The "pending changes" text in that banner is clickable and opens a dialog listing every plugin that is disabled on disk but still running (name, id, current state), so the restart can be reviewed before it happens.

Remote flow:

- **Install from URL…**: enter a URL → Inspect → the preview shows the source URL, id / name / version, publish time, release notes, declared capabilities, dependencies and SHA-256 (labelled as release metadata) → Confirm install. A progress bar with a Cancel button is shown while downloading; the result or error code is reported afterwards.
- **Check updates**: the list shows current → latest, publish time and a notes summary. Each "Update" opens a confirmation dialog (version / source / digest / capabilities) and only that confirmation executes the update — never a silent install.
- **Capability grants**: the detail page lists each declared capability as granted / denied. When anything is denied, "Grant denied capabilities" calls `plugin.permission.grant` and notes that the grant applies on the next start. Installation still defaults to `Disabled`, so granting and enabling are two explicit steps.
- Error mapping: `Error.code` → readable text; `E_DIGEST_MISSING` explicitly says the publisher provided no digest and the install was blocked.

---

## 13. Security boundaries

- The renderer has no Node or filesystem access and can only use allowlisted IPC; all file operations happen in the main process.
- Path containment uses both lexical checks and `realpath`; installation rejects symlinks, special files, absolute/`../` entries and overlapping managed roots.
- Copies use staging, exclusive creation and same-volume atomic rename. Uninstall only deletes a canonical managed directory.
- Installs default to disabled, so installation never executes code.
- Dependency consistency: disable cascades to loaded dependents; uninstall refuses while an installed plugin hard-depends on the target; enable pulls in the installed dependency closure and only fails when a dependency is truly absent.
- The permission system constrains kernel capabilities only. It is **not an OS sandbox**: both in-process and worker plugins can import Node APIs. Worker isolation is fault isolation, not a security boundary.
- Remote installs add: HTTPS + host allowlist only; redirects may not downgrade the protocol or leave the allowlist, at most 5 hops; ZIP only; digests come only from release metadata or an explicit caller value; extraction rejects Zip Slip, absolute paths, `..`, backslashes, symlinks, special files and compression bombs, then re-checks lexical + `realpath` containment after extraction.
- There is no signature verification, reputation, vulnerability scanning or automatic dependency installation. SHA-256 proves integrity only, not publisher identity; install only trusted plugins.

---

## 14. Known limitations

| #   | Limitation                                                                                     | Impact                                                                    |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| M1  | Remote installs support ZIP only                                                               | No tar.gz, registry, build or dependency installation                     |
| M2  | No signatures or malicious-code sandbox                                                        | Users must trust the source                                               |
| M3  | External manifest edits after install surface as validation issues                             | Reinstall or repair manually                                              |
| M4  | `config/` and `data/` are intentionally preserved                                              | Manual cleanup is required to erase user data                             |
| M5  | Restart reloads plugins, not kernel or host memory                                             | Old module instances await GC; this is not a process-level reset          |
| M6  | Multiple windows refresh independently                                                         | No catalog event yet; state events only cover start/stop                  |
| R1  | GitHub releases must contain exactly one `.zip` asset                                          | Multi-asset, asset-less or tar.gz-only releases cannot resolve            |
| R2  | Digests depend on the GitHub API `digest` or a `.sha256` sidecar                               | A publisher offering neither blocks installation by design                |
| R3  | Direct links have no trusted digest                                                            | The caller must supply `sha256` explicitly                                |
| R4  | Update checks request each provenance source, with no token/cache                              | Unauthenticated GitHub requests are rate-limited                          |
| R5  | Updates serialize in the main process, so a long download blocks queue neighbors (list/detail) | Progress events keep the UI informed, but other management calls wait     |
| R6  | No automatic rollback retry, canary or downgrade path                                          | A failed rollback needs manual directory inspection (`E_ROLLBACK_FAILED`) |
