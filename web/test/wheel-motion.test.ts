import { describe, expect, it } from 'vitest'

import {
  SPIN_MS,
  angleAt,
  overshootFor,
  pointerKick,
  rotationForIndex,
  toothAt,
} from '@/features/wheel/wheel-motion'

/**
 * The spin is a promise about a decision that has already been taken.
 *
 * The server draws the sector; the disc only tells the person which one. So
 * the one property that must never bend is the landing: at the end of the
 * animation the disc is on the drawn slice EXACTLY, not near it. Everything
 * else here — the wind-up, the overshoot, the ticker — is character, and is
 * pinned only enough that a future edit cannot quietly remove it.
 */
const spin = (elapsed: number, from = 0, target = 1800, overshoot = 8) =>
  angleAt({ elapsed, from, target, overshoot })

describe('the landing', () => {
  it('is exact at the end of the spin', () => {
    // Not "within a degree". The pointer sits on a boundary between two
    // slices; a near miss is the wrong prize on screen.
    expect(spin(SPIN_MS)).toBe(1800)
  })

  it('stays exact for any time past the end', () => {
    // WebKit stops the frame loop in a background tab and the first
    // timestamp on return jumps by the whole absence. A spin that was away
    // for a minute must be over, not overshot into a different slice.
    expect(spin(SPIN_MS + 60_000)).toBe(1800)
    expect(spin(Number.MAX_SAFE_INTEGER)).toBe(1800)
  })

  it('starts where the disc was resting', () => {
    expect(spin(0, 720, 2520)).toBe(720)
    expect(spin(-50, 720, 2520)).toBe(720)
  })

  it('never leaves a gap in the movement', () => {
    // Sampled densely: no frame may jump more than a slice-width relative to
    // its neighbours, or the disc visibly teleports at a phase boundary.
    let previous = spin(0)
    for (let t = 8; t <= SPIN_MS; t += 8) {
      const now = spin(t)
      expect(Math.abs(now - previous)).toBeLessThan(60)
      previous = now
    }
  })
})

describe('the character of the throw', () => {
  it('pulls back before it goes', () => {
    // Anticipation: the disc winds up against the direction of travel.
    expect(spin(120)).toBeLessThan(0)
    expect(spin(120)).toBeGreaterThan(-20)
  })

  it('carries past the mark and rocks back into it', () => {
    const peak = Math.max(...Array.from({ length: 60 }, (_, i) => spin(SPIN_MS - i * 20)))

    expect(peak).toBeGreaterThan(1800)
    expect(peak).toBeLessThanOrEqual(1800 + 8)
  })

  it('sizes the overshoot to the slice, so it reads the same on any wheel', () => {
    // A fixed wobble looks enormous on a wheel of three and invisible on a
    // wheel of twenty.
    expect(overshootFor(3)).toBeGreaterThan(overshootFor(20))
    expect(overshootFor(3)).toBeLessThanOrEqual(11)
    expect(overshootFor(40)).toBeGreaterThanOrEqual(4)
    expect(overshootFor(0)).toBe(0)
  })

  it('spends most of the spin at speed, not crawling to the finish', () => {
    // Halfway through the time, well past halfway round: an easing that
    // arrived early would leave seconds of nothing happening.
    expect(spin(SPIN_MS / 2)).toBeGreaterThan(1800 * 0.6)
  })
})

describe('the ticker', () => {
  it('counts a tooth for every slice the disc passes', () => {
    // Eight slices, one full turn: eight teeth, no more and no fewer.
    const count = 8
    let teeth = 0
    let previous = toothAt(0, count)
    for (let angle = 0; angle <= 360; angle += 0.5) {
      const now = toothAt(angle, count)
      if (now !== previous) teeth += 1
      previous = now
    }

    expect(teeth).toBe(count)
  })

  it('flicks the pointer and lets it settle', () => {
    expect(pointerKick(0)).toBeLessThan(0)
    expect(Math.abs(pointerKick(0))).toBeLessThanOrEqual(9)
    expect(pointerKick(400)).toBe(0)
    // Before the first tooth of a spin the pointer must be at rest, not
    // holding a kick from a previous one.
    expect(pointerKick(Number.POSITIVE_INFINITY)).toBe(0)
    expect(pointerKick(-1)).toBe(0)
  })
})

describe('where the disc has to stop', () => {
  it('puts the drawn slice under the pointer', () => {
    for (const [index, count, expected] of [
      [0, 4, 0],
      [1, 4, 270],
      [2, 4, 180],
      [3, 4, 90],
      [5, 8, 135],
    ] as const) {
      expect(rotationForIndex({ index, count, current: 0 }) % 360).toBe(expected)
    }
  })

  it('never rewinds, however far the disc has already turned', () => {
    let current = 12_345.6
    for (const index of [2, 2, 0, 7, 1]) {
      const next = rotationForIndex({ index, count: 8, current })
      expect(next).toBeGreaterThan(current)
      current = next
    }
  })
})
