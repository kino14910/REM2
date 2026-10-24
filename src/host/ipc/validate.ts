/**
 * Runtime validation for IPC method args.
 *
 * Args arriving from the renderer are untrusted at runtime (the preload
 * bridge is a plain JS surface). This module is the host-side boundary
 * guard: pure functions, no imports, so it stays trivially testable and
 * cannot drag kernel/host dependencies into the validation path.
 *
 * Policy: invalid args throw (the bridge turns that into an error reply and
 * the frontend renders its error state) - never a silent coercion, which
 * once let `String(themeId ?? '')` swallow a malformed request into a
 * meaningless empty-string lookup.
 */

/** Narrows unknown args to an object or throws with an explicit message. */
function asObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) {
    throw new Error('invalid args: expected an object')
  }
  return args as Record<string, unknown>
}

/** Reads a required non-empty string field or throws naming the field. */
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid args: expected { ${field}: non-empty string }`)
  }
  return value
}

/** Validates `{ panelId: string }` and returns the panel id. */
export function panelIdOf(args: unknown): string {
  return nonEmptyString(asObject(args).panelId, 'panelId')
}

/**
 * Validates `{ panelId, kind, payload? }` for `ui.event`.
 *
 * `payload` is plugin-defined and passes through untouched (`unknown`).
 */
export function uiEventArgsOf(args: unknown): {
  panelId: string
  kind: string
  payload?: unknown
} {
  const obj = asObject(args)
  const panelId = nonEmptyString(obj.panelId, 'panelId')
  const kind = nonEmptyString(obj.kind, 'kind')
  return obj.payload === undefined
    ? { panelId, kind }
    : { panelId, kind, payload: obj.payload }
}

/** Validates `{ themeId: string }` and returns the theme id. */
export function themeIdOf(args: unknown): string {
  return nonEmptyString(asObject(args).themeId, 'themeId')
}
