/**
 * Unit test: CommandDispatcher (the single dispatch path for `command.execute`).
 *
 * Rationale: the kernel registers the dispatcher as the only responder for
 * `command.execute` and it reads the `command.provide` slot directly, so the
 * self-recursion trap (a responder forwarding a request to itself) is
 * structurally impossible. These tests pin the payload contract around that
 * path: handler return values pass through untouched (a wrapper here would
 * silently break every command plugin's result shape), args reach the handler,
 * and every failure mode answers explicitly instead of throwing or staying
 * silent.
 *
 * The registry is driven directly: `command.provide` carries a capability, and
 * with no PermissionManager only pluginId 'kernel' is granted - so
 * contributions go through `registerHostDefault` (the host default path).
 */

import { describe, expect, it } from 'vitest'
import { CommandDispatcher } from '../../src/kernel/extensions/command-dispatcher.js'
import { ExtensionPointRegistry } from '../../src/kernel/extensions/registry.js'
import { EXTENSION_POINT_DEFS } from '../../src/kernel/extensions/definitions.js'
import type { CommandHandler } from '../../src/kernel/extensions/ports.js'

function createRegistry(): ExtensionPointRegistry {
  const registry = new ExtensionPointRegistry()
  registry.defineAll(EXTENSION_POINT_DEFS)
  return registry
}

function provide(
  registry: ExtensionPointRegistry,
  contributionId: string,
  impl: CommandHandler,
): void {
  registry.registerHostDefault<CommandHandler>('command.provide', {
    contributionId,
    impl,
  })
}

describe('unit · command dispatcher', () => {
  it('passes the handler return value through untouched (no re-wrapping)', async () => {
    const registry = createRegistry()
    provide(registry, 'hello', async () => ({ ok: true, output: 'Hello, x!' }))
    const dispatcher = new CommandDispatcher(registry)

    // Deep equality on purpose: a wrapper like { ok: true, output: {...} } fails here.
    expect(
      await dispatcher.dispatch({ command: 'hello', args: { name: 'x' } }),
    ).toEqual({ ok: true, output: 'Hello, x!' })
  })

  it('forwards args to the handler', async () => {
    const registry = createRegistry()
    const seen: unknown[] = []
    provide(registry, 'echo', async args => {
      seen.push(args)
      return { ok: true }
    })
    const dispatcher = new CommandDispatcher(registry)

    await dispatcher.dispatch({ command: 'echo', args: { name: 'x' } })
    expect(seen).toEqual([{ name: 'x' }])
  })

  it('an unknown command returns an explicit error naming the command', async () => {
    const registry = createRegistry()
    provide(registry, 'hello', async () => ({ ok: true }))
    const dispatcher = new CommandDispatcher(registry)

    const result = await dispatcher.dispatch({
      command: 'definitely-not-a-command',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('definitely-not-a-command')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['command: 42', { command: 42 }],
    ["command: ''", { command: '' }],
  ])(
    'an invalid payload (%s) is rejected with an explicit error',
    async (_label, payload) => {
      const registry = createRegistry()
      const dispatcher = new CommandDispatcher(registry)

      const result = await dispatcher.dispatch(payload)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('invalid')
    },
  )

  it('a throwing handler becomes an error result carrying the message', async () => {
    const registry = createRegistry()
    provide(registry, 'boom', async () => {
      throw new Error('handler exploded')
    })
    const dispatcher = new CommandDispatcher(registry)

    const result = await dispatcher.dispatch({ command: 'boom' })
    expect(result).toEqual({ ok: false, error: 'handler exploded' })
  })

  it('selects the handler by contributionId when several commands are registered', async () => {
    const registry = createRegistry()
    provide(registry, 'alpha', async () => ({ ok: true, output: 'A' }))
    provide(registry, 'beta', async () => ({ ok: true, output: 'B' }))
    const dispatcher = new CommandDispatcher(registry)

    expect(await dispatcher.dispatch({ command: 'alpha' })).toEqual({
      ok: true,
      output: 'A',
    })
    expect(await dispatcher.dispatch({ command: 'beta' })).toEqual({
      ok: true,
      output: 'B',
    })
  })
})
