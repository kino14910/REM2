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

import { execFile } from 'node:child_process'
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

const RECURSION_PROBE = `
import { pathToFileURL } from 'node:url'
const base = pathToFileURL(process.cwd() + '/src/').href
const { Kernel } = await import(base + 'kernel/kernel.ts')
const { KernelTokens } = await import(base + 'kernel/contracts/kernel-tokens.ts')
const { Topics } = await import(base + 'kernel/topics.ts')
const { IpcBridge } = await import(base + 'host/ipc/bridge.ts')
const { Ipc } = await import(base + 'shared/ipc-contract.ts')

const kernel = new Kernel({
  id: 'rem2-self-recursion-child',
  roots: [],
  startTimeoutMs: 5000,
  stopTimeoutMs: 5000,
  logLevel: 'error',
})
const earlyBus = kernel.root.resolve(KernelTokens.EventBus)
earlyBus.respond(Topics.CommandExecute, args =>
  earlyBus.request(Topics.CommandExecute, args, { timeoutMs: 5000 }),
)
await kernel.start()
const bus = kernel.root.resolve(KernelTokens.EventBus)
const bridge = new IpcBridge(bus)
const response = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('recursion probe timed out')), 8000)
  bridge.bind({
    send: (_channel, payload) => {
      if (payload && payload.ok === false) {
        clearTimeout(timer)
        resolve(payload)
      }
    },
    on: (channel, handler) => {
      if (channel === Ipc.Invoke) {
        void handler({ id: 'recur-1', method: 'command.execute', args: { command: 'hello' } })
      }
      return () => undefined
    },
  })
})
process.stdout.write(JSON.stringify(response) + '\\n', () => process.exit(0))
`

function runRecursionProbe(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', RECURSION_PROBE],
      { cwd: PROJECT_ROOT, timeout: 20_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

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

  it('an explicit error result when no command plugin exists (not silent, no recursion)', async () => {
    // With no command plugin the kernel dispatcher still answers (it is the
    // only responder for the topic): an explicit {ok:false} result, never a
    // NoResponderError escape and never recursion.
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

      const result = await bus.request<
        { command: string },
        { ok: boolean; error?: string }
      >(Topics.CommandExecute, { command: 'hello' }, { timeoutMs: 3000 })

      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/unknown command/)
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
    // A genuine stack overflow leaves orphaned rejected promises behind. Running
    // the probe in a child process keeps those artifacts out of Vitest while
    // still exercising the real kernel, event bus and IPC bridge.
    const stdout = await runRecursionProbe()
    const response = JSON.parse(stdout.trim()) as {
      ok: boolean
      error?: string
    }
    expect(response.ok).toBe(false)
    expect(response.error).toMatch(/call stack/i)
  })
})
