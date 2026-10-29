import { compareVersions, parseVersion } from '../../kernel/semver/semver.js'

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '')
}

export function isNewerVersion(current: string, candidate: string): boolean {
  const normalizedCurrent = normalizeVersion(current)
  const normalizedCandidate = normalizeVersion(candidate)
  try {
    parseVersion(normalizedCurrent)
    parseVersion(normalizedCandidate)
    return compareVersions(normalizedCurrent, normalizedCandidate) === -1
  } catch {
    return false
  }
}
