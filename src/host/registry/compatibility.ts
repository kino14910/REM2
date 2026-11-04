import { isValidRange, satisfies } from '@/kernel/semver/range.js'
import {
  compare,
  isValidVersion,
  parseVersion,
} from '@/kernel/semver/semver.js'

import type {
  RegistryCompatibilityIssue,
  RegistryHostCompatibility,
  RegistryVersion,
  RegistryVersionCompatibility,
} from './types.js'

import { RegistryClientError } from './errors.js'

/** Extract the contract major version (e.g. `1` / `1.0` / `1.2` -> 1). */
function contractMajor(value: string): number | null {
  const head = value.split('.')[0]?.trim() ?? ''
  if (!/^\d+$/.test(head)) return null
  return Number(head)
}

/**
 * Check whether one registry version can run on this host.
 *
 * Structural validity is checked by the parser; this function only answers the
 * compatibility question, and does so with the kernel's own semver semantics
 * instead of a second implementation.
 */
export function evaluateRegistryVersionCompatibility(
  version: Pick<RegistryVersion, 'version' | 'compatibility'>,
  host: RegistryHostCompatibility,
): RegistryVersionCompatibility {
  let kernel
  try {
    kernel = parseVersion(host.kernelVersion)
  } catch (error) {
    throw new RegistryClientError(
      'E_REGISTRY_COMPATIBILITY',
      `invalid host kernel version: ${host.kernelVersion}`,
      { cause: error },
    )
  }

  const hostMajor = contractMajor(host.contractVersion)
  if (hostMajor === null) {
    throw new RegistryClientError(
      'E_REGISTRY_COMPATIBILITY',
      `invalid host contract version: ${host.contractVersion}`,
    )
  }

  const issues: RegistryCompatibilityIssue[] = []
  const declared = version.compatibility

  const pluginMajor = contractMajor(declared.contractVersion)
  if (pluginMajor === null || pluginMajor !== hostMajor) {
    issues.push({
      code: 'contract-version',
      detail: `contract version incompatible: kernel ${host.contractVersion}, plugin ${declared.contractVersion}`,
    })
  }

  if (
    !isValidRange(declared.minKernel) &&
    !isValidVersion(declared.minKernel)
  ) {
    issues.push({
      code: 'invalid-min-kernel',
      detail: `minKernel is neither a valid range nor a valid version: ${declared.minKernel}`,
    })
  } else if (!satisfies(host.kernelVersion, declared.minKernel)) {
    issues.push({
      code: 'min-kernel',
      detail: `kernel version too low: requires ${declared.minKernel}, kernel ${host.kernelVersion}`,
    })
  }

  if (declared.maxKernel !== undefined) {
    if (!isValidVersion(declared.maxKernel)) {
      issues.push({
        code: 'invalid-max-kernel',
        detail: `invalid maxKernel: ${declared.maxKernel}`,
      })
    } else if (compare(kernel, parseVersion(declared.maxKernel)) >= 0) {
      issues.push({
        code: 'max-kernel',
        detail: `kernel version too high: max ${declared.maxKernel} (exclusive), kernel ${host.kernelVersion}`,
      })
    }
  }

  return { compatible: issues.length === 0, issues }
}
