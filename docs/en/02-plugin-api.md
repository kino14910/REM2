# 02 · Plugin Development Guide

> Public contract reference for plugin authors. **The only legal import source is `rem2-kernel`**; deep-linking into `src/kernel/**` internals is forbidden (enforced by `tests/contract/plugin-contract.test.ts` R4).
>
> Companions: [`01-architecture-overview.md`](01-architecture-overview.md) (architecture and boundaries), [`04-development-guide.md`](04-development-guide.md) (build, validation, troubleshooting).
>
> 中文版：[`../02-plugin-api.md`](../02-plugin-api.md)

---

## 1. A minimal plugin

```ts
// plugins/my-plugin/src/index.ts
import { definePlugin } from 'rem2-kernel'
import type { PluginContext } from 'rem2-kernel'

export default definePlugin(
  { id: 'com.example.my-plugin', name: 'My Plugin', version: '0.1.0' },
  (ctx: PluginContext) => ({
    async onStart(): Promise<void> {
      ctx.log.info('plugin started')
    },
  }),
)
```

Four files, always:

```
plugins/my-plugin/
├── package.json        # @rem2/plugin-my-plugin, private, exports point at dist
├── tsconfig.json       # standalone config (does not extend the root tsconfig)
├── plugin.json         # manifest: entry points at the **build artifact**
└── src/index.ts
```

---

## 2. The single shape: `definePlugin(manifest, setup)`

A factory is the only accepted shape — class exports, pre-instantiated singletons and named exports are all rejected. The loader performs one assertion and does no shape guessing.

| Parameter  | Type                          | Notes                                                                                                                                                        |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest` | `PluginManifestInit`          | Inline manifest. **`plugin.json` is authoritative**; the inline value is only used for drift detection, and a mismatched `id` throws `ManifestMismatchError` |
| `setup`    | `(ctx) => PluginFactoryHooks` | Hook factory, called once after `import()`                                                                                                                   |

Constraints:

- `manifest.id` must be a non-empty string, otherwise `definePlugin` throws `ManifestError`.
- `setup` must be a function, otherwise `TypeError`.
- The factory object is `Object.freeze`d; the inline manifest is attached as a read-only property.

---

## 3. Manifest (`plugin.json`)

| Field                                           | Type                         | Required | Notes                                                                                                |
| ----------------------------------------------- | ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`                                            | `string`                     | ✅       | `^[a-z0-9]+([._-][a-z0-9]+)*$`, reverse-DNS recommended                                              |
| `name`                                          | `string`                     | ✅       | display name                                                                                         |
| `version`                                       | `string`                     | ✅       | semver                                                                                               |
| `entry`                                         | `string`                     | ✅       | **build artifact relative path, always `dist/index.js`**, only `.js` / `.mjs`                        |
| `compatibility`                                 | `object`                     | ✅       | `{ minKernel, contractVersion }`; `maxKernel` optional                                               |
| `dependencies`                                  | `Record<string,string>`      |          | hard dependencies: missing or unsatisfied → this plugin `Failed`                                     |
| `optionalDependencies`                          | `Record<string,string>`      |          | soft dependencies: missing → `Degraded`, remaining features keep working                             |
| `contributes`                                   | `{point, id, capability?}[]` |          | **static declaration** of which extension points are contributed (aligned with runtime `contribute`) |
| `requires`                                      | `string[]`                   |          | capability declarations, input to `PermissionManager.check`, e.g. `['command.provide']`              |
| `isolation`                                     | `'in-process' \| 'worker'`   |          | defaults to `in-process`                                                                             |
| `configSchema`                                  | `object`                     |          | not interpreted by the kernel; passed through to the plugin                                          |
| `author` `description` `icon` `tags` `homepage` | —                            |          | metadata, unused by the kernel                                                                       |

```jsonc
// plugins/my-plugin/plugin.json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "optionalDependencies": { "com.rem2.logger-console": "^1.0.0" },
  "contributes": [{ "point": "command.provide", "id": "greet" }],
  "requires": ["command.provide"],
  "compatibility": { "minKernel": "^1.0.0", "contractVersion": "1" },
}
```

`manifest-validator` validates the manifest during **discovery**; local installation and remote ZIP packages reuse the same validator, and `manifest.schema.json` is the JSON Schema form of the same rules. Changing validation rules requires changing both.

Install / enable / disable / uninstall, user plugin roots, state and path safety are documented in [`05-plugin-management.md`](05-plugin-management.md). Local installation accepts only pre-built directories and remote installation only ZIP packages with a trusted digest; both default to disabled and never execute plugin code.

### 3.1 Why `entry` must be `dist/index.js`

The kernel loads plugins with a runtime `import()`, which goes through no bundler, so the file on disk must be natively resolvable by Node. Node does not map `./x.js` onto `x.ts` (`ERR_MODULE_NOT_FOUND`).

Therefore `entry` is identical in dev and prod: no second shape, no environment switch. The cost is that editing source requires `pnpm build:plugins`.

---

## 4. Lifecycle hooks

Every `PluginFactoryHooks` hook (all optional):

| Hook                  | Phase      | Semantics                                                                                                      |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `onDiscover(ctx)`     | Discover   | read-only probing. **No side effects** (no write IO, no registration)                                          |
| `onLoad(ctx)`         | Load       | module is instantiated; in-memory preparation only                                                             |
| `onConfigure(ctx)`    | Initialize | read config, register services, subscribe events (rollbackable on failure)                                     |
| `onStart(ctx)`        | Start      | start the runtime (open connections, timers, contribute extension points). Must finish within `startTimeoutMs` |
| `onStop(ctx, reason)` | Stop       | idempotent shutdown, release runtime resources                                                                 |
| `onUnload(ctx)`       | Unload     | unregister services and event subscriptions                                                                    |
| `onDispose(ctx)`      | Dispose    | final release; the instance must not be used afterwards                                                        |
| `onHealthCheck()`     | —          | returns `HealthStatus`; called periodically by the health service                                              |

`reason` values for `onStop`: `'user-disable' | 'reload' | 'dependency-failed' | 'health-degraded' | 'shutdown' | 'start-failed' | 'timeout'`.

**Failure semantics**:

- `Load` / `Initialize` / `Start` failures are **fatal** → reverse-rollback executed phases → plugin `Failed`.
- `Discover` failure or a missing soft dependency is **non-fatal** → `Degraded`, other plugins keep running. The health message names the missing entry: `missing optional dependency: <id>`.
- Once that soft dependency is enabled again, the kernel re-evaluates the plugin and returns it to `Active` without a plugin-service restart; `enablePlugin` is idempotent and may be called on a `Degraded` plugin to force the re-check.
- Only soft-dependency degradation is recorded for recovery; `Active`, `Failed` and unload clear it, so unrelated degraded plugins are never restarted by mistake.

---

## 5. `PluginContext`: what a plugin can reach

| Field         | Purpose                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pluginId`    | this plugin's id                                                                                                             |
| `manifest`    | normalized manifest                                                                                                          |
| `phase`       | current lifecycle phase (read-only)                                                                                          |
| `container`   | this plugin's DI child container (parent unreachable)                                                                        |
| `services`    | register / resolve services (resolution goes through `CapabilityGuard`)                                                      |
| `events`      | global event bus: `emit` / `on` / `once` / `request` / `respond`                                                             |
| `config`      | read-only config access: `get` / `getOrThrow` / `has` / `onDidChange`                                                        |
| `log`         | plugin-scoped logger: `trace` … `fatal`                                                                                      |
| `metrics`     | metrics API: `counter` / `gauge` / `histogram`                                                                               |
| `permissions` | granted permission set (read-only snapshot)                                                                                  |
| `extensions`  | **contribute extension points (see §6)**                                                                                     |
| `api`         | `export` / `unexport` / `useCapability`                                                                                      |
| `plugins`     | probe other plugins (runtime probing of soft dependencies)                                                                   |
| `resolvePath` | resolve inside the plugin rootDir; escaping throws `EntryEscapeError`                                                        |
| `dataPath`    | resolve inside the host-provided writable plugin data root (`pluginDataRoot/<pluginId>`); escaping throws `EntryEscapeError` |

---

## 6. Extension points: the only way to contribute a capability

There is exactly one path: contribute into an extension slot. The most common form for plugins:

```ts
ctx.extensions.contribute('command.provide', {
  contributionId: 'hello',
  impl: async (args: unknown) => {
    const name = (args as { name?: string })?.name ?? 'rem2-kernel'
    return { ok: true, output: `Hello, ${name}!` }
  },
})
```

### 6.1 The 12 extension points

| id                  | Contract                 | Slot   | Conflict                           | capability         |
| ------------------- | ------------------------ | ------ | ---------------------------------- | ------------------ |
| `log.sink`          | `LogSink`                | multi  | —                                  | —                  |
| `metrics.sink`      | `MetricSink`             | multi  | —                                  | —                  |
| `trace.exporter`    | `TraceExporter`          | multi  | —                                  | —                  |
| `config.provider`   | `ConfigProvider`         | multi  | —                                  | `config.provide`   |
| `command.provide`   | `CommandHandler`         | multi  | same id → `ExtensionConflictError` | `command.provide`  |
| `health.check`      | `HealthCheckFn`          | multi  | —                                  | —                  |
| `ui.theme`          | `ThemeDefinition`        | multi  | same id → `reject-new`             | `ui.theme`         |
| `ui.panel`          | `PanelContribution`      | multi  | same id → `reject-new`             | `ui.panel`         |
| `ui.route`          | `RouteContribution`      | multi  | same path → `replace-old`          | `ui.route`         |
| `scheduler.replace` | `Scheduler`              | single | `replace-old`                      | `kernel.internals` |
| `resolver.replace`  | `DependencyResolverPort` | single | `replace-old`                      | `kernel.internals` |
| `loader.replace`    | `PluginLoaderPort`       | single | `replace-old`                      | `kernel.internals` |

Contract types are defined authoritatively in `src/kernel/contracts/` (`ui.ts` / `logging.ts` / `metrics.ts` / `tracing.ts` / `config.ts` / `health.ts`).

**Multi slots deduplicate by `contributionId`**: repeating a contributionId in the same multi slot throws `ExtensionConflictError` (the `conflict` policy is only meaningful for singleton slots — a singleton slot needs adjudication for "who stays", while a multi slot means "same id = same contribution, repeat = conflict").

### 6.2 Three hard rules

1. **An unknown point id throws `UnknownExtensionPointError`** — typos are never silently ignored.
2. **A point that declares a `capability` you were not granted throws `CapabilityDeniedError`.** Contribution itself is capability-gated, so `plugin.json` → `requires` must cover it.
3. **Reclaim is enforced by the kernel**: on unload, all your contributions are retracted by `pluginId`, even if you never call `retract`. Never make cleanup a plugin-side duty.

### 6.3 UI extension points are declarative descriptors

`ui.panel` / `ui.route` accept data only (id / title / icon / region / order / associated command); **plugins do not ship Svelte components** — the host renders the chrome. Reason: a plugin-side Svelte build chain, a CSP-safe dynamic import allowlist, and component-version coupling would all conflict with "minimal kernel".

### 6.4 What a worker plugin may contribute

Only `log.sink` / `metrics.sink` / `trace.exporter`, with structured-cloneable values (`isolation/worker-protocol.ts` → `WORKER_ALLOWED_EXTENSION_POINTS`). Contributing a UI extension point throws.

---

## 7. Services and tokens

```ts
import { defineToken } from 'rem2-kernel'

export interface Greeter {
  greet(name: string): string
}

export const GreeterToken = defineToken<Greeter>({
  id: 'plugin.hello.greeter',
  capability: 'command.provide', // optional: capability required to resolve this service
  describe: 'greeting service',
})
```

- `defineToken()` is a **pure function** returning a branded object; the token's identity is a `unique symbol` type brand — no constructor, no static factory.
- Service resolution goes through `CapabilityGuard`; unauthorized access throws `CapabilityDeniedError`.
- Services **do not leak** to the parent container by default: to share, call `ctx.api.export(token)`.
- A sibling plugin can only resolve a service after the owner `export`s it; the root container must be `shareable: true` for child containers to resolve its entries.

Kernel-provided tokens live in `KernelTokens` (16 in total): `EventBus` / `Config` / `ConfigService` / `Log` / `Metrics` / `Tracer` / `Health` / `Permissions` / `Plugins` / `Scheduler` / `Resolver` / `Discovery` / `Loader` / `CapabilityGuard` / `Extensions` / `UiThemeRegistry`.

---

## 8. Command chain: how the frontend calls you

Commands use the **contribute + dispatcher** pattern: the plugin contributes into the `command.provide` extension point, and the kernel `CommandDispatcher` is the only responder for `command.execute` (the host implementation is `null`). It looks up the slot by `contributionId === command` and returns the handler's value as-is.

```ts
import { Topics } from 'rem2-kernel'

// The only entry: contribute to the extension point. Do NOT
// bus.respond(Topics.CommandExecute) — the kernel dispatcher registers
// earlier in start(), so a plugin-side responder is shadowed by seq order.
ctx.extensions.contribute('command.provide', {
  contributionId: 'hello',
  impl: async (args: unknown) => {
    const name = (args as { name?: string })?.name ?? 'rem2-kernel'
    return { ok: true, output: `Hello, ${name}!` }
  },
})
```

The return shape is literally what the frontend sees: `{ok: true, output}` → show `output`; `{ok: false, error}` → show the error. An unknown command yields an explicit `{ok:false, error:'unknown command: …'}` from the dispatcher (never `NoResponderError`, never recursion).

Why not "plugins respond the topic directly": when a host responder shares the topic name with the request (`Topics.CommandExecute` _is_ `'command.execute'`), one mistaken forwarder makes the request hit itself → infinite recursion `RangeError` (a real incident). The dispatcher reads the extension slot and never requests the same topic, so recursion is structurally impossible; the single dispatch path also makes "which plugin provides which command" enumerable from the extension registry.

**Always use `Topics` constants, never hand-copied strings.** One more known failure mode: a plugin writes a colon topic (`'command:execute'`) while the kernel uses a dot (`'command.execute'`). The matcher treats both as segment separators, so it "happens to work" — coincidence, not a contract.

---

## 9. Build

```bash
pnpm build:plugins          # esbuild-bundle all plugins → plugins-dist/<id>/dist/index.js
```

- `plugins/*/package.json` are pnpm workspace members (`@rem2/plugin-<id>`, private).
- The plugin `tsconfig.json` is **standalone**, declaring only `paths: { "rem2-kernel": ["../../src/kernel/index.ts"] }`. The kernel's `NodeNext` + DOM-exclusion strategy does not suit plugins; extending the root config would drag tests and the frontend in.
- The packaged form is a self-contained ESM bundle (`target: node20`), identical in dev and prod.

---

## 10. Isolation modes

| Mode                   | Notes                                                     |
| ---------------------- | --------------------------------------------------------- |
| `in-process` (default) | same process and realm as the kernel, highest performance |
| `worker`               | separate Node worker thread, lifecycle driven over RPC    |

**Available inside a worker**: `log` / `config` (init snapshot + change pushes, read-only) / `events` (`emit` / `on` / `request`) / `metrics` / `permissions` (snapshot) / `resolvePath` / `dataPath`.
**Unavailable inside a worker** (calling throws): `services` / `api` / `plugins` / `container` / `events.respond`. Cross-plugin collaboration only via the event bus.

Worker isolation is **fault isolation** (contains crashes and infinite loops), **not a security sandbox** — worker code still has full Node capability. The security boundary is the kernel-side `CapabilityGuard` gating "which kernel facilities can be reached".

---

## 11. Error codes

All kernel errors extend `KernelError` and carry a stable `code`:

| Category             | Codes                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Manifest / loading   | `E_INVALID_MANIFEST` · `E_MANIFEST_MISMATCH` · `E_ENTRY_ESCAPE` · `E_LOAD_FAILED`                                              |
| Dependency           | `E_DUPLICATE_ID` · `E_MISSING_DEPENDENCY` · `E_VERSION_MISMATCH` · `E_CYCLE` · `E_INCOMPATIBLE`                                |
| Service / DI         | `E_NO_PROVIDER` · `E_CIRCULAR_DEPENDENCY` · `E_SCOPED_ACCESS`                                                                  |
| Security / extension | `E_CAPABILITY_DENIED` · `E_UNKNOWN_EXTENSION_POINT` · `E_EXTENSION_CONFLICT`                                                   |
| Runtime              | `E_TIMEOUT` · `E_LIFECYCLE` · `E_ILLEGAL_TRANSITION` · `E_NO_RESPONDER` · `E_NOT_WRITABLE` · `E_ALREADY_STARTED` · `E_GENERIC` |

Source of truth: `src/kernel/errors.ts`.

---

## 12. Self-check list

- [ ] `entry` points at `dist/index.js`, not `src/index.ts`
- [ ] imports only from `rem2-kernel` / `node:*` / relative paths
- [ ] topics come from `Topics` constants, not hand-copied strings
- [ ] capabilities are contributed through `ctx.extensions.contribute`, no other channel
- [ ] `plugin.json` → `contributes` matches the runtime `contribute` calls
- [ ] required capabilities are listed in `requires`
- [ ] tokens are created with `defineToken()`
- [ ] `pnpm cli validate plugins/<id>/plugin.json` passes
- [ ] `pnpm build:plugins` produces `plugins-dist/<id>/dist/index.js`
