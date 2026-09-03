import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useReducedMotion } from 'motion/react'

import type { WheelRarity, WheelSector } from '@/lib/api-client'

import { RARITY_LOOK, iconFor, lookOf } from '../prize-look'
import {
  SPIN_MS,
  angleAt,
  overshootFor,
  pointerKick,
  rotationForIndex,
  toothAt,
} from '../wheel-motion'

export { rotationForIndex } from '../wheel-motion'

const SIZE = 300
const CENTER = SIZE / 2
const RADIUS = CENTER - 12

export interface WheelDiscHandle {
  /** Throw the disc so `index` comes to rest under the pointer. */
  spinTo: (index: number) => void
}

/**
 * The wheel the person spins.
 *
 * ── Every slice is the same size, and that is the design ──────────────────
 *
 * The odds are never shown — the owner's decision — and a wheel whose slices
 * were drawn in weight proportion would show them anyway: the jackpot would
 * visibly be a hairline and the losing slice two thirds of the disc. Anyone
 * could read the odds straight off the picture. So the disc divides evenly
 * and carries no information about chance at all.
 *
 * The panel's preview is the opposite on purpose: it draws by weight,
 * because that is the one place the odds are supposed to be visible.
 *
 * ── Why the angle is not React state ──────────────────────────────────────
 *
 * A spin is sixty writes a second for four seconds. As state, every one of
 * them would re-render the whole disc, and a mid-range phone would judder
 * exactly when the wheel is meant to look its best. The frame loop writes
 * the transform straight to the node instead: the compositor moves a layer
 * it already has, and nothing re-renders between the press and the prize.
 */
export const WheelDisc = forwardRef<
  WheelDiscHandle,
  {
    readonly sectors: readonly WheelSector[]
    readonly label: (sector: WheelSector) => string
    /** What a screen reader calls the disc as a whole. */
    readonly title: string
    /** Called once the disc has come to rest — never after unmount. */
    readonly onSettled?: (index: number) => void
    /** A tooth passed under the pointer, with how long the spin has left. */
    readonly onTick?: (remainingMs: number) => void
  }
>(function WheelDisc({ sectors, label, title, onSettled, onTick }, ref) {
  const reduceMotion = useReducedMotion()
  const discRef = useRef<SVGSVGElement | null>(null)
  const pointerRef = useRef<HTMLDivElement | null>(null)
  const labelsRef = useRef<SVGGElement | null>(null)
  const glowRef = useRef<HTMLDivElement | null>(null)
  const frame = useRef<number | null>(null)
  /** Where the disc is resting. Survives re-renders; never causes one. */
  const angle = useRef(0)

  /**
   * Callbacks and sector count are read through refs so the frame loop never
   * closes over a stale render and a re-render mid-spin cannot disturb it.
   */
  const settled = useRef(onSettled)
  const ticked = useRef(onTick)
  const countRef = useRef(sectors.length)
  settled.current = onSettled
  ticked.current = onTick
  countRef.current = sectors.length

  /** Nothing outlives the screen: a spin interrupted by leaving is dropped. */
  useEffect(() => {
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
  }, [])

  useImperativeHandle(ref, () => {
    const stop = () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }

    const paint = (next: number) => {
      angle.current = next
      if (discRef.current !== null) {
        discRef.current.style.transform = `rotate(${next}deg)`
      }
    }

    const rest = () => {
      if (labelsRef.current !== null) labelsRef.current.style.opacity = '1'
      if (glowRef.current !== null) glowRef.current.style.opacity = '0'
      if (pointerRef.current !== null) pointerRef.current.style.transform = 'translateX(-50%)'
      if (discRef.current !== null) discRef.current.style.willChange = 'auto'
    }

    const jumpTo = (index: number, total: number) => {
      const slice = 360 / total
      paint(Math.ceil(angle.current / 360) * 360 + ((360 - index * slice) % 360))
      rest()
    }

    return {
      spinTo(index: number) {
        stop()
        const total = countRef.current
        if (total <= 0) return

        // Anybody who asked for less motion gets the answer and none of the
        // theatre. The prize is identical either way, and a disc whirling
        // for four seconds is precisely what that preference is about.
        if (reduceMotion === true) {
          jumpTo(index, total)
          settled.current?.(index)
          return
        }

        const from = angle.current
        const target = rotationForIndex({ index, count: total, current: from })
        const overshoot = overshootFor(total)
        const started = performance.now()
        let tooth = toothAt(from, total)
        let lastTick = Number.NEGATIVE_INFINITY

        if (discRef.current !== null) discRef.current.style.willChange = 'transform'

        const step = (now: number) => {
          // Real elapsed time, not a per-frame increment. WebKit does not
          // slow the frame loop in a backgrounded tab, it stops it — a spin
          // that spent a minute away is simply already over on return,
          // rather than resuming from where it froze.
          const elapsed = now - started
          paint(angleAt({ elapsed, from, target, overshoot }))

          const passed = toothAt(angle.current, total)
          if (passed !== tooth) {
            tooth = passed
            if (now - lastTick > 110) {
              lastTick = now
              ticked.current?.(Math.max(SPIN_MS - elapsed, 0))
            }
          }

          // Labels dissolve while the disc is turning faster than they can
          // be read — which is also the moment the wheel should look like
          // motion rather than like a list of prizes.
          const heat = Math.min(elapsed / 300, 1) * (1 - Math.min(elapsed / SPIN_MS, 1)) ** 0.7
          if (labelsRef.current !== null) {
            labelsRef.current.style.opacity = (1 - 0.85 * heat).toFixed(3)
          }
          if (glowRef.current !== null) {
            glowRef.current.style.opacity = heat.toFixed(3)
          }
          if (pointerRef.current !== null) {
            pointerRef.current.style.transform = `translateX(-50%) rotate(${pointerKick(
              now - lastTick,
            ).toFixed(2)}deg)`
          }

          if (elapsed >= SPIN_MS) {
            frame.current = null
            paint(target)
            rest()
            settled.current?.(index)
            return
          }
          frame.current = requestAnimationFrame(step)
        }

        frame.current = requestAnimationFrame(step)
      },
    }
  }, [reduceMotion])

  const count = sectors.length
  if (count === 0) return null

  const slice = 360 / count

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[320px]">
      {/* The halo lives outside the disc so it does not turn with it. */}
      <div
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute inset-[-8%] rounded-full opacity-0"
        style={{
          background: 'radial-gradient(closest-side, var(--color-brand-glow), transparent 72%)',
        }}
      />

      {/* The pointer sits above the disc and does not turn with it either. */}
      <div
        ref={pointerRef}
        aria-hidden
        className="absolute left-1/2 top-0 z-10 h-0 w-0 -translate-x-1/2 drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]"
        style={{
          borderLeft: '11px solid transparent',
          borderRight: '11px solid transparent',
          borderTop: '20px solid var(--brand-primary, #f8fafc)',
          transformOrigin: '50% 10%',
        }}
      />

      <svg
        ref={discRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={title}
        style={{ transformOrigin: '50% 50%' }}
      >
        <defs>
          {(Object.keys(RARITY_LOOK) as WheelRarity[]).map((rarity) => (
            <linearGradient key={rarity} id={`wheel-slice-${rarity}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={RARITY_LOOK[rarity].from} />
              <stop offset="100%" stopColor={RARITY_LOOK[rarity].to} />
            </linearGradient>
          ))}
          <radialGradient id="wheel-depth" cx="50%" cy="50%" r="50%">
            <stop offset="52%" stopColor="#000000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.34" />
          </radialGradient>
          <radialGradient id="wheel-hub" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#2b3444" />
            <stop offset="100%" stopColor="#0b0f17" />
          </radialGradient>
        </defs>

        <circle cx={CENTER} cy={CENTER} r={RADIUS + 8} fill="#0b0f17" />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS + 5}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth={2}
        />

        {sectors.map((sector, index) => {
          const start = ((index * slice - 90 - slice / 2) * Math.PI) / 180
          const end = (((index + 1) * slice - 90 - slice / 2) * Math.PI) / 180
          const x1 = CENTER + RADIUS * Math.cos(start)
          const y1 = CENTER + RADIUS * Math.sin(start)
          const x2 = CENTER + RADIUS * Math.cos(end)
          const y2 = CENTER + RADIUS * Math.sin(end)
          const largeArc = slice > 180 ? 1 : 0
          const palette = lookOf(sector.rarity)
          return (
            <path
              key={sector.id}
              data-slice=""
              opacity={sector.available ? 1 : 0.32}
              d={`M ${CENTER} ${CENTER} L ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x2} ${y2} Z`}
              fill={`url(#wheel-slice-${sector.rarity in RARITY_LOOK ? sector.rarity : 'COMMON'})`}
              stroke={palette.edge}
              strokeWidth={1}
            />
          )
        })}

        {/* One overlay for the whole disc instead of a gradient per slice:
            depth for the price of a single circle. */}
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="url(#wheel-depth)" pointerEvents="none" />

        {/* Studs on the rim, one per boundary — what the pointer catches. */}
        {sectors.map((sector, index) => {
          const edge = ((index * slice - 90 - slice / 2) * Math.PI) / 180
          return (
            <circle
              key={`stud-${sector.id}`}
              cx={CENTER + (RADIUS + 6) * Math.cos(edge)}
              cy={CENTER + (RADIUS + 6) * Math.sin(edge)}
              r={2}
              fill="rgba(255,255,255,0.30)"
            />
          )
        })}

        <g ref={labelsRef}>
          {sectors.map((sector, index) => {
            const mid = ((index * slice - 90) * Math.PI) / 180
            const tx = CENTER + RADIUS * 0.66 * Math.cos(mid)
            const ty = CENTER + RADIUS * 0.66 * Math.sin(mid)
            const ix = CENTER + RADIUS * 0.4 * Math.cos(mid)
            const iy = CENTER + RADIUS * 0.4 * Math.sin(mid)
            const upright = (mid * 180) / Math.PI + 90
            const Glyph = iconFor(sector)
            const palette = lookOf(sector.rarity)
            return (
              <g key={`label-${sector.id}`} opacity={sector.available ? 1 : 0.45}>
                {count <= 12 ? (
                  <g transform={`translate(${ix - 9} ${iy - 9}) rotate(${upright} 9 9)`}>
                    <Glyph width={18} height={18} color={palette.glow} strokeWidth={2} />
                  </g>
                ) : null}
                <text
                  x={tx}
                  y={ty}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#f8fafc"
                  fontSize={count > 10 ? 9 : 11}
                  fontWeight={600}
                  transform={`rotate(${upright} ${tx} ${ty})`}
                >
                  {label(sector)}
                </text>
              </g>
            )
          })}
        </g>

        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS * 0.19}
          fill="url(#wheel-hub)"
          stroke="rgba(255,255,255,0.18)"
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS * 0.19}
          fill="none"
          stroke="var(--brand-primary, #22c55e)"
          strokeOpacity={0.55}
          strokeWidth={1.5}
        />
      </svg>
    </div>
  )
})
