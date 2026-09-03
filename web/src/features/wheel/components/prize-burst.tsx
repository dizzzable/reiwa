import { useMemo } from 'react'
import { motion, useReducedMotion } from 'motion/react'

import type { WheelRarity } from '@/lib/api-client'

/**
 * The moment the prize appears.
 *
 * Two things happen at once: a ring of light opens out from behind the
 * prize, and — for anything better than an everyday sector — a handful of
 * confetti is thrown. Both are decoration and neither says a word about
 * chance: the colour follows the sector's RARITY, which the operator chose
 * as a look, and a "legendary" sector may well be the likeliest on the
 * wheel.
 *
 * Nothing here is random at render time. The pieces are laid out from a seed
 * derived from the spin's own id, so the burst is identical on every render
 * of the same prize — React may render a component more than once, and a
 * burst that re-scattered halfway through would flicker.
 */

const CONFETTI: Readonly<Record<WheelRarity, number>> = {
  COMMON: 0,
  RARE: 14,
  EPIC: 22,
  LEGENDARY: 30,
}

const PALETTE: Readonly<Record<WheelRarity, readonly string[]>> = {
  COMMON: ['#94a3b8'],
  RARE: ['#38bdf8', '#7dd3fc', '#e0f2fe'],
  EPIC: ['#a78bfa', '#c4b5fd', '#f0abfc'],
  LEGENDARY: ['#fbbf24', '#fde68a', '#fb923c', '#fef3c7'],
}

/** FNV-1a over the spin id: same prize, same burst, every render. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Mulberry32 — small, fast, and good enough to scatter paper. */
function randomFrom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Piece {
  readonly id: number
  readonly color: string
  readonly x: number
  readonly y: number
  readonly rotate: number
  readonly delay: number
  readonly duration: number
  readonly size: number
}

export function PrizeBurst({
  rarity,
  spinId,
  muted = false,
}: {
  readonly rarity: WheelRarity
  readonly spinId: string
  /** A prize that is owed rather than given gets the light, not the party. */
  readonly muted?: boolean
}) {
  const reduceMotion = useReducedMotion()
  const colors = PALETTE[rarity] ?? PALETTE.COMMON
  const glow = colors[0] ?? '#94a3b8'

  const pieces = useMemo<readonly Piece[]>(() => {
    if (muted) return []
    const total = CONFETTI[rarity] ?? 0
    if (total === 0) return []
    const next = randomFrom(seedOf(spinId))
    return Array.from({ length: total }, (_, id) => {
      const angle = next() * Math.PI * 2
      const distance = 70 + next() * 130
      return {
        id,
        color: colors[Math.floor(next() * colors.length)] ?? glow,
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance * 0.75 + 40,
        rotate: (next() - 0.5) * 900,
        delay: next() * 0.14,
        duration: 1.1 + next() * 0.7,
        size: 5 + Math.round(next() * 5),
      }
    })
  }, [colors, glow, muted, rarity, spinId])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* The ring of light. Even with motion turned down it still appears —
          it simply arrives already open instead of expanding. */}
      <motion.div
        className="absolute left-1/2 top-14 h-40 w-40 -translate-x-1/2 rounded-full"
        style={{ background: `radial-gradient(closest-side, ${glow}, transparent 70%)` }}
        initial={reduceMotion === true ? { opacity: 0.22 } : { opacity: 0.85, scale: 0.35 }}
        animate={reduceMotion === true ? { opacity: 0.22 } : { opacity: 0.16, scale: 2.1 }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      />

      {reduceMotion === true
        ? null
        : pieces.map((piece) => (
            <motion.span
              key={piece.id}
              className="absolute left-1/2 top-20 block rounded-[1px]"
              style={{
                width: piece.size,
                height: piece.size * 1.8,
                backgroundColor: piece.color,
              }}
              initial={{ opacity: 0, x: 0, y: 0, rotate: 0 }}
              animate={{ opacity: [0, 1, 1, 0], x: piece.x, y: piece.y, rotate: piece.rotate }}
              transition={{
                duration: piece.duration,
                delay: piece.delay,
                ease: [0.12, 0.6, 0.35, 1],
                opacity: { times: [0, 0.08, 0.7, 1], duration: piece.duration },
              }}
            />
          ))}
    </div>
  )
}
