/**
 * IPC bridge: the sole channel between renderer and kernel.
 *
 * Both directions are narrowed:
 * - host -> kernel: exact `allowedMethods.has(method)` check, never entering the event bus;
 * - kernel -> host: only the 5 whitelisted events are forwarded, with DTO reduction.
 *
 * Two things deliberately not done:
 * 1. `bus.emit` is not exposed to the renderer (that would grant write-side power);
 * 2. `bus.on('*')` is not forwarded (that would leak every internal topic).
 */

import type { EventBus, Unsubscribe } from '../../kernel/contracts/event-bus.js'
import type { TopicValue } from '../../kernel/topics.js'
import {
  ALLOWED_EVENT_SET,
  ALLOWED_METHOD_SET,
  Ipc,
  channels,
  type AllowedEvent,
  type IpcEventPayload,
  type IpcRequest,
  type IpcResponse,
} from '../../shared/ipc-contract.js'

/** Host transport abstraction (adapts Electron's ipcRenderer / ipcMain). */
export interface IpcTransport {
  send(channel: string, payload: unknown): void
  on(channel: string, handler: (payload: unknown) => void): () => void
}

/**
 * Kernel topic -> external event name reduction map.
 *
 * The shape is `Record<AllowedEvent, ...>` rather than an array: the key set is
 * forced by the whitelist, so omitting an event is a missing key = compile error;
 * `topic` is typed `TopicValue` (the true value union of `Topics`), so a mistyped
 * topic is a compile error. The concrete mapping is injected by `host/electron`.
 */
export type EventForwardMap = Readonly<{
  [K in AllowedEvent]: {
    topic: TopicValue
    toDto: (payload: unknown) => unknown
  }
}>

export class IpcBridge {
  private transport: IpcTransport | null = null
  private unsubscribers: Unsubscribe[] = []
  private readonly allowedMethods: ReadonlySet<string>
  private readonly allowedEvents: ReadonlySet<string>
  private readonly forwardMap: EventForwardMap

  constructor(
    private readonly bus: EventBus,
    opts: {
      allowedMethods?: ReadonlySet<string>
      allowedEvents?: ReadonlySet<string>
      forwardMap?: EventForwardMap
    } = {},
  ) {
    this.allowedMethods = opts.allowedMethods ?? ALLOWED_METHOD_SET
    this.allowedEvents = opts.allowedEvents ?? ALLOWED_EVENT_SET
    this.forwardMap = opts.forwardMap ?? ({} as EventForwardMap)
  }

  bind(transport: IpcTransport): void {
    this.unbind()
    this.transport = transport

    this.unsubscribers.push(
      transport.on(Ipc.Invoke, payload => {
        void this.handleInvoke(payload)
      }),
    )

    for (const [event, f] of Object.entries(this.forwardMap)) {
      this.unsubscribers.push(
        this.bus.on(f.topic, payload => {
          // Belt-and-braces guard: drop the event when the injected allowedEvents
          // set does not contain it. The default set is the whitelist itself, so
          // on the normal path this is always true; the check only matters when a
          // custom set is injected.
          if (!this.allowedEvents.has(event)) return
          const dto: IpcEventPayload = { event, payload: f.toDto(payload) }
          this.transport?.send(Ipc.Event, dto)
        }),
      )
    }
  }

  unbind(): void {
    for (const unsub of this.unsubscribers) unsub()
    this.unsubscribers = []
    this.transport = null
  }

  /** Whether the method is in the whitelist (exact match). */
  isAllowed(method: string): boolean {
    return this.allowedMethods.has(method)
  }

  private async handleInvoke(payload: unknown): Promise<void> {
    const req = payload as Partial<IpcRequest> | null
    if (!req || typeof req.method !== 'string') return

    // Whitelist check: methods outside the set are rejected directly and never enter the kernel event bus.
    if (!this.isAllowed(req.method)) {
      this.reply({
        id: req.id ?? '',
        ok: false,
        error: `Method rejected (not in the IPC whitelist): ${req.method}`,
      })
      return
    }

    try {
      const result = await this.bus.request(req.method, req.args, {
        timeoutMs: timeoutFor(req.method),
      })
      this.reply({ id: req.id ?? '', ok: true, result })
    } catch (error) {
      const code = (error as { code?: unknown }).code
      this.reply({
        id: req.id ?? '',
        ok: false,
        error: (error as Error).message,
        ...(typeof code === 'string' ? { errorCode: code } : {}),
      })
    }
  }

  private reply(res: IpcResponse): void {
    this.transport?.send(Ipc.Invoke, res)
  }
}

function timeoutFor(method: string): number {
  if (
    method === channels.pluginInstallFromRemote ||
    method === channels.pluginUpdateInstall
  ) {
    return 120_000
  }
  if (method === channels.pluginRemoteInspect) return 60_000
  if (method === channels.pluginUpdateCheck) return 30_000
  if (method === channels.pluginInstallFromDirectory) return 60_000
  if (method === channels.pluginRestart) return 60_000
  if (
    method === channels.pluginEnable ||
    method === channels.pluginDisable ||
    method === channels.pluginUninstall
  ) {
    return 15_000
  }
  return 5000
}
