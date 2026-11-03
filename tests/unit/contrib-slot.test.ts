import { describe, expect, it } from 'vitest'

import {
  MultiContributionSlot,
  SingleContributionSlot,
  type SlotEntry,
} from '@/kernel/extensions/contrib-slot.js'

function entry(
  contributionId: string,
  pluginId = 'com.rem2.p',
  impl: unknown = contributionId,
): SlotEntry<unknown> {
  return { contributionId, pluginId, impl }
}

describe('contrib-slot · MultiContributionSlot', () => {
  it('keeps contributions in insertion order', () => {
    const slot = new MultiContributionSlot<unknown>()
    slot.add(entry('b'))
    slot.add(entry('a'))

    expect(slot.list().map(e => e.contributionId)).toEqual(['b', 'a'])
    expect(slot.impls()).toEqual(['b', 'a'])
  })

  it('treats a duplicate contributionId as an overwrite', () => {
    const slot = new MultiContributionSlot<unknown>()
    slot.add(entry('a', 'com.rem2.p', 'first'))
    slot.add(entry('a', 'com.rem2.p', 'second'))

    expect(slot.size).toBe(1)
    expect(slot.impls()).toEqual(['second'])
  })

  it('removes a known contribution and reports it', () => {
    const slot = new MultiContributionSlot<unknown>()
    slot.add(entry('a'))

    expect(slot.remove('a')).toBe(true)
    expect(slot.remove('a')).toBe(false)
    expect(slot.has('a')).toBe(false)
    expect(slot.size).toBe(0)
  })

  it('returns a snapshot that does not alias internal state', () => {
    const slot = new MultiContributionSlot<unknown>()
    slot.add(entry('a'))

    const snapshot = slot.list() as SlotEntry<unknown>[]
    snapshot.push(entry('ghost'))

    expect(slot.size).toBe(1)
  })

  it('retracts every contribution of one plugin only', () => {
    const slot = new MultiContributionSlot<unknown>()
    slot.add(entry('a1', 'com.rem2.a'))
    slot.add(entry('b1', 'com.rem2.b'))
    slot.add(entry('a2', 'com.rem2.a'))

    const removed = slot.retractPlugin('com.rem2.a')

    expect(removed.toSorted()).toEqual(['a1', 'a2'])
    expect(slot.list().map(e => e.contributionId)).toEqual(['b1'])
  })

  it('retracting an unknown plugin is a no-op', () => {
    const slot = new MultiContributionSlot<unknown>()
    slot.add(entry('a', 'com.rem2.a'))

    expect(slot.retractPlugin('com.rem2.nobody')).toEqual([])
    expect(slot.size).toBe(1)
  })

  it('forgets the plugin index once its last contribution is gone', () => {
    const slot = new MultiContributionSlot<unknown>()
    slot.add(entry('a', 'com.rem2.a'))
    slot.remove('a')

    expect(slot.retractPlugin('com.rem2.a')).toEqual([])
  })
})

describe('contrib-slot · SingleContributionSlot', () => {
  it('starts empty', () => {
    const slot = new SingleContributionSlot<unknown>()

    expect(slot.isEmpty).toBe(true)
    expect(slot.active).toBeUndefined()
    expect(slot.activeId).toBeUndefined()
    expect(slot.activePluginId).toBeUndefined()
  })

  it('replace overwrites unconditionally and returns the previous entry', () => {
    const slot = new SingleContributionSlot<unknown>()
    slot.replace(entry('first'))

    const previous = slot.replace(entry('second', 'com.rem2.q'))

    expect(previous?.contributionId).toBe('first')
    expect(slot.activeId).toBe('second')
    expect(slot.activePluginId).toBe('com.rem2.q')
    expect(slot.isEmpty).toBe(false)
  })

  it('replace on an empty slot returns null', () => {
    const slot = new SingleContributionSlot<unknown>()

    expect(slot.replace(entry('a'))).toBeNull()
  })

  it('trySet accepts the first entry and rejects later ones', () => {
    const slot = new SingleContributionSlot<unknown>()

    expect(slot.trySet(entry('first'))).toBe(true)
    expect(slot.trySet(entry('second'))).toBe(false)
    expect(slot.activeId).toBe('first')
  })

  it('remove only clears a matching contributionId', () => {
    const slot = new SingleContributionSlot<unknown>()
    slot.replace(entry('a'))

    expect(slot.remove('b')).toBe(false)
    expect(slot.activeId).toBe('a')
    expect(slot.remove('a')).toBe(true)
    expect(slot.isEmpty).toBe(true)
  })

  it('retractPlugin only clears a matching pluginId', () => {
    const slot = new SingleContributionSlot<unknown>()
    slot.replace(entry('a', 'com.rem2.a'))

    expect(slot.retractPlugin('com.rem2.b')).toBe(false)
    expect(slot.activeId).toBe('a')
    expect(slot.retractPlugin('com.rem2.a')).toBe(true)
    expect(slot.isEmpty).toBe(true)
  })

  it('remove and retractPlugin are no-ops on an empty slot', () => {
    const slot = new SingleContributionSlot<unknown>()

    expect(slot.remove('a')).toBe(false)
    expect(slot.retractPlugin('com.rem2.a')).toBe(false)
  })
})
