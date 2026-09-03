/**
 * How the disc moves — the whole spin, expressed as pure arithmetic.
 *
 * It lives apart from the component for two reasons. The first is that a
 * spin is a promise the screen makes about a decision the server has already
 * taken: the disc MUST come to rest on the sector that was drawn, exactly,
 * every time. That is a property worth a test, and a test that has to mount a
 * component and wait four seconds is a test nobody runs.
 *
 * The second is the phone. WebKit does not slow the frame loop in the
 * background, it STOPS it, and the first timestamp after the person comes
 * back jumps by the whole absence. Anything that advanced the angle by a
 * fixed step per frame would still be turning long after the wheel should
 * have stopped. Every function here takes ELAPSED REAL TIME and answers
 * where the disc is at that instant, so a spin that was away for a minute is
 * simply already over.
 */

/** Milliseconds from the press to the disc coming to rest. */
export const SPIN_MS = 4600

/** The wind-up: the disc pulls back before it goes, the way a hand would. */
const WIND_UP_MS = 340
const WIND_UP_DEG = 16

/** Where the travel ends and the rock-back into the notch begins. */
const SETTLE_AT = 0.84

const easeOutSine = (t: number): number => Math.sin((t * Math.PI) / 2)
const easeOutQuart = (t: number): number => 1 - (1 - t) ** 4
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

/**
 * How far past the target the disc swings before settling back.
 *
 * Tied to the slice size so it always reads as "one notch too far, then
 * caught" rather than as a fixed wobble that looks enormous on a wheel of
 * three sectors and invisible on a wheel of twenty.
 */
export function overshootFor(count: number): number {
  if (count <= 0) return 0
  const step = 360 / count
  return Math.min(Math.max(step * 0.3, 4), 11)
}

/**
 * Where the disc has to stop for `index` to sit under the pointer.
 *
 * Turns are added to the CURRENT angle rather than to zero, so two spins in
 * a row never rewind — a disc that unwound backwards would read as the wheel
 * taking the prize back.
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

/**
 * The angle at `elapsed` milliseconds into a spin from `from` to `target`.
 *
 * Three movements, continuous where they meet: the pull back, the long
 * throw that carries a little past the mark, and the rock back into it.
 * Before the spin it answers `from`; at or after `SPIN_MS`, exactly
 * `target` — the landing is arithmetic, not the tail of an easing curve
 * that happens to be close enough.
 */
export function angleAt(input: {
  readonly elapsed: number
  readonly from: number
  readonly target: number
  readonly overshoot: number
}): number {
  const { elapsed, from, target, overshoot } = input
  if (elapsed <= 0) return from
  if (elapsed >= SPIN_MS) return target

  if (elapsed < WIND_UP_MS) {
    return from - WIND_UP_DEG * easeOutSine(elapsed / WIND_UP_MS)
  }

  const progress = (elapsed - WIND_UP_MS) / (SPIN_MS - WIND_UP_MS)
  const start = from - WIND_UP_DEG
  const peak = target + overshoot

  if (progress < SETTLE_AT) {
    return start + (peak - start) * easeOutQuart(progress / SETTLE_AT)
  }
  return peak - overshoot * easeOutCubic((progress - SETTLE_AT) / (1 - SETTLE_AT))
}

/**
 * How hard the pointer is being flicked, given how long ago a tooth passed.
 *
 * A damped oscillation rather than a bounce: the flap is knocked aside and
 * shivers back. Zero once it has settled, so the pointer costs nothing to
 * draw between teeth.
 */
export function pointerKick(sinceTickMs: number): number {
  if (sinceTickMs < 0 || sinceTickMs > 260) return 0
  return -9 * Math.exp(-sinceTickMs / 70) * Math.cos(sinceTickMs / 26)
}

/**
 * Which tooth is under the pointer at `angle` — the disc has passed one
 * whenever this number changes.
 */
export function toothAt(angle: number, count: number): number {
  if (count <= 0) return 0
  const step = 360 / count
  return Math.round(angle / step)
}
