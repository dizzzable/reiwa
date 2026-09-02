import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WheelDisc, rotationForIndex } from '@/features/wheel/components/wheel-disc'
import type { WheelSector } from '@/lib/api-client'

/**
 * The disc the person spins.
 *
 * The property worth guarding is not how it looks — it is that it says
 * NOTHING about the odds. Slices drawn in weight proportion would show them
 * geometrically: the jackpot a hairline, "не повезло" two thirds of the
 * circle, readable by anybody with a screenshot. The disc divides evenly, and
 * this file is what stops a well-meaning "make it proportional" edit.
 */
function sector(id: string, overrides: Partial<WheelSector> = {}): WheelSector {
  return {
    id,
    kind: 'POINTS',
    title: { ru: id },
    iconKind: 'PRESET',
    iconRef: '',
    rarity: 'COMMON',
    amount: 1,
    available: true,
    unavailable: null,
    ...overrides,
  }
}

const label = (s: WheelSector) => s.title.ru ?? s.id

function markup(sectors: readonly WheelSector[]): string {
  return renderToStaticMarkup(
    <WheelDisc sectors={sectors} rotation={0} spinning={false} label={label} />,
  )
}

/**
 * The angle each slice actually spans.
 *
 * Each path is `M cx cy L x1 y1 A r r 0 flag 1 x2 y2 Z`; the two endpoints
 * against the centre give the sweep. Measuring the geometry rather than
 * trusting a prop is the point — a proportional edit would still pass a test
 * that only checked the inputs.
 */
function arcAngles(html: string): number[] {
  return [...html.matchAll(/ d="([^"]+)"/g)].map((match) => {
    const numbers = (match[1] ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
    const [cx, cy, x1, y1] = numbers
    const x2 = numbers[9]
    const y2 = numbers[10]
    if ([cx, cy, x1, y1, x2, y2].some((value) => value === undefined)) return 0
    const a1 = Math.atan2((y1 as number) - (cy as number), (x1 as number) - (cx as number))
    const a2 = Math.atan2((y2 as number) - (cy as number), (x2 as number) - (cx as number))
    let sweep = ((a2 - a1) * 180) / Math.PI
    if (sweep < 0) sweep += 360
    return Math.round(sweep)
  })
}

describe('the wheel disc', () => {
  it('divides evenly, whatever the prizes are worth', () => {
    // THE DECISION THIS FILE EXISTS FOR. Three sectors means three 120°
    // slices — the sizes carry no information about chance.
    const html = markup([
      sector('a'),
      sector('b', { kind: 'NOTHING' }),
      sector('c', { kind: 'MANUAL' }),
    ])

    expect(arcAngles(html)).toEqual([120, 120, 120])
  })

  it('stays even with many sectors', () => {
    const html = markup(Array.from({ length: 8 }, (_, index) => sector(`s${index}`)))

    expect(arcAngles(html)).toEqual([45, 45, 45, 45, 45, 45, 45, 45])
  })

  it('dims a sector this person can no longer win', () => {
    const html = markup([
      sector('a'),
      sector('taken', { available: false, unavailable: 'ALREADY_WON' }),
    ])

    const opacities = [...html.matchAll(/opacity="([\d.]+)"/g)].map((match) => match[1])
    expect(opacities).toEqual(['1', '0.35'])
  })

  it('renders nothing at all when there is nothing to spin', () => {
    expect(markup([])).toBe('')
  })
})

describe('where the disc stops', () => {
  it('brings the drawn slice under the pointer', () => {
    // Four sectors, 90° apart. Index 1 has to travel 270° to reach the top.
    const angle = rotationForIndex({ index: 1, count: 4, current: 0 })

    expect(angle % 360).toBe(270)
  })

  it('always turns forward, so a second spin never rewinds', () => {
    // A disc that unwound backwards would read as the wheel undoing itself.
    let current = 0
    for (const index of [3, 0, 2, 1, 1]) {
      const next = rotationForIndex({ index, count: 5, current })
      expect(next).toBeGreaterThan(current)
      current = next
    }
  })

  it('travels several whole turns, not a nudge', () => {
    const angle = rotationForIndex({ index: 0, count: 6, current: 0 })

    expect(angle).toBeGreaterThanOrEqual(5 * 360)
  })

  it('answers with the current angle when there is nothing to land on', () => {
    expect(rotationForIndex({ index: 0, count: 0, current: 720 })).toBe(720)
  })
})
