# 04 · Development Guide

> Environment, commands, build and packaging specs, extension flow, troubleshooting. For architecture background see [`01-architecture-overview.md`](01-architecture-overview.md); for the plugin contract see [`02-plugin-api.md`](02-plugin-api.md); for IPC see [`03-frontend-ipc.md`](03-frontend-ipc.md).
>
> 中文版：[`../04-development-guide.md`](../04-development-guide.md)

---

## 1. Environment

| Item        | Requirement                                                                     |
| ----------- | ------------------------------------------------------------------------------- |
| Node        | >= 20 (`package.json` → `engines`)                                              |
| pnpm        | >= 9; the repo pins `pnpm@12.8.1` (via Corepack)                                |
| Platform    | Windows / macOS / Linux; on Windows test concurrency must stay limited (see §6) |
| Third-party | devDependencies only. `dependencies` stays `{}` (hard red line)                 |

```bash
pnpm install
```

---

## 2. Command matrix

| Command                       | Effect                                                                               | When                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `pnpm dev`                    | start the kernel in terminal form (`tsx src/host/cli/run.ts`); `predev` builds first | primary shape for kernel/plugin work              |
| `pnpm dev --exit-after-start` | start then exit immediately, printing loadOrder / started / degraded / failed        | smoke test                                        |
| `pnpm dev --log-level debug`  | raise the log level                                                                  | debugging load / lifecycle issues                 |
| `pnpm start`                  | Electron desktop app (`electron-forge start`)                                        | host / frontend / IPC work                        |
| `pnpm build`                  | `build:kernel` + `build:plugins`                                                     | after kernel or plugin edits                      |
| `pnpm build:kernel`           | `tsc -p tsconfig.build.json` → `dist/kernel/**`                                      | only when you need `.d.ts` or the kernel artifact |
| `pnpm build:plugins`          | esbuild per plugin → `plugins-dist/<id>/dist/index.js`                               | after editing plugin source (**required**)        |
| `pnpm build:renderer`         | build the renderer alone                                                             | debugging frontend output                         |
| `pnpm typecheck:all`          | `typecheck` + `typecheck:electron` + `typecheck:frontend`                            | before committing                                 |
| `pnpm test:run`               | full test suite (single run)                                                         | before committing                                 |
| `pnpm test:watch`             | watch mode                                                                           | during development                                |
| `pnpm lint` / `pnpm lint:fix` | oxlint + oxfmt check / fix                                                           | before committing                                 |
| `pnpm cli scaffold <id>`      | generate a plugin skeleton                                                           | creating a plugin                                 |
| `pnpm cli validate <path>`    | validate `plugin.json`                                                               | after creating/editing a manifest                 |
| `pnpm cli list`               | list discovered plugins                                                              | verifying discovery                               |
| `pnpm verify:render`          | run the renderer once offscreen in Electron                                          | when the renderer is blank                        |
| `pnpm package` / `pnpm make`  | package / produce installers (`premake` builds first)                                | distribution                                      |

Current verification baseline:

```
pnpm typecheck:all    → 0 errors (3 tsconfigs)
pnpm test:run         → 41 files / 327 cases green (~15s)
pnpm dev --exit-after-start → started=7 failed=0
```

---

## 3. Build and packaging specs

### 3.1 Three production lines and artifact paths

| Line    | Input                                                             | Command                                 | Output                                                                                     |
| ------- | ----------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Kernel  | `src/kernel/**`                                                   | `tsc -p tsconfig.build.json`            | `dist/kernel/**` (`.js` + `.d.ts` + `.map`)                                                |
| Plugins | `plugins/<id>/src/index.ts`                                       | `esbuild` (`scripts/build-plugins.mjs`) | `plugins-dist/<id>/{dist/index.js, plugin.json, package.json}`                             |
| Shell   | `src/main.ts` / `src/preload.ts` / `src/frontend/entry-client.ts` | forge's VitePlugin                      | `.vite/build/main.cjs`, `.vite/build/preload.cjs`, `.vite/renderer/main_window/index.html` |

Packaging (`electron-forge package`):

```
.vite/build + .vite/renderer  →  app.asar (OnlyLoadAppFromAsar=true)
plugins-dist                  →  resources/plugins-dist/ (extraResource, ★ outside the asar)
```

### 3.2 "Artifact ↔ path ↔ resolution rule" table

| Artifact                  | Location                                | Resolved by                                                | Rule / constraint                                                                                    |
| ------------------------- | --------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Kernel library            | `dist/kernel/index.js` + `.d.ts`        | `package.json` → `exports["."]`                            | `types` → `.d.ts`, `default` → `.js`. The `./src` subpath export exists only for in-repo development |
| Kernel (bare name in dev) | `src/kernel/index.ts`                   | `package.json` → `imports` + tsconfig `paths` + vite alias | all three must point at the same file; plugin tsconfigs declare `paths` separately                   |
| Plugin entry              | `plugins-dist/<id>/dist/index.js`       | kernel `loader`'s `import()`                               | `entry` always `dist/index.js`; only `.js` / `.mjs`; `assertInsideRoot` blocks escapes               |
| Main process              | `.vite/build/main.cjs`                  | `package.json` → `main`                                    | CJS; `import.meta.url` is `undefined`, so path resolution must fall back to `__dirname`              |
| preload                   | `.vite/build/preload.cjs`               | hardcoded filename in `host/electron/window.ts`            | must be CJS and must be named `preload.cjs`                                                          |
| renderer                  | `.vite/renderer/main_window/index.html` | `loadFile` in `window.ts`                                  | directory name is the uppercased renderer process name (`MAIN_WINDOW_VITE_NAME`)                     |
| Plugins (packaged)        | `resources/plugins-dist/`               | `builtinPluginsRoot()`                                     | `extraResource` derives the target name from the last segment, **not** `rem2-plugins/`               |

### 3.3 tsconfig responsibilities

Five configs = one baseline + three specializations + one forwarder; `strict` / `noUnused*` are global.

| Config                     | `include`                                                                                 | `lib` / `types`                                      | `moduleResolution`     | Why                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.json` (baseline) | `src/kernel/**`, `src/host/{cli,ipc}/**`, `plugins/*/src/**`, `tests/**`, `*.ts`, `*.mts` | `ESNext` + `types: ["node"]`                         | `NodeNext`             | kernel and CLI/IPC are pure Node libraries with no DOM need; also covers plugins and tests so all three judge the same contracts identically                                                                  |
| `tsconfig.electron.json`   | `src/{main,preload}.ts`, `src/host/electron/**`, `src/declarations.d.ts`                  | `ESNext` + `DOM` + `DOM.Iterable`, `types: ["node"]` | `NodeNext` (inherited) | main and preload need DOM (`BrowserWindow`) and node at the same time                                                                                                                                         |
| `tsconfig.frontend.json`   | `src/frontend/**`, `src/declarations.d.ts`                                                | `ESNext` + `DOM`, **`types: []`**                    | **`Bundler`**          | ① deliberately no node types: the renderer has no Node capability under `contextIsolation + sandbox`, so the constraint lives in types; ② `Bundler` is required for the svelte plugin to resolve `./X.svelte` |
| `tsconfig.build.json`      | `src/kernel/**` only                                                                      | same as baseline                                     | `NodeNext`             | **the only config with `noEmit: false`**: `declaration: true` + `outDir: dist` + `rootDir: src`; host and frontend never enter dist                                                                           |
| `tsconfig.shell.json`      | —                                                                                         | —                                                    | —                      | forwarder (`extends: ./tsconfig.electron.json`) kept so existing verification scripts do not break                                                                                                            |

Plugin tsconfigs (`plugins/*/tsconfig.json`) are standalone, declaring only `paths: { "rem2-kernel": ["../../src/kernel/index.ts"] }`, and do not extend the root config.

### 3.4 Build-time red lines

1. Missing `ssr.noExternal: ['rem2-kernel']` → the main bundle keeps `require('rem2-kernel')`, resolving to the `.ts` entry when packaged → `ERR_UNKNOWN_FILE_EXTENSION`. **Only visible after packaging.**
2. renderer `resolve.conditions` without `browser` → resolves to svelte's `index-server.js` → blank page.
3. `index.html` must point at `/src/frontend/entry-client.ts` and must contain no inline styles.
4. Renaming the renderer process → rename the `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` constants too.
5. A plugin `entry` must never point back at `src/index.ts`: runtime `import()` does not map `.js` → `.ts`, and pointing the plugin root at the wrong directory makes every plugin fail with "module resolution failed".

---

## 4. Extension flow

### 4.1 Adding a plugin

```bash
pnpm cli scaffold com.example.my-plugin
# write plugins/my-plugin/src/index.ts (see 02)
pnpm build:plugins
pnpm cli validate plugins/my-plugin/plugin.json
pnpm dev --exit-after-start
```

No kernel, host or frontend changes. If one seems necessary, the capability was not modeled as an extension point — add the extension point instead of a special case.

### 4.2 Adding an extension point / an IPC method

See [`01-architecture-overview.md`](01-architecture-overview.md) §10. Two enforcement points: `EXPECTED_IDS` in `tests/contract/extension-points.test.ts`, and complete keys in `Record<AllowedMethod, …>` / `Record<AllowedEvent, …>` — missing one fails compilation or the test.

### 4.3 Pre-commit checks

```bash
pnpm lint
pnpm typecheck:all
pnpm test:run
pnpm dev --exit-after-start
```

---

## 5. Debugging

| Situation                              | Approach                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What the kernel loaded                 | `pnpm dev`, read the `loadOrder` / `started` / `degraded` / `failed` sections                                                                                                                                                                                              |
| Why a plugin failed                    | raise the level with `--log-level debug`; the error lands in `KernelStartResult.failed[].error`                                                                                                                                                                            |
| Lifecycle / dependency issues          | `tests/unit/lifecycle.test.ts` and `tests/unit/resolver-boundary.test.ts` are the behavior spec — read them first                                                                                                                                                          |
| A command gets no response             | ① is the method in the allowlist (`src/shared/ipc-contract.ts`) ② does a plugin contribute to `command.provide` with a contributionId matching the command name (the kernel `CommandDispatcher` looks the slot up by id; a miss returns `unknown command`) ③ see §6 item 3 |
| Theme does not apply                   | ① did the plugin contribute `ui.theme` ② is `ui.theme.list` non-empty ③ is the page background overridden by an inline style                                                                                                                                               |
| Blank renderer                         | `pnpm verify:render`; then check §3.4 item 2 and CSP warnings                                                                                                                                                                                                              |
| No logs from the Electron main process | Windows GUI subsystem swallows stdout. Diagnostic: `fs.writeFileSync` the health result inside `startKernel()` and read the file                                                                                                                                           |
| Plugins missing after packaging        | confirm `resources/plugins-dist/` exists on disk and check `builtinPluginsRoot()`'s priority                                                                                                                                                                               |

---

## 6. Known pitfalls

1. **vitest concurrency must stay limited** (`vitest.config.ts`: `maxWorkers: 4` plus `testTimeout`/`hookTimeout`). The default (CPU count) starves heavy integration tests, showing up as `Hook timed out` — not a real defect.
2. **`electron-forge start` deletes `.vite`**. A local safe-delete shim can FAIL_CLOSED and abort; run `rm -rf .vite` first (Git Bash `rm` works).
3. **The host implementation of `command.execute` must stay `null`**. Dispatch goes through exactly one place: the kernel `CommandDispatcher` (registered at the beginning of `start()`, reading the `command.provide` slot directly, never requesting the same topic — recursion is structurally impossible). If the host registers a forwarding responder under the same topic, `Topics.CommandExecute` _is_ `'command.execute'`, so the request hits itself → infinite recursion `RangeError`. The precondition is the host registering **before** `kernel.start()` (smaller seq, `pickResponder` picks it first). The regression sentinel lives in `tests/integration/command-chain.test.ts`.
4. **`unset ELECTRON_RUN_AS_NODE` before running the GUI**, otherwise electron degrades to plain node.
5. **Clear the output directory before verifying multi-file artifacts**, and check filenames, sizes and the `index.html` references. A stale artifact with the same hash looks like success.
6. **`grep -c pattern *.js` prints per file**; one clean file does not make the overall count zero.
7. **The zero-dependency red line is a hard assertion in `tests/contract/kernel-deps.test.ts`**, so `tsx` must stay in devDependencies; promoting it to `dependencies` turns the test red immediately.
8. **After `git reset`, many files appear modified while `git diff --cached` is empty** — that is a racily-clean artifact (index and mtime in the same second); `git add -A <dir>` refreshes it. Do not misread it as lost changes.
9. **The packaging chain is verified (2026-10-24)**: `pnpm package` runs end-to-end; on Windows the squirrel maker produces a `Setup.exe` carrying `resources/plugins-dist/` (the deb/rpm makers are Linux-only, a platform limit). If `out/` contains files locked by another process, the packager's cleanup step is aborted by this machine's safe-delete shim (a `trash` failure) — clear `out/` before running `package` / `make`.
10. **Node's native TS support (strip-only) does not work for plugins**: no parameter properties (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and `.js` specifiers are not remapped to `.ts` (`ERR_MODULE_NOT_FOUND`). No plugin-side change fixes this; precompile instead.
11. **`REM2_DISABLE_GPU=1` must be paired with `--no-sandbox`** (both live in the same opt-in block in `main.ts`). On GPU-less / virtualized hosts the Chromium process sandbox's virtualization backend fails the same way (`Failed to create shared context for virtualization`), so disabling the GPU without the sandbox crashes every renderer process with an access violation: the symptom is a **blank window** + `render-process-gone` (crashed) + `ERR_FAILED` from `loadFile`. Criterion: `scripts/verify-render.cjs` uses a 5-switch combination that includes `--no-sandbox` and renders fine, while any 4-switch combination without it always crashes.

---

## 7. Code conventions

| Convention           | Content                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Language / module    | TypeScript strict + Node ESM; relative imports in source use a `.js` suffix (pointing at `.ts`)                  |
| Style                | no semicolons, single quotes (enforced by oxfmt)                                                                 |
| Comments             | only intent and traps that the code cannot express; no module-description blocks                                 |
| Kernel deps          | `src/kernel/**` uses only `node:` built-ins and relative imports; never `host` / `frontend` / `plugins`          |
| Contracts first      | `contracts/*` holds pure types and pure functions, no logic, no IO                                               |
| Topics and IPC names | always reference constants (`Topics` / `channels` / `events`), never hand-copied strings                         |
| New assertions       | a "no violations" test must ship with a meta-test proving it can fail, otherwise the red line goes silently dead |
| Documentation        | cite symbol names rather than line numbers; line numbers appear only as "snapshot at writing time"               |
