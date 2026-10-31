# rem2-kernel Documentation Index (English)

> Project: `rem2-kernel` (package `rem2-kernel`) — minimal kernel + everything-as-plugin.
>
> Documents are numbered in **reading order** (`01` first). Each of the five documents owns one area and never restates another.
>
> 中文版：[`../INDEX.md`](../INDEX.md)

## Document map

| #   | Document                                             | Content                                                                                                                                                                                                                                                                         | Audience                |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 01  | [architecture-overview](01-architecture-overview.md) | **Authoritative architecture**: layers and dependency direction, per-file responsibilities, two-layer lifecycle, 12 extension points, isolation and permissions, call chains, data paths, build artifacts, 9 design decisions, extension flow, known limits, contract-test list | everyone starts here    |
| 02  | [plugin-api](02-plugin-api.md)                       | **Plugin development guide**: `definePlugin`, `plugin.json` fields, lifecycle hooks, `PluginContext`, extension points, service tokens, command chain, isolation modes, error codes, self-check list                                                                            | plugin authors          |
| 03  | [frontend-ipc](03-frontend-ipc.md)                   | **Frontend and IPC contract**: process and build boundaries, frontend layout, 20 methods + 6 events allowlist, DTOs, stores and the event bridge, theme path, vite/CSP constraints                                                                                              | frontend / host authors |
| 04  | [development-guide](04-development-guide.md)         | **Development guide**: environment, command matrix, build and packaging specs, tsconfig boundaries, extension flow, debugging, pitfalls, code conventions                                                                                                                       | anyone changing code    |
| 05  | [plugin-management](05-plugin-management.md)         | **Plugin management**: manifest checks, local and remote installs, updates and rollback, provenance, directories and states, path safety, data preservation, IPC/UI, known limits                                                                                               | host / ops developers   |

**Diagrams**: [`class-diagram-v2.mermaid`](class-diagram-v2.mermaid) (class diagram), [`sequence-diagram-v2.mermaid`](sequence-diagram-v2.mermaid) (5 main-chain sequence diagrams).

## Reading path by role

| Who you are                       | Read in this order                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Want to understand how it works   | `01` §1 layers → §3 lifecycle → §4 extension points → §6 call chains → §7 data paths |
| Want to write a plugin            | `02` in full → `01` §4 extension points → `04` §4.1 adding a plugin                  |
| Want to touch the frontend or IPC | `03` in full → `01` §7.2 DTO reduction → `01` §10.3 adding an IPC method             |
| Maintain plugin install/lifecycle | `05` in full → `03` §3.2 management methods → `02` §3 manifest                       |
| Want to know why a design is so   | `01` §9 design decisions → §11 known limits                                          |
| Just onboarded, need it running   | `04` §1 environment → §2 commands → §3 build → `01` §1 layers                        |

## Quick start

```bash
pnpm install
pnpm dev                      # start the kernel in terminal form (6 built-in plugins)
pnpm start                    # Electron desktop app (renderer is Svelte 5)
pnpm test:run                 # full suite (51 files / 489 cases)
pnpm typecheck:all            # three tsconfigs
```

## Boundaries are enforced by contract tests

`tests/contract/` holds 5 files and 35 cases of static assertions:

| Assertion                                                        | What it protects                                    |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| kernel and host have zero third-party imports, no upward imports | `01` §1 hard layering constraints                   |
| `dependencies` stays `{}`                                        | the zero-dependency red line                        |
| plugins import only `rem2-kernel`, `entry` is `.js`              | the import and artifact boundaries in `02`          |
| `src/shared` has zero imports, method/event key sets are equal   | the allowlist in `03` §3 cannot drift               |
| the extension point list matches `EXPECTED_IDS`                  | the extension point table in `01` §4.1 cannot drift |
| the renderer artifact is the browser build of svelte             | no blank page                                       |

## On external references

The REM project (`D:\projects\REM`) is an architecture-analysis subject only. This repository inherits no code from it, and it is not a dependency or reference implementation here.
