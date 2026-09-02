import type { WheelRarity, WheelSector } from '@/lib/api-client'

const SIZE = 300
const CENTER = SIZE / 2
const RADIUS = CENTER - 10

/**
 * The colour of a slice by rarity. Rarity is a LOOK, never a probability —
 * a common sector may be rarer than a legendary one if the operator set it up
 * that way, and nothing here implies otherwise.
 */
const RARITY: Readonly<Record<WheelRarity, { fill: string; glow: string }>> = {
  COMMON: { fill: '#475569', glow: 'transparent' },
  RARE: { fill: '#0369a1', glow: '#38bdf8' },
  EPIC: { fill: '#6d28d9', glow: '#a78bfa' },
  LEGENDARY: { fill: '#b45309', glow: '#fbbf24' },
}

/**
 * The wheel the person spins.
 *
 * ── Every slice is the same size, and that is the design ──────────────────
 *
 * The odds are never shown — the owner's decision — and a wheel whose slices
 * were drawn in weight proportion would show them anyway: the jackpot would
 * visibly be a hairline and "не повезло" two thirds of the disc. Anyone could
 * read the odds straight off the picture. So the disc divides evenly and
 * carries no information about chance at all.
 *
 * The panel's preview is the opposite on purpose: it draws by weight, because
 * that is the one place the odds are supposed to be visible.
 */
export function WheelDisc({
  sectors,
  rotation,
  spinning,
  label,
}: {
  readonly sectors: readonly WheelSector[]
  /** Degrees. The parent decides where the disc stops. */
  readonly rotation: number
  readonly spinning: boolean
  readonly label: (sector: WheelSector) => string
}) {
  if (sectors.length === 0) return null

  const step = 360 / sectors.length

  return (
    <div className="relative mx-auto" style={{ width: SIZE, height: SIZE }}>
      {/* The pointer sits above the disc and does not turn with it. */}
      <div
        aria-hidden
        className="absolute left-1/2 top-0 z-10 h-0 w-0 -translate-x-1/2"
        style={{
          borderLeft: '10px solid transparent',
          borderRight: '10px solid transparent',
          borderTop: '18px solid var(--wheel-pointer, #f8fafc)',
        }}
      />
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={label(sectors[0]!)}
        style={{
          transform: `rotate(${rotation}deg)`,
          // Long, and eased hard at the end, so the disc drifts into place
          // instead of snapping. Motion is dropped entirely for anybody who
          // asked for less of it — the result is the same either way, and a
          // spinning disc is exactly what that preference is about.
          transition: spinning ? 'transform 4.2s cubic-bezier(0.15, 0.85, 0.2, 1)' : 'none',
        }}
        className="motion-reduce:!transition-none"
      >
        {sectors.map((sector, index) => {
          const start = ((index * step - 90 - step / 2) * Math.PI) / 180
          const end = (((index + 1) * step - 90 - step / 2) * Math.PI) / 180
          const x1 = CENTER + RADIUS * Math.cos(start)
          const y1 = CENTER + RADIUS * Math.sin(start)
          const x2 = CENTER + RADIUS * Math.cos(end)
          const y2 = CENTER + RADIUS * Math.sin(end)
          const largeArc = step > 180 ? 1 : 0
          const mid = (start + end) / 2
          const palette = RARITY[sector.rarity] ?? RARITY.COMMON
          return (
            <g key={sector.id} opacity={sector.available ? 1 : 0.35}>
              <path
                d={`M ${CENTER} ${CENTER} L ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x2} ${y2} Z`}
                fill={palette.fill}
                stroke="rgba(255,255,255,0.15)"
                strokeWidth={1}
              />
              <text
                x={CENTER + RADIUS * 0.62 * Math.cos(mid)}
                y={CENTER + RADIUS * 0.62 * Math.sin(mid)}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#f8fafc"
                fontSize={sectors.length > 8 ? 9 : 11}
                transform={`rotate(${(mid * 180) / Math.PI + 90} ${
                  CENTER + RADIUS * 0.62 * Math.cos(mid)
                } ${CENTER + RADIUS * 0.62 * Math.sin(mid)})`}
              >
                {label(sector)}
              </text>
            </g>
          )
        })}
        <circle cx={CENTER} cy={CENTER} r={RADIUS * 0.16} fill="#0f172a" stroke="rgba(255,255,255,0.2)" />
      </svg>
    </div>
  )
}

/**
 * Where the disc has to stop for `index` to sit under the pointer.
 *
 * Turns are added so the disc always travels several times round rather than
 * nudging a few degrees — and they are added to the CURRENT rotation, so two
 * spins in a row never rewind.
 */
export function rotationForIndex(input: {
  readonly index: number
  readonly count: number
  readonly current: number
  readonly turns?: number
}): number {
  if (input.count <= 0) return input.current
  const step = 360 / input.count
  const target = (360 - input.index * step) % 360
  const turns = input.turns ?? 5
  const base = Math.ceil(input.current / 360) * 360
  return base + turns * 360 + target
}
