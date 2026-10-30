/**
 * Runtime guards for data crossing the IPC boundary (pure functions).
 *
 * The renderer cannot trust host payloads at runtime (the preload bridge is
 * a plain JS surface): every list is validated entry by entry and every
 * panel-data payload is classified into an explicit shape. Bad entries are
 * dropped with an issue recorded (never silently rendered); unparseable
 * lists throw so the store can degrade to its error state.
 */

import type { PanelDto, PanelFormDto, RouteDto } from './bridge-types.js'
import type {
  PluginDetailDto,
  PluginDownloadPhase,
  PluginDownloadProgressDto,
  PluginOperationResultDto,
  PluginRemoteInspectionDto,
  PluginRuntimeStateDto,
  PluginUpdateDto,
} from '../../shared/ipc-contract.js'

/** Upper bound for rendered panel data (keeps a rogue plugin from freezing the UI). */
const MAX_PANEL_DATA_CHARS = 32768

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPanelRegion(value: unknown): value is PanelDto['region'] {
  return value === 'main' || value === 'side'
}

/** Validates one PanelDto; returns a reason string when invalid. */
function panelIssue(entry: unknown, index: number): string | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return `panel[${index}]: not an object`
  }
  const p = entry as Record<string, unknown>
  for (const field of ['panelId', 'title', 'icon', 'command'] as const) {
    if (!isNonEmptyString(p[field])) {
      return `panel[${index}]: field "${field}" must be a non-empty string`
    }
  }
  if (!isPanelRegion(p.region)) {
    return `panel[${index}]: field "region" must be "main" or "side"`
  }
  if (typeof p.order !== 'number' || !Number.isFinite(p.order)) {
    return `panel[${index}]: field "order" must be a number`
  }
  return undefined
}

/** Validates one RouteDto; returns a reason string when invalid. */
function routeIssue(entry: unknown, index: number): string | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return `route[${index}]: not an object`
  }
  const r = entry as Record<string, unknown>
  for (const field of ['path', 'title', 'panelId', 'commandPrefix'] as const) {
    // panelId may be the empty string: a route with no panel association is
    // legal (nav-link surfaces it as a notice, not a validation failure).
    if (typeof r[field] !== 'string') {
      return `route[${index}]: field "${field}" must be a string`
    }
  }
  if (typeof r.order !== 'number' || !Number.isFinite(r.order)) {
    return `route[${index}]: field "order" must be a number`
  }
  return undefined
}

/** Validates a panel list; throws when the payload is not an array at all. */
export function parsePanelList(value: unknown): {
  items: PanelDto[]
  issues: string[]
} {
  if (!Array.isArray(value)) {
    throw new Error('invalid panel list: expected an array')
  }
  const items: PanelDto[] = []
  const issues: string[] = []
  value.forEach((entry, index) => {
    const issue = panelIssue(entry, index)
    if (issue) {
      issues.push(issue)
      return
    }
    items.push(entry as PanelDto)
  })
  return { items, issues }
}

/** Validates a route list; throws when the payload is not an array at all. */
export function parseRouteList(value: unknown): {
  items: RouteDto[]
  issues: string[]
} {
  if (!Array.isArray(value)) {
    throw new Error('invalid route list: expected an array')
  }
  const items: RouteDto[] = []
  const issues: string[] = []
  value.forEach((entry, index) => {
    const issue = routeIssue(entry, index)
    if (issue) {
      issues.push(issue)
      return
    }
    items.push(entry as RouteDto)
  })
  return { items, issues }
}

export type ParsedPanelData =
  | { kind: 'table'; columns: string[]; rows: Array<Array<string | number>> }
  | { kind: 'form'; fields: PanelFormDto['fields'] }
  | { kind: 'json'; text: string }
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string }

type TableAttempt =
  | { ok: true; columns: string[]; rows: Array<Array<string | number>> }
  | { ok: false; attempted: boolean; reason: string }

/**
 * Checks the minimal structured table contract.
 *
 * `attempted` distinguishes "declared kind:'table' but malformed" (an
 * explicit invalid) from "not a table at all" (falls through to JSON).
 */
function asTable(value: unknown): TableAttempt {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, attempted: false, reason: '' }
  }
  const v = value as Record<string, unknown>
  if (v.kind !== 'table') {
    return { ok: false, attempted: false, reason: '' }
  }
  if (!Array.isArray(v.columns) || v.columns.length === 0) {
    return {
      ok: false,
      attempted: true,
      reason: 'invalid table: "columns" must be a non-empty array',
    }
  }
  if (!v.columns.every(isNonEmptyString)) {
    return {
      ok: false,
      attempted: true,
      reason: 'invalid table: every column must be a non-empty string',
    }
  }
  if (!Array.isArray(v.rows)) {
    return {
      ok: false,
      attempted: true,
      reason: 'invalid table: "rows" must be an array',
    }
  }
  for (const row of v.rows) {
    if (!Array.isArray(row)) {
      return {
        ok: false,
        attempted: true,
        reason: 'invalid table: every row must be an array',
      }
    }
    for (const cell of row) {
      if (typeof cell !== 'string' && typeof cell !== 'number') {
        return {
          ok: false,
          attempted: true,
          reason: 'invalid table: every cell must be a string or number',
        }
      }
    }
  }
  return {
    ok: true,
    columns: v.columns as string[],
    rows: v.rows as Array<Array<string | number>>,
  }
}

type FormAttempt =
  | { ok: true; fields: PanelFormDto['fields'] }
  | { ok: false; attempted: boolean; reason: string }

/** Validates the generic form contract; malformed declared forms never fall back to JSON. */
function asForm(value: unknown): FormAttempt {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, attempted: false, reason: '' }
  }
  const v = value as Record<string, unknown>
  if (v.kind !== 'form') return { ok: false, attempted: false, reason: '' }
  const invalid = (reason: string): FormAttempt => ({
    ok: false,
    attempted: true,
    reason: `invalid form: ${reason}`,
  })
  if (!Array.isArray(v.fields) || v.fields.length === 0) {
    return invalid('"fields" must be a non-empty array')
  }

  const ids = new Set<string>()
  for (const entry of v.fields) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return invalid('every field must be an object')
    }
    const field = entry as Record<string, unknown>
    if (!isNonEmptyString(field.id) || !isNonEmptyString(field.label)) {
      return invalid('field id and label must be non-empty strings')
    }
    if (ids.has(field.id)) return invalid(`duplicate field id: ${field.id}`)
    ids.add(field.id)
    if (typeof field.value !== 'string') {
      return invalid(`field ${field.id} value must be a string`)
    }
    if (field.type === 'color') {
      if (!/^#[0-9a-fA-F]{6}$/.test(field.value)) {
        return invalid(`color field ${field.id} requires #RRGGBB`)
      }
      continue
    }
    if (field.type !== 'select') {
      return invalid(`field ${field.id} has unsupported type`)
    }
    if (!Array.isArray(field.options) || field.options.length === 0) {
      return invalid(`select field ${field.id} requires options`)
    }
    const options = new Set<string>()
    for (const option of field.options) {
      if (typeof option !== 'object' || option === null) {
        return invalid(`select field ${field.id} has an invalid option`)
      }
      const item = option as Record<string, unknown>
      if (!isNonEmptyString(item.value) || !isNonEmptyString(item.label)) {
        return invalid(`select field ${field.id} has an invalid option`)
      }
      if (options.has(item.value)) {
        return invalid(`select field ${field.id} has duplicate options`)
      }
      options.add(item.value)
    }
    if (!options.has(field.value)) {
      return invalid(`select field ${field.id} value is not in options`)
    }
  }
  return { ok: true, fields: v.fields as PanelFormDto['fields'] }
}

/**
 * Classifies a panel data payload into a renderable shape.
 *
 * - table/form contract satisfied and within the size budget -> `table` / `form`
 * - undefined / null -> `empty` (the panel provides no data)
 * - declared `kind:'table'` but malformed -> `invalid` with the reason
 * - anything else -> pretty-printed JSON (primitives included)
 * - over the 32KB budget (either branch) -> `invalid`
 */
export function parsePanelData(value: unknown): ParsedPanelData {
  if (value === undefined || value === null) return { kind: 'empty' }

  const table = asTable(value)
  if (table.ok) {
    if (JSON.stringify(value).length > MAX_PANEL_DATA_CHARS) {
      return { kind: 'invalid', reason: 'panel data exceeds 32KB limit' }
    }
    return { kind: 'table', columns: table.columns, rows: table.rows }
  }
  if (table.attempted) {
    return { kind: 'invalid', reason: table.reason }
  }

  const form = asForm(value)
  if (form.ok) {
    if (JSON.stringify(value).length > MAX_PANEL_DATA_CHARS) {
      return { kind: 'invalid', reason: 'panel data exceeds 32KB limit' }
    }
    return { kind: 'form', fields: form.fields }
  }
  if (form.attempted) {
    return { kind: 'invalid', reason: form.reason }
  }

  const text = JSON.stringify(value, null, 2)
  if (text === undefined) {
    return { kind: 'invalid', reason: 'panel data is not JSON-serializable' }
  }
  if (text.length > MAX_PANEL_DATA_CHARS) {
    return { kind: 'invalid', reason: 'panel data exceeds 32KB limit' }
  }
  return { kind: 'json', text }
}

const PLUGIN_STATES = new Set<PluginRuntimeStateDto>([
  'Registered',
  'Resolved',
  'Dropped',
  'Loaded',
  'Initialized',
  'Configured',
  'Active',
  'Degraded',
  'Failed',
  'Stopped',
  'Unloaded',
  'Disposed',
  'Disabled',
])

function pluginIssue(entry: unknown, index: number): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `plugin[${index}]: not an object`
  }
  const plugin = entry as Record<string, unknown>
  for (const field of ['id', 'name', 'version', 'entry'] as const) {
    if (!isNonEmptyString(plugin[field])) {
      return `plugin[${index}]: field "${field}" must be a non-empty string`
    }
  }
  if (!['builtin', 'user', 'workspace'].includes(String(plugin.source))) {
    return `plugin[${index}]: invalid source`
  }
  if (!PLUGIN_STATES.has(plugin.state as PluginRuntimeStateDto)) {
    return `plugin[${index}]: invalid state`
  }
  for (const field of [
    'enabled',
    'builtin',
    'canUninstall',
    'restartRequired',
  ] as const) {
    if (typeof plugin[field] !== 'boolean') {
      return `plugin[${index}]: field "${field}" must be boolean`
    }
  }
  for (const field of ['tags', 'requires'] as const) {
    if (
      !Array.isArray(plugin[field]) ||
      !plugin[field].every(isNonEmptyString)
    ) {
      return `plugin[${index}]: field "${field}" must be a string array`
    }
  }
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    if (!isStringMap(plugin[field])) {
      return `plugin[${index}]: field "${field}" must be a string map`
    }
  }
  if (!isCompatibility(plugin.compatibility)) {
    return `plugin[${index}]: invalid compatibility`
  }
  for (const field of ['description', 'author', 'homepage', 'error'] as const) {
    if (plugin[field] !== undefined && typeof plugin[field] !== 'string') {
      return `plugin[${index}]: field "${field}" must be a string`
    }
  }
  const origin = originIssue(plugin.origin)
  if (origin) return `plugin[${index}]: ${origin}`
  return undefined
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(entry => typeof entry === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpsUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isSha256Text(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

/** Optional field check shared by origin/inspection/update entries. */
function optionalString(
  record: Record<string, unknown>,
  field: string,
): boolean {
  return record[field] === undefined || typeof record[field] === 'string'
}

function originIssue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return 'origin must be an object'
  if (value.kind !== 'directory' && value.kind !== 'remote') {
    return 'origin.kind must be "directory" or "remote"'
  }
  for (const field of ['url', 'sha256', 'publishedAt'] as const) {
    if (!optionalString(value, field)) {
      return `origin.${field} must be a string`
    }
  }
  if (value.url !== undefined && !isHttpsUrl(value.url)) {
    return 'origin.url must be an https URL'
  }
  if (value.sha256 !== undefined && !isSha256Text(value.sha256)) {
    return 'origin.sha256 must be 64 hexadecimal characters'
  }
  return undefined
}

function isCompatibility(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const compatibility = value as Record<string, unknown>
  return (
    isNonEmptyString(compatibility.minKernel) &&
    isNonEmptyString(compatibility.contractVersion) &&
    (compatibility.maxKernel === undefined ||
      isNonEmptyString(compatibility.maxKernel))
  )
}

export function parsePluginList(value: unknown): {
  items: PluginDetailDto[]
  issues: string[]
  restartRequired: boolean
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid plugin list: expected an object')
  }
  const list = value as Record<string, unknown>
  if (!Array.isArray(list.plugins) || !Array.isArray(list.issues)) {
    throw new Error('invalid plugin list: plugins and issues must be arrays')
  }
  const items: PluginDetailDto[] = []
  const issues = list.issues.filter(
    (issue): issue is string => typeof issue === 'string',
  )
  list.plugins.forEach((entry, index) => {
    const issue = pluginIssue(entry, index)
    if (issue) issues.push(issue)
    else items.push(entry as PluginDetailDto)
  })
  // Trust the explicit flag, but never hide a pending restart if only the
  // per-plugin projection carries it (defensive against partial responses).
  const restartRequired =
    list.restartRequired === true ||
    items.some(item => item.restartRequired === true)
  return { items, issues, restartRequired }
}

export function parsePluginOperation(value: unknown): PluginOperationResultDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid plugin operation result')
  }
  const result = value as Record<string, unknown>
  if (
    result.ok !== true ||
    typeof result.changed !== 'boolean' ||
    typeof result.restartRequired !== 'boolean' ||
    (result.message !== undefined && typeof result.message !== 'string')
  ) {
    throw new Error('invalid plugin operation result fields')
  }
  if (
    result.plugin !== undefined &&
    pluginIssue(result.plugin, 0) !== undefined
  ) {
    throw new Error('invalid plugin operation result plugin')
  }
  return {
    ok: true,
    changed: result.changed,
    restartRequired: result.restartRequired,
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.plugin !== undefined
      ? { plugin: result.plugin as unknown as PluginDetailDto }
      : {}),
  }
}

/**
 * Validates a remote inspection payload as a whole.
 *
 * Unlike a list this is one object shown in a confirmation dialog: a half-valid
 * inspection must never be rendered, so any bad field throws.
 */
export function parsePluginInspection(
  value: unknown,
): PluginRemoteInspectionDto {
  if (!isRecord(value)) {
    throw new Error('invalid remote inspection: expected an object')
  }
  for (const field of [
    'url',
    'downloadUrl',
    'id',
    'name',
    'version',
  ] as const) {
    if (!isNonEmptyString(value[field])) {
      throw new Error(`invalid remote inspection: "${field}" is required`)
    }
  }
  if (!isHttpsUrl(value.url) || !isHttpsUrl(value.downloadUrl)) {
    throw new Error('invalid remote inspection: source URLs must use https')
  }
  if (!isStringArray(value.requires)) {
    throw new Error(
      'invalid remote inspection: "requires" must be a string array',
    )
  }
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    if (!isStringMap(value[field])) {
      throw new Error(
        `invalid remote inspection: "${field}" must be a string map`,
      )
    }
  }
  if (!isCompatibility(value.compatibility)) {
    throw new Error('invalid remote inspection: "compatibility" is invalid')
  }
  for (const field of ['description', 'publishedAt', 'notes'] as const) {
    if (!optionalString(value, field)) {
      throw new Error(`invalid remote inspection: "${field}" must be a string`)
    }
  }
  if (value.sha256 !== undefined && !isSha256Text(value.sha256)) {
    throw new Error(
      'invalid remote inspection: "sha256" must be 64 hexadecimal characters',
    )
  }
  if (
    value.size !== undefined &&
    (typeof value.size !== 'number' ||
      !Number.isFinite(value.size) ||
      value.size < 0)
  ) {
    throw new Error(
      'invalid remote inspection: "size" must be a non-negative number',
    )
  }
  return value as unknown as PluginRemoteInspectionDto
}

/** One entry of an update check; a malformed entry is dropped, never rendered. */
function updateIssue(entry: unknown, index: number): string | undefined {
  if (!isRecord(entry)) return `update[${index}]: not an object`
  for (const field of [
    'pluginId',
    'currentVersion',
    'latestVersion',
  ] as const) {
    if (!isNonEmptyString(entry[field])) {
      return `update[${index}]: field "${field}" must be a non-empty string`
    }
  }
  if (typeof entry.hasUpdate !== 'boolean') {
    return `update[${index}]: field "hasUpdate" must be boolean`
  }
  if (!isHttpsUrl(entry.url)) {
    return `update[${index}]: field "url" must be an https URL`
  }
  for (const field of ['publishedAt', 'notes'] as const) {
    if (!optionalString(entry, field)) {
      return `update[${index}]: field "${field}" must be a string`
    }
  }
  if (entry.sha256 !== undefined && !isSha256Text(entry.sha256)) {
    return `update[${index}]: field "sha256" must be 64 hexadecimal characters`
  }
  return undefined
}

export function parsePluginUpdateCheck(value: unknown): {
  items: PluginUpdateDto[]
  issues: string[]
} {
  if (!isRecord(value) || !Array.isArray(value.updates)) {
    throw new Error('invalid update check: expected { updates: array }')
  }
  const items: PluginUpdateDto[] = []
  const issues: string[] = []
  value.updates.forEach((entry, index) => {
    const issue = updateIssue(entry, index)
    if (issue) issues.push(issue)
    else items.push(entry as unknown as PluginUpdateDto)
  })
  return { items, issues }
}

const DOWNLOAD_PHASES = new Set<PluginDownloadPhase>([
  'downloading',
  'verifying',
  'extracting',
  'installing',
])

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Validates one progress event; malformed events are ignored (never rendered). */
export function parseDownloadProgress(
  value: unknown,
): PluginDownloadProgressDto | undefined {
  if (!isRecord(value)) return undefined
  const { operationId, phase } = value
  if (typeof operationId !== 'string' || operationId.length === 0) {
    return undefined
  }
  if (!DOWNLOAD_PHASES.has(phase as PluginDownloadPhase)) return undefined
  if (value.receivedBytes !== undefined && !isByteCount(value.receivedBytes)) {
    return undefined
  }
  if (value.totalBytes !== undefined && !isByteCount(value.totalBytes)) {
    return undefined
  }
  return {
    operationId,
    phase: phase as PluginDownloadPhase,
    ...(value.receivedBytes !== undefined
      ? { receivedBytes: value.receivedBytes as number }
      : {}),
    ...(value.totalBytes !== undefined
      ? { totalBytes: value.totalBytes as number }
      : {}),
  }
}
