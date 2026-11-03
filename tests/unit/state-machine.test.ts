import { describe, expect, it } from 'vitest'

import type { PluginStateT } from '@/kernel/contracts/plugins.js'

import {
  PHASE_OF_STATE,
  TRANSITIONS,
  canTransition,
  stateOrdinal,
} from '@/kernel/state-machine.js'

const ALL_STATES: PluginStateT[] = [
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
]

describe('state-machine · transition table', () => {
  it('declares an entry for every state', () => {
    expect(Object.keys(TRANSITIONS).toSorted()).toEqual(ALL_STATES.toSorted())
  })

  it('accepts the documented happy path', () => {
    const path: Array<[PluginStateT, PluginStateT]> = [
      ['Registered', 'Resolved'],
      ['Resolved', 'Loaded'],
      ['Loaded', 'Initialized'],
      ['Initialized', 'Configured'],
      ['Configured', 'Active'],
      ['Active', 'Stopped'],
      ['Stopped', 'Unloaded'],
      ['Unloaded', 'Disposed'],
    ]

    for (const [from, to] of path) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true)
    }
  })

  it('allows recovery transitions out of Failed and Degraded', () => {
    expect(canTransition('Failed', 'Stopped')).toBe(true)
    expect(canTransition('Degraded', 'Active')).toBe(true)
    expect(canTransition('Active', 'Degraded')).toBe(true)
  })

  it('treats Dropped and Disposed as terminal', () => {
    expect(TRANSITIONS.Dropped).toEqual([])
    expect(TRANSITIONS.Disposed).toEqual([])
    expect(canTransition('Dropped', 'Resolved')).toBe(false)
    expect(canTransition('Disposed', 'Loaded')).toBe(false)
  })

  it('rejects skipping a phase', () => {
    expect(canTransition('Registered', 'Active')).toBe(false)
    expect(canTransition('Loaded', 'Configured')).toBe(false)
    expect(canTransition('Resolved', 'Disposed')).toBe(false)
  })

  it('rejects moving backwards', () => {
    expect(canTransition('Active', 'Loaded')).toBe(false)
    expect(canTransition('Configured', 'Initialized')).toBe(false)
  })

  it('rejects self-transitions', () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, state), state).toBe(false)
    }
  })
})

describe('state-machine · stateOrdinal', () => {
  it('numbers states in declaration order', () => {
    ALL_STATES.forEach((state, index) => {
      expect(stateOrdinal(state)).toBe(index)
    })
  })

  it('returns -1 for an unknown state', () => {
    expect(stateOrdinal('Nope' as PluginStateT)).toBe(-1)
  })
})

describe('state-machine · PHASE_OF_STATE', () => {
  it('maps every state to a phase', () => {
    for (const state of ALL_STATES) {
      expect(typeof PHASE_OF_STATE[state]).toBe('string')
    }
  })

  it('folds Dropped into Registered and Failed into Degraded', () => {
    expect(PHASE_OF_STATE.Dropped).toBe('Registered')
    expect(PHASE_OF_STATE.Failed).toBe('Degraded')
  })
})
