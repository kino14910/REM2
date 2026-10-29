<a href="./README.zh-CN.md">简体中文</a>

# rem2-kernel — Minimal Kernel + Everything-as-Plugin

> An independent, from-scratch implementation of **Kernel + Everything-as-Plugin**.
>
> The kernel does only 7 things; everything else (logging, config, business logic, ops, UI) is a plugin.

![tests](https://img.shields.io/badge/tests-466%20passing-brightgreen)

![kernel deps](https://img.shields.io/badge/kernel%20deps-0-blue)

![typescript](https://img.shields.io/badge/TypeScript-strict-blue)

---

## What is this

A **plugin-first** runtime kernel. Unlike the common "host + extensions" design, here the

**kernel holds no business capability** — even the dependency resolver and the scheduler can

be replaced by plugins.

| Kernel responsibilities (only these 7) | NOT the kernel's job              |
| -------------------------------------- | --------------------------------- |
| Bootstrap                              | resolve business config           |
| Discovery                              | know any concrete plugin          |
| Load / Unload                          | ship built-in log/metric sinks    |
| Lifecycle orchestration                | implement any business capability |
| Dependency resolution                  | assume a dependency-graph shape   |
| Core abstractions / contracts          | contain business types            |
| Minimal shared facilities              | contain UI                        |

**Acceptance criterion**: adding any new capability must not require editing `src/kernel/**`.

---

## Quick start

This project ships in **two runtime shapes**: a terminal kernel (primary) and an optional

Electron desktop shell.

### 1. Terminal kernel (recommended first)

```bash
pnpm install

# Start the kernel (tsx runs TS directly, no build step)
pnpm dev

# Smoke test: exit immediately after startup
pnpm dev --exit-after-start

# Debug logging
pnpm dev --log-level debug
```

Expected output:

```
──── rem2-kernel started ────
loadOrder : com.rem2.config-json -> com.rem2.hello-command -> com.rem2.logger-console -> com.rem2.health-http -> com.rem2.notify-worker -> com.rem2.plugin-inspector -> com.rem2.theme-dark
started   : com.rem2.config-json, com.rem2.hello-command, com.rem2.logger-console, com.rem2.health-http, com.rem2.notify-worker, com.rem2.plugin-inspector, com.rem2.theme-dark
degraded  : (none)
failed    : (none)
health    : healthy
  - com.rem2.config-json [Active] healthy
  - com.rem2.health-http [Active] healthy
  - com.rem2.hello-command [Active] healthy
  - com.rem2.logger-console [Active] healthy
  - com.rem2.notify-worker [Active] healthy
  - com.rem2.plugin-inspector [Active] healthy
  - com.rem2.theme-dark [Active] healthy
─────────────────────────────
```

### 2. Electron desktop shell (optional)

The shell is a **plugin carrier**; the kernel does not depend on it. It boots the kernel as a

library and provides a command input box.

```bash
# Open the desktop app (dev mode, with hot reload)
pnpm start
```

Type a command in the window (default `hello`) and click "Execute"; the command is forwarded

to the kernel event bus through the IPC bridge. The top-bar **Plugins** view lists, installs,

enables, disables and uninstalls local plugins; new installs are disabled by default and user

data is preserved.

> **Why the host runs TypeScript via tsx**: the host's own entry (`src/host/cli/run.ts` for the
>
> terminal form, `src/host/electron/main.ts` for the desktop shell) is written in TypeScript and
>
> executed directly with tsx during development. Plugins, however, are **not** loaded as raw
>
> `.ts` at runtime — each plugin is pre-compiled by esbuild into a self-contained ESM bundle at
>
> `dist/index.js` (and `plugins-dist/<id>/dist/index.js`), which the kernel loads via dynamic
>
> `import()`. `tsx` stays a `devDependency`; the kernel's own `dependencies` remain zero
>
> third-party. A packaged build that needs to load `.ts` plugins would have to promote tsx to a
>
> runtime dependency.

> **GPU-less / virtualized / remote-desktop environments**: the Chromium GPU process may crash
>
> (`GPU process isn't usable. Goodbye.`). Disable hardware acceleration before launch:
>
> ```bash
> # Git Bash / macOS / Linux
> REM2_DISABLE_GPU=1 pnpm start
> ```
>
> ```powershell
> # Windows PowerShell
> $env:REM2_DISABLE_GPU=1; pnpm start
> ```
>
> Off by default so it does not hurt rendering performance on normal machines.

> This opt-in path also disables the Chromium **process sandbox** (`--no-sandbox`): on such hosts the
> sandbox's virtualization backend fails the same way (`Failed to create shared context for
virtualization`), which crashes every renderer process with an access violation — a blank window
> with `loadFile` then failing with ERR_FAILED. Only this opt-in path is weakened; the default
> startup keeps the process sandbox, and the renderer still runs under `contextIsolation` + the IPC
> allowlist + the kernel CapabilityGuard.
>
> Build installers: `pnpm package` (produces a runnable directory) / `pnpm make` (produces an installer).

---

## Developer CLI

```bash
pnpm cli scaffold com.example.my-plugin --name "My Plugin"   # generate a plugin skeleton
pnpm cli validate plugins/my-plugin                          # validate a manifest
pnpm cli validate plugins                                    # validate all manifests
pnpm cli list                                                # list built-in plugins
```

---

## Write a plugin

```ts
// plugins/com.example.my-plugin/src/index.ts
import { definePlugin } from 'rem2-kernel'
import type { PluginContext } from 'rem2-kernel'

export default definePlugin(
  {
    id: 'com.example.my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    entry: 'dist/index.js',
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
  },
  (ctx: PluginContext) => {
    return {
      async onStart(): Promise<void> {
        ctx.log.info('started')
      },
    }
  },
)
```

```json
// plugins/com.example.my-plugin/plugin.json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "entry": "dist/index.js",
  "compatibility": { "minKernel": "^1.0.0", "contractVersion": "1" }
}
```

7-stage lifecycle (all optional): `onDiscover` → `onLoad` → `onConfigure` → `onStart` →

`onStop` → `onUnload` → `onDispose`

Full API reference: **[docs/02-plugin-api.md](docs/02-plugin-api.md)** (English:

**[docs/en/02-plugin-api.md](docs/en/02-plugin-api.md)**).

---

## Example plugins (7 extension points)

| Plugin                                         | Proves what                                                                                     | Depends on              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------- |
| [`logger-console`](plugins/logger-console)     | **observability is a plugin** — provides `log.sink`                                             | —                       |
| [`config-json`](plugins/config-json)           | **config source is a plugin** — provides `config.provider`                                      | —                       |
| [`hello-command`](plugins/hello-command)       | **business logic is a plugin** — provides `command.provide`                                     | soft-dep config-json    |
| [`health-http`](plugins/health-http)           | **ops is a plugin** — exposes a `/health` endpoint                                              | hard-dep logger-console |
| [`theme-dark`](plugins/theme-dark)             | **UI is a plugin** — degrades gracefully with no UI shell                                       | —                       |
| [`plugin-inspector`](plugins/plugin-inspector) | **the inspector is a plugin** — contributes `ui.panel` + `ui.route`, serves a live plugin table | —                       |
| [`notify-worker`](plugins/notify-worker)       | **worker-thread isolation** — a crash never hits the kernel (fault isolation)                   | —                       |

---

## Kernel boundary

The kernel has **zero third-party runtime dependencies** and uses only 4 Node built-ins:

```
$ grep -rhoP "from '\K[^']+" src/kernel --include=*.ts | grep -v "^\.\|^node:" | sort -u
(empty)
```

Built-ins used: `node:fs` · `node:fs/promises` · `node:path` · `node:url`

Plugins may import **only** from the public entry `rem2-kernel`; deep-linking into

`src/kernel/**` internals is forbidden — enforced by contract tests.

---

## Testing

```bash
pnpm test:run        # full suite
pnpm test:coverage   # coverage
pnpm typecheck:all   # kernel + electron + frontend type checks
```

| Layer       | Files                    | Coverage                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | 26                       | semver / topological sort / cycle detection / DI container / container isolation / event bus / lifecycle / manifest validation / permissions / config service / health service / command dispatcher / DTO guards / route→panel resolution / builtin plugins root / plugin state store / integrity / remote download / ZIP extraction / release source / provenance store / version compare |
| Integration | 19                       | startup order / soft-dep fallback / hard-dep cascade / fault isolation / config plugin / observability / hot reload / unload cascade / security boundary / worker isolation / command chain / theme chain / UI chain / inspector data chain / local plugin manager / remote install, update and rollback                                                                                   |
| Contract    | 5                        | plugin import boundary / kernel dependency whitelist / extension-point catalog consistency / svelte built as browser bundle / IPC whitelist vs kernel Topics                                                                                                                                                                                                                               |
| **Total**   | **50 files / 466 cases** |                                                                                                                                                                                                                                                                                                                                                                                            |

---

## Documentation

Documents are numbered in **reading order** (`01` first). Full index:

**[docs/INDEX.md](docs/INDEX.md)** (English: **[docs/en/INDEX.md](docs/en/INDEX.md)**).

| #   | Document                                                            | Content                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | **[docs/INDEX.md](docs/INDEX.md)**                                  | **Doc index & reading path** (start here)                                                                                                                                                                                                            |
| 01  | **[01-architecture-overview.md](docs/01-architecture-overview.md)** | **Architecture (authoritative)**: layering & dependency direction, per-file responsibilities, two-layer lifecycle, 12 extension points, isolation & permissions, call chains, data flows, build artifacts, 9 decisions, extension flow, known limits |
| 02  | **[02-plugin-api.md](docs/02-plugin-api.md)**                       | **Plugin development guide**: `definePlugin`, `plugin.json` fields, lifecycle hooks, `PluginContext`, extension points, service tokens, command chain, isolation modes, error codes                                                                  |
| 03  | **[03-frontend-ipc.md](docs/03-frontend-ipc.md)**                   | **Frontend & IPC contract**: process/build boundaries, 20 methods + 6 events allowlist, DTOs, store↔event bridge, theme path, vite/CSP constraints                                                                                                   |
| 04  | **[04-development-guide.md](docs/04-development-guide.md)**         | **Development guide**: environment, command matrix, build & packaging spec, tsconfig boundaries, extension flow, debugging, pitfalls, code conventions                                                                                               |
| 05  | **[05-plugin-management.md](docs/05-plugin-management.md)**         | **Plugin management**: manifest checks, local and remote installs, updates and rollback, provenance, directories and states, path safety, data preservation, IPC/UI, known limits                                                                    |

Architecture diagrams: [class-diagram-v2.mermaid](docs/class-diagram-v2.mermaid) ·
[sequence-diagram-v2.mermaid](docs/sequence-diagram-v2.mermaid)
(English diagrams: [docs/en/class-diagram-v2.mermaid](docs/en/class-diagram-v2.mermaid) ·
[docs/en/sequence-diagram-v2.mermaid](docs/en/sequence-diagram-v2.mermaid)).

---

## Directory structure

```
src/
├── kernel/               # minimal kernel (zero third-party runtime deps, hard-asserted by contract tests)
│   ├── contracts/        # pure-type contracts + defineToken / definePlugin factories
│   ├── extensions/       # declarations & slots for the 12 extension points (the only mount surface)
│   ├── di/               # DI container (parent ref hidden in a module-private WeakMap)
│   ├── discovery/        # candidate discovery + manifest validation
│   ├── dependency/       # dependency graph / topological sort / cycle detection
│   ├── lifecycle/        # stage definitions + manager + physical pipeline + rollback
│   ├── loader/           # dynamic import (the only definePlugin shape)
│   ├── isolation/        # worker fault isolation (RPC whitelist)
│   ├── security/         # permissions + capability guard
│   ├── observability/    # log / metric / trace / health + extension-point sinks (host defaults)
│   ├── config/           # config service (provider pluggable)
│   ├── events/           # event bus (wildcard + RPC)
│   ├── scheduler/        # scheduler (replaceable by plugins)
│   ├── semver/           # independently implemented semver
│   ├── bootstrap/        # kernel options & core service registration
│   ├── registry/         # plugin registry
│   ├── context/          # PluginContext & PluginApi construction
│   ├── util/
│   ├── composition.ts    # the single KernelDeps assembly point (Kernel never news impls)
│   ├── state-machine.ts  # 7-stage logical state machine
│   ├── define-plugin.ts  # the single plugin shape entry
│   └── index.ts          # the single public entry (rem2-kernel)
├── host/                 # host adaptation layer (outside the kernel, alongside it)
│   ├── electron/         # main / preload / window / theme-registry
│   ├── ipc/              # IpcBridge + channel whitelist + event dimension-reduction map
│   └── cli/              # run / args / paths / cli / scaffold / validate
├── frontend/             # Svelte 5 render layer (the only place Svelte runs)
│   ├── app/              # App / Shell / PanelHost / RouteHost + components
│   └── lib/              # ipc-client / bridge-types / nav-link / dto-guards / stores / theme
├── main.ts               # Electron Forge main-process entry (forwarding shell)
└── preload.ts            # Forge preload entry (forwarding shell)
plugins/                  # 7 example plugins (source + plugin.json + standalone tsconfig)
plugins-dist/             # plugin build artifacts (esbuild ESM bundle, into extraResource)
dist/                     # kernel artifacts (tsc, includes .d.ts)
tests/                    # unit / integration / contract tests
docs/                     # architecture & API docs (entry: docs/INDEX.md; English: docs/en/)
examples/                 # example config & notes
```

---

## License

MIT
