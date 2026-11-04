import { describe, expect, it } from 'vitest'

import {
  WILDCARD_BUCKET,
  bucketKeyOf,
  bucketKeyOfEvent,
  matches,
  specificity,
  splitSegments,
} from '@/kernel/events/pattern.js'

describe('pattern · splitSegments', () => {
  it('splits on both separators', () => {
    expect(splitSegments('kernel.plugin.started')).toEqual([
      'kernel',
      'plugin',
      'started',
    ])
    expect(splitSegments('command:execute')).toEqual(['command', 'execute'])
    expect(splitSegments('a:b.c')).toEqual(['a', 'b', 'c'])
  })

  it('merges consecutive separators and drops leading/trailing ones', () => {
    expect(splitSegments('a::b..c')).toEqual(['a', 'b', 'c'])
    expect(splitSegments(':a:')).toEqual(['a'])
    expect(splitSegments('')).toEqual([])
  })
})

describe('pattern · exact and single-segment wildcards', () => {
  it('matches identical names', () => {
    expect(matches('kernel.plugin.started', 'kernel.plugin.started')).toBe(true)
    expect(matches('kernel.plugin.started', 'kernel.plugin.stopped')).toBe(
      false,
    )
  })

  it('treats : and . as interchangeable separators', () => {
    expect(matches('kernel.plugin.started', 'kernel:plugin:started')).toBe(true)
    expect(matches('a.*', 'a:b')).toBe(true)
  })

  it('a single * covers exactly one segment and never crosses separators', () => {
    expect(matches('command:*', 'command:execute')).toBe(true)
    expect(matches('command:*', 'command:execute:sub')).toBe(false)
    expect(matches('a.*.c', 'a.b.c')).toBe(true)
    expect(matches('a.*.c', 'a.b.x.c')).toBe(false)
  })

  it('a bare * matches everything', () => {
    expect(matches('*', 'anything')).toBe(true)
    expect(matches('*', 'multi.segment.event')).toBe(true)
  })
})

describe('pattern · recursive wildcards', () => {
  it('a trailing ** matches one or more remaining segments', () => {
    expect(matches('kernel.**', 'kernel.plugin')).toBe(true)
    expect(matches('kernel.**', 'kernel.plugin.started')).toBe(true)
    expect(matches('kernel.**', 'kernel')).toBe(false)
  })

  it('a middle ** backtracks across segment counts, including zero', () => {
    // Unlike a trailing `**` (which requires at least one segment), a middle one
    // may consume nothing: `a.**.c` also matches `a.c`.
    expect(matches('a.**.c', 'a.c')).toBe(true)
    expect(matches('a.**.c', 'a.b.c')).toBe(true)
    expect(matches('a.**.c', 'a.b.x.c')).toBe(true)
    expect(matches('a.**.c', 'a.b.x.d')).toBe(false)
    expect(matches('a.**.c', 'a.b')).toBe(false)
  })

  it('a bare ** matches everything including single segments', () => {
    expect(matches('**', 'a')).toBe(true)
    expect(matches('**', 'a.b.c')).toBe(true)
  })
})

describe('pattern · buckets', () => {
  it('uses the first literal segment as the bucket key', () => {
    expect(bucketKeyOf('kernel.plugin.started')).toBe('kernel')
    expect(bucketKeyOf('command:*')).toBe('command')
  })

  it('routes wildcard-first patterns to the wildcard bucket', () => {
    expect(bucketKeyOf('*')).toBe(WILDCARD_BUCKET)
    expect(bucketKeyOf('**')).toBe(WILDCARD_BUCKET)
    expect(bucketKeyOf('')).toBe(WILDCARD_BUCKET)
    expect(bucketKeyOf('*:x')).toBe(WILDCARD_BUCKET)
  })

  it('derives the event bucket from its first segment', () => {
    expect(bucketKeyOfEvent('kernel.plugin.started')).toBe('kernel')
    expect(bucketKeyOfEvent('single')).toBe('single')
    expect(bucketKeyOfEvent('')).toBe(WILDCARD_BUCKET)
  })
})

describe('pattern · specificity', () => {
  it('scores literal segments above * above **', () => {
    expect(specificity('**')).toBe(0)
    expect(specificity('*')).toBe(1)
    expect(specificity('kernel')).toBe(10)
  })

  it('sums the segments so a longer literal pattern wins', () => {
    expect(specificity('kernel.plugin')).toBe(20)
    expect(specificity('kernel.*')).toBe(11)
    expect(specificity('kernel.**')).toBe(10)
    expect(specificity('a.*.c')).toBe(21)
  })
})
