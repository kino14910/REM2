import { describe, expect, it } from 'vitest'

import type { LifecyclePhase } from '@/kernel/contracts/lifecycle.js'

import {
  PHASES,
  START_PHASES,
  STOP_PHASES,
  isLegalTransition,
  phaseDef,
  phaseIndex,
} from '@/kernel/lifecycle/phases.js'

const START = START_PHASES as readonly LifecyclePhase[]
const STOP = STOP_PHASES as readonly LifecyclePhase[]

describe('phases · table consistency', () => {
  it('START_PHASES and STOP_PHASES partition PHASES in order', () => {
    expect(PHASES.map(p => p.phase)).toEqual([...START, ...STOP])
  })

  it('declares every phase exactly once', () => {
    const names = PHASES.map(p => p.phase)

    expect(new Set(names).size).toBe(names.length)
  })

  it('phaseIndex matches the declaration order', () => {
    PHASES.forEach((def, index) => {
      expect(phaseIndex(def.phase)).toBe(index)
    })
  })

  it('phaseDef returns the same entry as the table', () => {
    for (const def of PHASES) {
      expect(phaseDef(def.phase)).toBe(def)
    }
  })

  it('reports -1 / undefined for a phase outside the sequence', () => {
    expect(phaseIndex('Degraded')).toBe(-1)
    expect(phaseDef('Degraded')).toBeUndefined()
    expect(phaseIndex('Nope' as LifecyclePhase)).toBe(-1)
  })

  it('marks only Configured as a start-timeout phase and stop phases as stop-timeout', () => {
    expect(
      PHASES.filter(p => p.timeoutKind === 'start').map(p => p.phase),
    ).toEqual(['Configured'])
    expect(
      PHASES.filter(p => p.timeoutKind === 'stop').map(p => p.phase),
    ).toEqual([...STOP])
  })
})

describe('phases · legal transitions', () => {
  it.each([
    ['Registered', 'Loaded'],
    ['Loaded', 'Initialized'],
    ['Initialized', 'Configured'],
    ['Registered', 'Configured'],
  ] as const)('advances forward: %s -> %s', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true)
  })

  it.each([
    ['Loaded', 'Registered'],
    ['Configured', 'Loaded'],
    ['Initialized', 'Registered'],
  ] as const)('rejects regression: %s -> %s', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(false)
  })

  it.each([...START, ...STOP])('%s may enter the stop sequence', from => {
    for (const to of STOP) {
      expect(isLegalTransition(from, to)).toBe(true)
    }
  })

  it.each([...START, ...STOP])('%s may become Degraded', from => {
    expect(isLegalTransition(from, 'Degraded')).toBe(true)
  })

  it('from Degraded only the stop sequence is reachable', () => {
    for (const to of START) {
      expect(isLegalTransition('Degraded', to)).toBe(false)
    }
    for (const to of STOP) {
      expect(isLegalTransition('Degraded', to)).toBe(true)
    }
  })

  it('rejects a target outside the sequence', () => {
    expect(isLegalTransition('Loaded', 'Nope' as LifecyclePhase)).toBe(false)
    expect(isLegalTransition('Degraded', 'Nope' as LifecyclePhase)).toBe(false)
  })

  it('treats an unknown source as a fresh start into any known phase', () => {
    expect(isLegalTransition('Nope' as LifecyclePhase, 'Loaded')).toBe(true)
    expect(isLegalTransition('Nope' as LifecyclePhase, 'Disposed')).toBe(true)
  })
})
