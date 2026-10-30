/**
 * Single source of truth for the worker message protocol.
 *
 * The protocol constants used to be inlined in both `worker-host.ts`
 * (discriminated by `msg.t`) and `worker-bootstrap.ts` (`switch (msg.t)`
 * inside the worker), two copies kept in sync manually. Message types now
 * live here, and `worker-bootstrap.ts` injects them as string constants.
 */

export const HOST_TO_WORKER = {
  Init: 'init',
  Call: 'call',
  Event: 'event',
  Config: 'config',
  CtxResult: 'ctx-result',
} as const

export const WORKER_TO_HOST = {
  Ready: 'ready',
  InitError: 'init-error',
  Result: 'result',
  Ctx: 'ctx',
  Subscribe: 'subscribe',
  Unsub: 'unsub',
} as const

export type HostToWorkerType =
  (typeof HOST_TO_WORKER)[keyof typeof HOST_TO_WORKER]
export type WorkerToHostType =
  (typeof WORKER_TO_HOST)[keyof typeof WORKER_TO_HOST]

export interface InitMessage {
  t: typeof HOST_TO_WORKER.Init
  entrySpecifier: string
  manifest: { id: string; name: string; version: string }
  rootDir: string
  /** Writable directory for this plugin (outside the install tree). */
  dataRoot: string
  configSnapshot: Record<string, unknown>
  /** Real permission snapshot (C8: the old implementation hardcoded an empty set). */
  permissions: { granted: string[]; denied: string[] }
}

export interface CallMessage {
  t: typeof HOST_TO_WORKER.Call
  id: number
  hook: string
  args: unknown[]
}

export interface CtxCallMessage {
  t: typeof WORKER_TO_HOST.Ctx
  id: number
  path: string[]
  args: unknown[]
}

/** Extension points a worker may contribute (values must be structured-cloneable, docs/01 §4.4). */
export const WORKER_ALLOWED_EXTENSION_POINTS = [
  'log.sink',
  'metrics.sink',
  'trace.exporter',
] as const
