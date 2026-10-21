/**
 * Contract test: single source of truth for the IPC contract.
 *
 * Background: adding one IPC method / event used to require editing 4 files
 * (host allowlist, forward map, host responder, frontend mirror); missing any
 * one of them silently stopped the renderer from receiving data. The allowlist
 * is now converged into `src/shared/ipc-contract.ts`, and the other three
 * sides reference it via computed keys + Record, so a missing entry is a
 * compile error.
 *
 * This file guards what types cannot:
 * 1. `shared/ipc-contract.ts` must have zero imports (otherwise the renderer
 *    would reach Node/Electron-side code through it);
 * 2. contract strings must not appear as a second literal on the host /
 *    frontend / plugin side;
 * 3. the key sets of the three tables must match the allowlist exactly;
 * 4. `command.execute` must stay `null` (the host does not implement it,
 *    otherwise it self-recurses).
 *
 * It also includes negative verification: `@ts-expect-error` proves the types
 * really do reject illegal names and missing entries. If the types were
 * weakened, these directives become unused and `pnpm typecheck` fails, so the
 * criterion cannot be vacuously true.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_EVENTS,
  ALLOWED_METHODS,
  channels,
  events,
  type AllowedEvent,
  type AllowedMethod,
} from '../../src/shared/ipc-contract.js'
import { EVENT_FORWARD_MAP } from '../../src/host/ipc/forward-map.js'
import { METHOD_FACTORIES } from '../../src/host/ipc/method-handlers.js'
import {
  collectSourceFiles,
  extractStringLiterals,
} from './helpers/source-scan.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const SHARED_FILE = path.join(PROJECT_ROOT, 'src', 'shared', 'ipc-contract.ts')

// Negative verification (compile-time): the four lines below must fail to compile.
// If the allowlist types are weakened (e.g. AllowedMethod degrades to string),
// any unused directive makes `pnpm typecheck` fail immediately, so the
// criterion cannot be vacuously true.
// @ts-expect-error method names outside the allowlist must be rejected by the type
const BAD_METHOD: AllowedMethod = 'ui.panel.lst'
// @ts-expect-error event names outside the allowlist must be rejected by the type
const BAD_EVENT: AllowedEvent = 'ui.theme.changedx'
// @ts-expect-error omitting a method must be rejected by Record<AllowedMethod, ...>
const INCOMPLETE_METHODS: Record<AllowedMethod, unknown> = {
  [channels.panelList]: 1,
}
// @ts-expect-error omitting an event must be rejected by Record<AllowedEvent, ...>
const INCOMPLETE_EVENTS: Record<AllowedEvent, unknown> = {
  [events.themeChanged]: 1,
}

describe('contract · single source of truth for the IPC contract', () => {
  it('shared/ipc-contract.ts must have zero imports (the neutral layer must stay unpolluted)', async () => {
    const source = await readFile(SHARED_FILE, 'utf8')
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
    const imports = stripped.match(
      /(?:import|export)\s[^\n]*?from\s*['"][^'"]+['"]/g,
    )
    expect(
      imports ?? [],
      'the shared contract layer must have zero imports: it is referenced by preload / main / renderer / vitest',
    ).toEqual([])
  })

  it('contract strings must not appear as a second literal on the host / frontend / plugin side', async () => {
    const literals = new Set<string>([...ALLOWED_METHODS, ...ALLOWED_EVENTS])
    const scopes: string[] = [
      path.join(PROJECT_ROOT, 'src', 'host'),
      path.join(PROJECT_ROOT, 'src', 'frontend'),
    ]
    // Plugin sources must not hand-copy these names either.
    for (const dir of ['plugins']) {
      const pluginRoot = path.join(PROJECT_ROOT, dir)
      const { readdir } = await import('node:fs/promises')
      let entries: string[] = []
      try {
        entries = (await readdir(pluginRoot, { withFileTypes: true }))
          .filter(e => e.isDirectory())
          .map(e => e.name)
      } catch {
        entries = []
      }
      for (const d of entries) {
        scopes.push(path.join(pluginRoot, d, 'src'))
      }
    }

    const violations: Array<{ file: string; literal: string }> = []
    for (const scope of scopes) {
      for (const file of await collectSourceFiles(scope)) {
        const source = await readFile(file, 'utf8')
        for (const literal of extractStringLiterals(source)) {
          if (literals.has(literal)) {
            violations.push({
              file: path.relative(PROJECT_ROOT, file),
              literal,
            })
          }
        }
      }
    }
    expect(
      violations,
      'contract strings may only appear in src/shared/ipc-contract.ts (same-named topics in kernel Topics excepted)',
    ).toEqual([])
  })

  it('the forward map key set matches the event allowlist exactly', () => {
    expect(Object.keys(EVENT_FORWARD_MAP).toSorted()).toEqual(
      [...ALLOWED_EVENTS].toSorted(),
    )
  })

  it('the host implementation table key set matches the method allowlist exactly', () => {
    expect(Object.keys(METHOD_FACTORIES).toSorted()).toEqual(
      [...ALLOWED_METHODS].toSorted(),
    )
  })

  it('command.execute must be null (the host does not implement it, or self-recursion triggers)', () => {
    expect(METHOD_FACTORIES[channels.commandExecute]).toBeNull()
  })

  it('negative verification: illegal names and omissions are rejected at compile time', () => {
    // The runtime assertions here are trivial; the real assertions are the
    // `@ts-expect-error` directives (see the file header).
    expect(BAD_METHOD).toBe('ui.panel.lst')
    expect(BAD_EVENT).toBe('ui.theme.changedx')
    expect(Object.keys(INCOMPLETE_METHODS)).toHaveLength(1)
    expect(Object.keys(INCOMPLETE_EVENTS)).toHaveLength(1)
  })
})
