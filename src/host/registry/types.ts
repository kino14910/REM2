/**
 * Host-side Registry Index types.
 *
 * These mirror `REM2-plugins/registry/index.json` schema version 1. The parser
 * strips unknown fields, so future additive schema changes never leak into the
 * host as unvalidated data.
 */

export interface RegistryCompatibilityDeclaration {
  /** Semver range (for example `^1.0.0`) or, for legacy manifests, an exact version. */
  minKernel: string
  /** Exact semver version used as an exclusive upper bound. */
  maxKernel?: string
  contractVersion: string
}

export interface RegistryVersion {
  version: string
  tag: string
  publishedAt: string
  assetName: string
  downloadUrl: string
  sha256: string
  sizeBytes: number
  compatibility: RegistryCompatibilityDeclaration
  requires: string[]
}

export interface RegistryPlugin {
  id: string
  name: string
  description: string
  author: string
  tags: string[]
  homepage?: string
  icon?: string
  /** Newest first (strictly descending semver); `versions[0]` is the current release. */
  versions: RegistryVersion[]
}

export interface RegistryIndex {
  schemaVersion: 1
  generatedAt: string
  repository: string
  plugins: RegistryPlugin[]
}

export interface RegistryHostCompatibility {
  kernelVersion: string
  contractVersion: string
}

export type RegistryCompatibilityIssueCode =
  | 'contract-version'
  | 'min-kernel'
  | 'max-kernel'
  | 'invalid-min-kernel'
  | 'invalid-max-kernel'

export interface RegistryCompatibilityIssue {
  code: RegistryCompatibilityIssueCode
  detail: string
}

export interface RegistryVersionCompatibility {
  compatible: boolean
  issues: RegistryCompatibilityIssue[]
}
