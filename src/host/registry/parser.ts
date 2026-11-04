import { isValidRange } from '@/kernel/semver/range.js'
import { compareVersions, isValidVersion } from '@/kernel/semver/semver.js'

import type {
  RegistryCompatibilityDeclaration,
  RegistryIndex,
  RegistryPlugin,
  RegistryVersion,
} from './types.js'

import { RegistryClientError } from './errors.js'

/** Registry Index schema version implemented by this host. */
export const REGISTRY_SCHEMA_VERSION = 1

const ID_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/
const SHA256_RE = /^[0-9a-f]{64}$/
const REPOSITORY_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const GITHUB_ORIGIN = 'https://github.com'

interface ValidationIssue {
  path: string
  message: string
}

interface RepositoryIdentity {
  owner: string
  repo: string
}

interface DownloadExpectation {
  repository: RepositoryIdentity | null
  tag: string | null
  assetName: string | null
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message }
}

function schemaError(issues: ValidationIssue[]): RegistryClientError {
  return new RegistryClientError(
    'E_REGISTRY_SCHEMA',
    `invalid registry index:\n${issues
      .map(item => `  ${item.path}: ${item.message}`)
      .join('\n')}`,
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function readNonEmptyString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maxLength?: number,
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(issue(path, 'must be a non-empty string'))
    return null
  }
  if (maxLength !== undefined && value.length > maxLength) {
    issues.push(issue(path, `must be at most ${maxLength} characters`))
    return null
  }
  return value
}

function readPluginId(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | null {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 128 ||
    !ID_RE.test(value)
  ) {
    issues.push(
      issue(
        path,
        `invalid plugin id: ${String(value)} (use reverse-DNS lowercase segments)`,
      ),
    )
    return null
  }
  return value
}

function readVersionString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | null {
  if (typeof value !== 'string' || !isValidVersion(value)) {
    issues.push(issue(path, `invalid semver version: ${String(value)}`))
    return null
  }
  return value
}

function readStringArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue(path, 'must be an array of non-empty strings'))
    return null
  }
  const seen = new Set<string>()
  const entries: string[] = []
  let valid = true
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(issue(`${path}[${index}]`, 'must be a non-empty string'))
      valid = false
      continue
    }
    if (seen.has(entry)) {
      issues.push(issue(`${path}[${index}]`, `duplicate entry: ${entry}`))
      valid = false
      continue
    }
    seen.add(entry)
    entries.push(entry)
  }
  return valid ? entries : null
}

function readCapabilities(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue(path, 'must be an array of capability names'))
    return null
  }
  const seen = new Set<string>()
  const entries: string[] = []
  let valid = true
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !CAPABILITY_RE.test(entry)) {
      issues.push(
        issue(`${path}[${index}]`, `invalid capability name: ${String(entry)}`),
      )
      valid = false
      continue
    }
    if (seen.has(entry)) {
      issues.push(issue(`${path}[${index}]`, `duplicate capability: ${entry}`))
      valid = false
      continue
    }
    seen.add(entry)
    entries.push(entry)
  }
  return valid ? entries : null
}

function readCompatibility(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): RegistryCompatibilityDeclaration | null {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'must be an object'))
    return null
  }

  const minKernel = readNonEmptyString(
    value.minKernel,
    `${path}.minKernel`,
    issues,
  )
  if (
    minKernel !== null &&
    !isValidRange(minKernel) &&
    !isValidVersion(minKernel)
  ) {
    issues.push(
      issue(
        `${path}.minKernel`,
        `is neither a valid range nor a valid version: ${minKernel}`,
      ),
    )
  }

  let maxKernel: string | undefined
  let maxKernelValid = true
  if (value.maxKernel !== undefined) {
    if (
      typeof value.maxKernel === 'string' &&
      isValidVersion(value.maxKernel)
    ) {
      maxKernel = value.maxKernel
    } else {
      issues.push(
        issue(
          `${path}.maxKernel`,
          `invalid exact semver version: ${String(value.maxKernel)}`,
        ),
      )
      maxKernelValid = false
    }
  }

  const contractVersion = readNonEmptyString(
    value.contractVersion,
    `${path}.contractVersion`,
    issues,
  )

  if (minKernel === null || contractVersion === null || !maxKernelValid) {
    return null
  }
  return {
    minKernel,
    ...(maxKernel === undefined ? {} : { maxKernel }),
    contractVersion,
  }
}

function readDownloadUrl(
  value: unknown,
  expectation: DownloadExpectation,
  path: string,
  issues: ValidationIssue[],
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(issue(path, 'must be a non-empty URL string'))
    return null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    issues.push(issue(path, 'must be an absolute URL'))
    return null
  }
  if (
    url.origin !== GITHUB_ORIGIN ||
    url.username !== '' ||
    url.password !== ''
  ) {
    issues.push(
      issue(path, `must be an https://github.com release asset URL: ${value}`),
    )
    return null
  }

  const rawSegments = url.pathname.split('/')
  let segments: string[]
  try {
    segments = rawSegments.map(segment => decodeURIComponent(segment))
  } catch {
    issues.push(issue(path, 'contains an invalid escaped path'))
    return null
  }

  if (
    segments.length !== 7 ||
    segments[0] !== '' ||
    segments[3] !== 'releases' ||
    segments[4] !== 'download'
  ) {
    issues.push(issue(path, `must point at a GitHub release asset: ${value}`))
    return null
  }

  const [, owner, repo, , , tag, assetName] = segments
  if (
    owner === undefined ||
    repo === undefined ||
    tag === undefined ||
    assetName === undefined
  ) {
    issues.push(issue(path, `must point at a GitHub release asset: ${value}`))
    return null
  }

  if (
    expectation.repository !== null &&
    (owner.toLowerCase() !== expectation.repository.owner.toLowerCase() ||
      repo.toLowerCase() !== expectation.repository.repo.toLowerCase())
  ) {
    issues.push(
      issue(
        path,
        `must belong to ${expectation.repository.owner}/${expectation.repository.repo}`,
      ),
    )
  }
  if (expectation.tag !== null && tag !== expectation.tag) {
    issues.push(issue(path, `tag segment must be ${expectation.tag}`))
  }
  if (expectation.assetName !== null && assetName !== expectation.assetName) {
    issues.push(
      issue(path, `must end with the asset name ${expectation.assetName}`),
    )
  }

  return value
}

function readVersion(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  repository: RepositoryIdentity | null,
): RegistryVersion | null {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'version entries must be objects'))
    return null
  }

  const version = readVersionString(value.version, `${path}.version`, issues)

  let tag: string | null = null
  if (typeof value.tag !== 'string' || value.tag.trim() === '') {
    issues.push(issue(`${path}.tag`, 'must be a non-empty release tag'))
  } else if (version === null || !value.tag.endsWith(`-v${version}`)) {
    issues.push(issue(`${path}.tag`, 'tag must be `<plugin-dir>-v<version>`'))
  } else {
    tag = value.tag
  }

  const publishedAt = isIsoTimestamp(value.publishedAt)
    ? value.publishedAt
    : null
  if (publishedAt === null) {
    issues.push(issue(`${path}.publishedAt`, 'must be an ISO-8601 timestamp'))
  }

  let assetName: string | null = null
  if (
    typeof value.assetName !== 'string' ||
    value.assetName.trim() === '' ||
    !value.assetName.toLowerCase().endsWith('.zip')
  ) {
    issues.push(
      issue(`${path}.assetName`, 'must be the release .zip asset name'),
    )
  } else if (version === null || !value.assetName.endsWith(`-${version}.zip`)) {
    issues.push(
      issue(
        `${path}.assetName`,
        'asset name must be `<plugin-dir>-<version>.zip`',
      ),
    )
  } else {
    assetName = value.assetName
  }

  const downloadUrl = readDownloadUrl(
    value.downloadUrl,
    { repository, tag, assetName },
    `${path}.downloadUrl`,
    issues,
  )

  const sha256 =
    typeof value.sha256 === 'string' && SHA256_RE.test(value.sha256)
      ? value.sha256
      : null
  if (sha256 === null) {
    issues.push(
      issue(
        `${path}.sha256`,
        'must contain 64 lowercase hexadecimal characters',
      ),
    )
  }

  const sizeBytes =
    typeof value.sizeBytes === 'number' &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 0
      ? value.sizeBytes
      : null
  if (sizeBytes === null) {
    issues.push(issue(`${path}.sizeBytes`, 'must be a positive integer'))
  }

  const compatibility = readCompatibility(
    value.compatibility,
    `${path}.compatibility`,
    issues,
  )
  const requires = readCapabilities(value.requires, `${path}.requires`, issues)

  if (
    version === null ||
    tag === null ||
    publishedAt === null ||
    assetName === null ||
    downloadUrl === null ||
    sha256 === null ||
    sizeBytes === null ||
    compatibility === null ||
    requires === null
  ) {
    return null
  }

  return {
    version,
    tag,
    publishedAt,
    assetName,
    downloadUrl,
    sha256,
    sizeBytes,
    compatibility,
    requires,
  }
}

function readVersions(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  repository: RepositoryIdentity | null,
): RegistryVersion[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue(path, 'must contain at least one release'))
    return null
  }

  const versions: RegistryVersion[] = []
  let valid = true
  for (const [index, entry] of value.entries()) {
    const parsed = readVersion(entry, `${path}[${index}]`, issues, repository)
    if (parsed === null) valid = false
    else versions.push(parsed)
  }
  if (!valid) return null

  for (let index = 1; index < versions.length; index += 1) {
    const previous = versions[index - 1]
    const current = versions[index]
    if (
      previous !== undefined &&
      current !== undefined &&
      compareVersions(previous.version, current.version) <= 0
    ) {
      issues.push(
        issue(
          `${path}[${index}]`,
          'versions must be sorted by version descending',
        ),
      )
      return null
    }
  }

  return versions
}

function readPlugin(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  repository: RepositoryIdentity | null,
  seenIds: Set<string>,
): RegistryPlugin | null {
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'plugin entries must be objects'))
    return null
  }

  let id = readPluginId(value.id, `${path}.id`, issues)
  if (id !== null) {
    if (seenIds.has(id)) {
      issues.push(issue(`${path}.id`, `duplicate plugin id: ${id}`))
      id = null
    } else {
      seenIds.add(id)
    }
  }

  const name = readNonEmptyString(value.name, `${path}.name`, issues, 64)
  const description = readNonEmptyString(
    value.description,
    `${path}.description`,
    issues,
    512,
  )
  const author = readNonEmptyString(value.author, `${path}.author`, issues)

  const tags = readStringArray(value.tags, `${path}.tags`, issues)
  const versions = readVersions(
    value.versions,
    `${path}.versions`,
    issues,
    repository,
  )

  let homepage: string | undefined
  let optionalFieldsValid = true
  if (value.homepage !== undefined) {
    if (typeof value.homepage === 'string' && isHttpUrl(value.homepage)) {
      homepage = value.homepage
    } else {
      issues.push(issue(`${path}.homepage`, 'must be an absolute http(s) URL'))
      optionalFieldsValid = false
    }
  }

  let icon: string | undefined
  if (value.icon !== undefined) {
    if (typeof value.icon === 'string') {
      icon = value.icon
    } else {
      issues.push(issue(`${path}.icon`, 'must be a string'))
      optionalFieldsValid = false
    }
  }

  if (
    id === null ||
    name === null ||
    description === null ||
    author === null ||
    tags === null ||
    versions === null ||
    !optionalFieldsValid
  ) {
    return null
  }

  return {
    id,
    name,
    description,
    author,
    tags,
    versions,
    ...(homepage === undefined ? {} : { homepage }),
    ...(icon === undefined ? {} : { icon }),
  }
}

/**
 * Validate an already-parsed registry index.
 *
 * Unknown fields are deliberately ignored so additive schema evolution stays
 * safe; every known field is checked and normalized into a fresh DTO, so the
 * caller never receives unvalidated remote data.
 */
export function parseRegistryIndex(value: unknown): RegistryIndex {
  if (!isPlainObject(value)) {
    throw schemaError([issue('$', 'registry index must be a JSON object')])
  }

  if (
    typeof value.schemaVersion !== 'number' ||
    !Number.isInteger(value.schemaVersion)
  ) {
    throw schemaError([
      issue(
        '$.schemaVersion',
        `must be the integer ${REGISTRY_SCHEMA_VERSION}`,
      ),
    ])
  }
  if (value.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistryClientError(
      'E_REGISTRY_SCHEMA_VERSION',
      `unsupported registry schemaVersion: ${value.schemaVersion}; this host implements ${REGISTRY_SCHEMA_VERSION}`,
    )
  }

  const issues: ValidationIssue[] = []

  const generatedAt = isIsoTimestamp(value.generatedAt)
    ? value.generatedAt
    : null
  if (generatedAt === null) {
    issues.push(issue('$.generatedAt', 'must be an ISO-8601 timestamp'))
  }

  let repository: string | null = null
  let identity: RepositoryIdentity | null = null
  if (
    typeof value.repository !== 'string' ||
    !REPOSITORY_RE.test(value.repository)
  ) {
    issues.push(
      issue('$.repository', 'must be https://github.com/<owner>/<repo>'),
    )
  } else {
    repository = value.repository
    const match = REPOSITORY_RE.exec(value.repository)
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      identity = { owner: match[1], repo: match[2] }
    }
  }

  let plugins: RegistryPlugin[] | null = null
  if (!Array.isArray(value.plugins)) {
    issues.push(issue('$.plugins', 'must be an array'))
  } else {
    const seenIds = new Set<string>()
    const parsedPlugins: RegistryPlugin[] = []
    for (const [index, entry] of value.plugins.entries()) {
      const parsed = readPlugin(
        entry,
        `$.plugins[${index}]`,
        issues,
        identity,
        seenIds,
      )
      if (parsed !== null) parsedPlugins.push(parsed)
    }
    plugins = parsedPlugins
  }

  if (issues.length > 0) throw schemaError(issues)
  if (generatedAt === null || repository === null || plugins === null) {
    throw schemaError([issue('$', 'registry index is incomplete')])
  }

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt,
    repository,
    plugins,
  }
}

/** Parse registry index JSON text; syntax errors are reported separately from schema errors. */
export function parseRegistryIndexJson(text: string): RegistryIndex {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new RegistryClientError(
      'E_REGISTRY_PARSE',
      'registry index is not valid JSON',
      { cause: error },
    )
  }
  return parseRegistryIndex(value)
}
