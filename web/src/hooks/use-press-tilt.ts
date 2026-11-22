/**
 * usePressTilt — «плитка прогибается под курсором».
 *
 * Ported one-to-one from the marketing site's card press (`smufvpn-site`,
 * `.cell` / `PRESS` in its inline script). The press itself is geometry only;
 * the watermarks / holographic foil / torch live in CSS (`.press-wm`, painted
 * inside the button) and are driven by the `--press-px/--press-py/--press-foil`
 * custom properties this hook writes alongside the tilt.
 *
 * How it reads: the edge under the cursor moves AWAY from the viewer
 * (`rotateX`/`rotateY`), the plate sinks along Z and squashes a little.
 *
 * Two rules, both learned the hard way on the landing and kept here:
 *
 *  - **The moving plane is not the hover zone.** The pointer is tracked on a
 *    STATIC wrapper; the transform is applied to a nested plate that inherits
 *    the custom properties. If the plate itself were the listener target, it
 *    would slide out from under the cursor at the edges, `pointerleave` would
 *    fire, the plate would snap back, and the effect would stutter.
 *  - **The angle follows the size.** `edgeAngle()` caps the tilt so the edge
 *    under the cursor sinks by ~`PRESS.edge` px whatever the plate's span is;
 *    a fixed 7° on a wide plate would push its corner ~100px back and tear the
 *    layout. Plates up to ~570px wide still hit the full 7°/5.7°.
 *
 * Touch: the same press works under a held finger. No pointer capture is taken
 * — the plate holds a submit button, and capture would send `pointerup` to the
 * wrapper instead of the button.
 *
 * `prefers-reduced-motion: reduce` disables it (listeners stay passive and do
 * nothing).
 */
import { useEffect, useRef } from 'react'

/** Same numbers as the landing cards, so the press reads identically. */
const PRESS = { ry: 7, rx: 5.7, depth: 30, squeeze: 0.018, shadow: 34, edge: 35 } as const

/** How far the edge under the cursor sinks at `PRESS.edge` px, in degrees. */
function edgeAngle(span: number): number {
  return (Math.atan(PRESS.edge / Math.max(80, span / 2)) * 180) / Math.PI
}

function resetTilt(zone: HTMLElement): void {
  zone.style.setProperty('--press-rx', '0deg')
  zone.style.setProperty('--press-ry', '0deg')
  zone.style.setProperty('--press-depth', '0px')
  zone.style.setProperty('--press-squeeze', '1')
}

/**
 * Where the «torch» is, in % of the zone, and the angle of the foil bands.
 *
 * Written even under `prefers-reduced-motion`: the light is a reveal, not
 * motion, and a torch that stays in the middle on a reduced-motion machine
 * would look broken. Only the tilt is skipped there.
 */
function aim(zone: HTMLElement, px: number, py: number): void {
  zone.style.setProperty('--press-px', (px * 100).toFixed(1) + '%')
  zone.style.setProperty('--press-py', (py * 100).toFixed(1) + '%')
  // Same numbers as the landing cards: the bands turn against the cursor, so
  // the colour on the watermark shifts as it is crossed.
  zone.style.setProperty(
    '--press-foil',
    (118 + (0.5 - px) * 26 - (0.5 - py) * 9).toFixed(1) + 'deg',
  )
}

function tiltAt(zone: HTMLElement, px: number, py: number, rect: DOMRect): void {
  const dx = px - 0.5
  const dy = py - 0.5
  const edge = Math.min(1, Math.hypot(dx, dy) * 1.7)
  const ryMax = Math.min(PRESS.ry, edgeAngle(rect.width))
  const rxMax = Math.min(PRESS.rx, edgeAngle(rect.height))
  zone.style.setProperty('--press-ry', (dx * ryMax * 2).toFixed(2) + 'deg')
  zone.style.setProperty('--press-rx', (-dy * rxMax * 2).toFixed(2) + 'deg')
  zone.style.setProperty('--press-depth', (-(3 + PRESS.depth * edge)).toFixed(1) + 'px')
  zone.style.setProperty('--press-squeeze', (1 - PRESS.squeeze * edge).toFixed(4))
}

/** Attach the returned ref to the STATIC wrapper; the plate inside is `.press-plate`. */
export function usePressTilt<T extends HTMLElement = HTMLDivElement>() {
  const zoneRef = useRef<T | null>(null)

  useEffect(() => {
    const zone = zoneRef.current
    if (!zone) return
    // jsdom (and some old WebViews) have no `matchMedia` at all. The press is a
    // decoration: without it the button must simply not tilt, not throw. The
    // register page mounts this hook now, so a missing polyfill there would
    // take the whole form down.
    if (typeof window.matchMedia !== 'function') return

    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let held = false

    const track = (event: PointerEvent): [number, number, DOMRect] => {
      const rect = zone.getBoundingClientRect()
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / (rect.width || 1)))
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / (rect.height || 1)))
      return [x, y, rect]
    }

    const onPointerMove = (event: PointerEvent) => {
      const [px, py, rect] = track(event)
      const mouse = event.pointerType === 'mouse'
      // A mouse only counts on a precise-pointer device; a finger only while
      // it is pressing (the zone must not heat up on a plain touch-scroll).
      if (mouse ? !finePointer.matches : !held) return
      aim(zone, px, py)
      if (!reduced.matches) tiltAt(zone, px, py, rect)
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return
      held = true
      // CSS has no `:hover` a finger can produce — the torch listens to this.
      zone.classList.add('is-hot')
      const [px, py, rect] = track(event)
      aim(zone, px, py)
      if (!reduced.matches) tiltAt(zone, px, py, rect)
    }

    const release = () => {
      if (!held) return
      held = false
      zone.classList.remove('is-hot')
      resetTilt(zone)
    }

    const onPointerLeave = () => {
      zone.classList.remove('is-hot')
      if (!held) resetTilt(zone)
    }

    zone.addEventListener('pointermove', onPointerMove, { passive: true })
    zone.addEventListener('pointerdown', onPointerDown, { passive: true })
    zone.addEventListener('pointerleave', onPointerLeave, { passive: true })
    // A finger that wanders off the plate still ends its press somewhere.
    window.addEventListener('pointerup', release, { passive: true })
    window.addEventListener('pointercancel', release, { passive: true })

    return () => {
      zone.removeEventListener('pointermove', onPointerMove)
      zone.removeEventListener('pointerdown', onPointerDown)
      zone.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [])

  return zoneRef
}
