/**
 * Hand-written zero-dependency manifest validator.
 *
 * No zod / ajv - the kernel must have zero third-party runtime dependencies
 * (B.2 red line). The validator stays semantically in sync with
 * `manifest.schema.json` and is covered by unit tests.
 */

import type {
  PluginManifest,
  ManifestContribution,
} from '../contracts/manifest.js'
import { EXTENSION_POINT_IDS } from '../extensions/definitions.js'
import { isValidRange } from '../semver/range.js'
import { isValidVersion } from '../semver/semver.js'

export interface ManifestValidationIssue {
  path: string
  message: string
}

export interface ManifestValidationResult {
  ok: boolean
  issues: ManifestValidationIssue[]
  /** The normalized manifest, returned when validation passes. */
  value?: PluginManifest
}

/**
 * Plugin id: reverse-DNS style, lowercase letters/digits, segments separated
 * by `.` / `_` / `-`.
 *
 * Each segment must be non-empty - the legacy pattern
 * `^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$` would accept consecutive separators
 * like `bad..id`. With "segment = [a-z0-9]+, separator = [._-]", consecutive
 * separators are rejected.
 */
const ID_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/
const CAP_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** entry must be a build artifact only: eliminates the dev/prod dual form. */
const ENTRY_RE = /\.(js|mjs)$/

/** Set of declared extension point ids (from `extensions/definitions.ts`, single source of truth). */
const KNOWN_POINTS: ReadonlySet<string> = new Set(EXTENSION_POINT_IDS)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}

/**
 * Validate that a raw object satisfies the PluginManifest contract.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = []

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [{ path: '$', message: 'manifest must be an object' }],
    }
  }

  const obj = raw

  if (typeof obj.id !== 'string' || obj.id.length < 3) {
    issues.push({
      path: '$.id',
      message: 'id must be a string with at least 3 characters',
    })
  } else if (!ID_RE.test(obj.id)) {
    issues.push({
      path: '$.id',
      message: `invalid id format: ${obj.id} (reverse-DNS recommended)`,
    })
  }

  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    issues.push({ path: '$.name', message: 'name must be a non-empty string' })
  }

  if (
    typeof obj.version !== 'string' ||
    !VERSION_RE.test(obj.version) ||
    !isValidVersion(obj.version)
  ) {
    issues.push({
      path: '$.version',
      message: `invalid version (semver required): ${String(obj.version)}`,
    })
  }

  // entry must be a build artifact (.js / .mjs) - the type-level enforcement of "same shape in dev and prod".
  if (typeof obj.entry !== 'string' || obj.entry.trim() === '') {
    issues.push({
      path: '$.entry',
      message: 'entry must be a non-empty string',
    })
  } else if (!ENTRY_RE.test(obj.entry)) {
    issues.push({
      path: '$.entry',
      message: `entry must be a build artifact (ending in .js or .mjs): ${obj.entry}`,
    })
  }

  const compat = obj.compatibility
  if (!isPlainObject(compat)) {
    issues.push({
      path: '$.compatibility',
      message: 'compatibility must be present and be an object',
    })
  } else {
    if (
      typeof compat.minKernel !== 'string' ||
      compat.minKernel.trim() === ''
    ) {
      issues.push({
        path: '$.compatibility.minKernel',
        message: 'minKernel must be a non-empty string',
      })
    } else if (
      !isValidRange(compat.minKernel) &&
      !isValidVersion(compat.minKernel)
    ) {
      issues.push({
        path: '$.compatibility.minKernel',
        message: `minKernel is neither a valid range nor a valid version: ${compat.minKernel}`,
      })
    }
    if (compat.maxKernel !== undefined) {
      if (
        typeof compat.maxKernel !== 'string' ||
        !isValidVersion(compat.maxKernel)
      ) {
        issues.push({
          path: '$.compatibility.maxKernel',
          message: `invalid maxKernel: ${String(compat.maxKernel)}`,
        })
      }
    }
    if (
      typeof compat.contractVersion !== 'string' ||
      compat.contractVersion.trim() === ''
    ) {
      issues.push({
        path: '$.compatibility.contractVersion',
        message: 'contractVersion must be a non-empty string',
      })
    }
  }

  validateDepMap(obj.dependencies, '$.dependencies', issues)
  validateDepMap(obj.optionalDependencies, '$.optionalDependencies', issues)

  // requires (what this plugin needs)
  if (obj.requires !== undefined) {
    if (!Array.isArray(obj.requires)) {
      issues.push({ path: '$.requires', message: 'requires must be an array' })
    } else {
      const seen = new Set<string>()
      obj.requires.forEach((cap, i) => {
        if (typeof cap !== 'string' || !CAP_RE.test(cap)) {
          issues.push({
            path: `$.requires[${i}]`,
            message: `invalid capability name: ${String(cap)}`,
          })
        } else if (seen.has(cap)) {
          issues.push({
            path: `$.requires[${i}]`,
            message: `duplicate capability: ${cap}`,
          })
        } else {
          seen.add(cap)
        }
      })
    }
  }

  // contributes (what this plugin provides): point must be a declared extension point id
  if (obj.contributes !== undefined) {
    if (!Array.isArray(obj.contributes)) {
      issues.push({
        path: '$.contributes',
        message: 'contributes must be an array',
      })
    } else {
      const seen = new Set<string>()
      obj.contributes.forEach((raw, i) => {
        if (!isPlainObject(raw)) {
          issues.push({
            path: `$.contributes[${i}]`,
            message: 'contributes entries must be objects',
          })
          return
        }
        const point = raw.point
        const cid = raw.id
        if (typeof point !== 'string' || !KNOWN_POINTS.has(point)) {
          issues.push({
            path: `$.contributes[${i}].point`,
            message: `undeclared extension point: ${String(point)}`,
          })
        }
        if (typeof cid !== 'string' || cid.trim() === '') {
          issues.push({
            path: `$.contributes[${i}].id`,
            message: 'contributes[].id must be a non-empty string',
          })
        }
        if (
          raw.capability !== undefined &&
          typeof raw.capability !== 'string'
        ) {
          issues.push({
            path: `$.contributes[${i}].capability`,
            message: 'capability must be a string',
          })
        }
        const key = `${String(point)}#${String(cid)}`
        if (seen.has(key)) {
          issues.push({
            path: `$.contributes[${i}]`,
            message: `duplicate contribution slot: ${key}`,
          })
        } else {
          seen.add(key)
        }
      })
    }
  }

  // capabilities was renamed to requires; its presence marks an outdated field (breaking change, not silently ignored).
  if (obj.capabilities !== undefined) {
    issues.push({
      path: '$.capabilities',
      message:
        'capabilities has been renamed: use contributes to provide and requires to declare needs',
    })
  }

  for (const field of ['author', 'description', 'icon', 'homepage'] as const) {
    if (obj[field] !== undefined && typeof obj[field] !== 'string') {
      issues.push({ path: `$.${field}`, message: `${field} must be a string` })
    }
  }

  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || obj.tags.some(t => typeof t !== 'string')) {
      issues.push({
        path: '$.tags',
        message: 'tags must be an array of strings',
      })
    }
  }

  if (obj.isolation !== undefined) {
    if (obj.isolation !== 'in-process' && obj.isolation !== 'worker') {
      issues.push({
        path: '$.isolation',
        message: `invalid isolation: ${String(obj.isolation)} (allowed: 'in-process' | 'worker')`,
      })
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues }
  }

  return { ok: true, issues: [], value: normalizeManifest(obj) }
}

function validateDepMap(
  value: unknown,
  path: string,
  issues: ManifestValidationIssue[],
): void {
  if (value === undefined) return
  if (!isPlainObject(value)) {
    issues.push({ path, message: 'must be an object (pluginId -> range)' })
    return
  }
  for (const [depId, range] of Object.entries(value)) {
    if (!ID_RE.test(depId)) {
      issues.push({
        path: `${path}.${depId}`,
        message: `invalid dependency id: ${depId}`,
      })
    }
    if (typeof range !== 'string' || range.trim() === '') {
      issues.push({
        path: `${path}.${depId}`,
        message: 'dependency range must be a non-empty string',
      })
    } else if (!isValidRange(range) && !isValidVersion(range)) {
      issues.push({
        path: `${path}.${depId}`,
        message: `invalid dependency range: ${range}`,
      })
    }
  }
}

/** Normalize a raw object into a PluginManifest (fills in defaults for optional fields). */
function normalizeManifest(obj: Record<string, unknown>): PluginManifest {
  const compat = obj.compatibility as Record<string, unknown>
  const manifest: PluginManifest = {
    id: String(obj.id),
    name: String(obj.name),
    version: String(obj.version),
    entry: String(obj.entry),
    compatibility: {
      minKernel: String(compat.minKernel),
      contractVersion: String(compat.contractVersion),
      ...(compat.maxKernel !== undefined
        ? { maxKernel: String(compat.maxKernel) }
        : {}),
    },
  }

  if (isPlainObject(obj.dependencies)) {
    manifest.dependencies = toStringMap(obj.dependencies)
  }
  if (isPlainObject(obj.optionalDependencies)) {
    manifest.optionalDependencies = toStringMap(obj.optionalDependencies)
  }
  if (Array.isArray(obj.requires)) {
    manifest.requires = obj.requires.map(c => String(c))
  }
  if (Array.isArray(obj.contributes)) {
    manifest.contributes = obj.contributes.map(c => {
      const raw = c as Record<string, unknown>
      const item: ManifestContribution = {
        point: String(raw.point),
        id: String(raw.id),
      }
      return raw.capability !== undefined
        ? { ...item, capability: String(raw.capability) }
        : item
    })
  }
  if (typeof obj.author === 'string') manifest.author = obj.author
  if (typeof obj.description === 'string')
    manifest.description = obj.description
  if (typeof obj.icon === 'string') manifest.icon = obj.icon
  if (typeof obj.homepage === 'string') manifest.homepage = obj.homepage
  if (Array.isArray(obj.tags)) manifest.tags = obj.tags.map(t => String(t))
  if (obj.isolation === 'in-process' || obj.isolation === 'worker') {
    manifest.isolation = obj.isolation
  }
  if (isPlainObject(obj.configSchema)) manifest.configSchema = obj.configSchema

  return manifest
}

function toStringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = String(v)
  }
  return out
}
