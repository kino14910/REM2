/**
 * Integration test: command chain (renderer -> IPC bridge -> kernel -> command plugin).
 *
 * Rationale (postmortem of a real defect):
 * A `main.ts` responder was registered for 'command.execute' but implemented as
 * `request(Topics.CommandExecute)` - and `Topics.CommandExecute` *is* that same
 * string 'command.execute'. The request hit the same responder and recursed
 * infinitely, so user input `hello` produced `RangeError: Maximum call stack size exceeded`.
 *
 * Previous unit tests only covered EventBus's own request/respond pairing; none
 * covered the mapping from "IPC allowlist method name -> kernel topic name", and
 * any self-mapping recurses. This suite pins that mapping down.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js'
import { Topics } from '../../src/kernel/topics.js'
import { ALLOWED_METHOD_SET, Ipc } from '../../src/shared/ipc-contract.js'
import { IpcBridge } from '../../src/host/ipc/bridge.js'
import type { EventBus } from '../../src/kernel/contracts/event-bus.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist')

function createKernel(): Kernel {
  return new Kernel({
    id: 'rem2-command-chain',
    roots: [],
    builtinRoot: BUILTIN_ROOT,
    startTimeoutMs: 8000,
    stopTimeoutMs: 8000,
    legacyFallback: false,
    logLevel: 'error',
    initialConfig: { app: { greeting: 'Hello from rem2' } },
  })
}

describe('integration · command chain', () => {
  it('the command.execute in the IPC allowlist shares its name with the kernel topic (otherwise the bridge and the plugins mismatch)', () => {
    // Criterion for the "no responder" defect: the bridge requests with the
    // allowlist name, so the plugin must respond with the same string.
    expect(ALLOWED_METHOD_SET.has(Topics.CommandExecute)).toBe(true)
  })

  it('the hello command gets a successful response via the kernel bus', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      const result = await bus.request<
        { command: string },
        { ok: boolean; output?: string }
      >(Topics.CommandExecute, { command: 'hello' }, { timeoutMs: 5000 })

      expect(result.ok).toBe(true)
      expect(result.output).toContain('rem2')
    } finally {
      await kernel.shutdown()
    }
  })

  it('an unknown command returns an error instead of infinite recursion', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      const result = await bus.request<
        { command: string },
        { ok: boolean; error?: string }
      >(
        Topics.CommandExecute,
        { command: 'definitely-not-a-command' },
        { timeoutMs: 5000 },
      )

      expect(result.ok).toBe(false)
      expect(result.error).toContain('definitely-not-a-command')
    } finally {
      await kernel.shutdown()
    }
  })

  it('request throws NoResponderError when no command plugin exists (not silent, no recursion)', async () => {
    const kernel = new Kernel({
      id: 'rem2-no-command-plugin',
      roots: [],
      builtinRoot: path.join(
        PROJECT_ROOT,
        'tests',
        'fixtures',
        'empty-plugins',
      ),
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: 'error',
    })
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      await expect(
        bus.request(
          Topics.CommandExecute,
          { command: 'hello' },
          { timeoutMs: 3000 },
        ),
      ).rejects.toThrow(/no responder/)
    } finally {
      await kernel.shutdown()
    }
  })

  it('the full chain through the IPC bridge yields a successful hello response', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      const bridge = new IpcBridge(bus)
      const received: unknown[] = []
      bridge.bind({
        send: (_ch, payload) => received.push(payload),
        on: (ch, handler) => {
          if (ch !== Ipc.Invoke) return () => undefined
          return () => {
            void handler({
              id: 'chain-1',
              method: 'command.execute',
              args: { command: 'hello' },
            })
          }
        },
      })

      // Renderer-side equivalent: window.rem2.invoke('command.execute', { command: 'hello' })
      const response = await new Promise<{
        ok: boolean
        result?: unknown
        error?: string
      }>(resolve => {
        received.length = 0
        void (
          bridge as unknown as {
            handleInvoke(payload: unknown): Promise<void>
          }
        ).handleInvoke({
          id: 'chain-1',
          method: 'command.execute',
          args: { command: 'hello' },
        })
        setTimeout(() => resolve(received[0] as never), 1500)
      })

      expect(response.ok).toBe(true)
      expect(response.result).toMatchObject({ ok: true })
      bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })

  it('★ regression guard: the self-recursing forwarder must be caught (once caused RangeError)', async () => {
    // Reproduces the real user timing: the host responder is registered before
    // kernel.start() (main.ts:172 ahead of :173), so its seq is smaller and
    // `pickResponder` prefers it - while its implementation requests the same
    // topic, recursing infinitely into `Maximum call stack size exceeded`.
    // If someone re-adds this forwarder, this case goes red.
    const kernel = new Kernel({
      id: 'rem2-self-recursion',
      roots: [],
      builtinRoot: BUILTIN_ROOT,
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: 'error',
      initialConfig: { app: { greeting: 'Hello from rem2' } },
    })
    try {
      const busEarly = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      busEarly.respond<{ command: string }, unknown>('command.execute', args =>
        busEarly.request(Topics.CommandExecute, args, { timeoutMs: 5000 }),
      )
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)

      const bridge = new IpcBridge(bus)
      const received: unknown[] = []
      bridge.bind({
        send: (_ch, payload) => received.push(payload),
        on: (ch, handler) => {
          if (ch !== Ipc.Invoke) return () => undefined
          return () => {
            void handler({
              id: 'recur-1',
              method: 'command.execute',
              args: { command: 'hello' },
            })
          }
        },
      })

      const response = await new Promise<{ ok: boolean; error?: string }>(
        resolve => {
          received.length = 0
          void (
            bridge as unknown as {
              handleInvoke(payload: unknown): Promise<void>
            }
          ).handleInvoke({
            id: 'recur-1',
            method: 'command.execute',
            args: { command: 'hello' },
          })
          setTimeout(() => resolve(received[0] as never), 1500)
        },
      )

      // The recursion is caught by the bridge as an error response in the form of a RangeError - exactly what the user saw.
      expect(response.ok).toBe(false)
      expect(response.error).toMatch(/call stack/i)
      bridge.unbind()
    } finally {
      await kernel.shutdown()
    }
  })
})
