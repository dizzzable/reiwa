/**
 * PressWatermark — the holographic «watermark» stencil inside a press button.
 *
 * ONE layer of the operator's brand name, revealed through a radial mask
 * («фонарик») that follows the cursor: the letters are visible only where the
 * torch falls, exactly as on the marketing cards. There is no second, unmasked
 * copy — a whole-pill stencil lit by a spotlight is not a flashlight.
 *
 * At rest the pill carries NO lettering at all: the owner asked for the marks to
 * stay invisible until the button is hovered (or pressed, on touch).
 *
 * The brand name comes from the panel (Web Reiwa → Идентичность → Название
 * бренда, i.e. `branding.brandName`), so whatever the operator types is what
 * the buttons carry. The layer is `z-index: -1` inside an isolated button, so
 * it paints above the button's own fill and BELOW its label.
 *
 * Coverage: the rows must be laid out past every edge of the pill. An earlier
 * version stacked three rows in a box ~1.9x the pill height, so the rotated
 * block ended up shorter than the pill and left bare wedges at the top-left and
 * the bottom-right (the owner saw exactly those). The row count below is sized
 * so the stack overflows the clip box at ANY pill height (the pill is at most
 * `h-14` = 56px), and each row is long enough to run past the right edge.
 *
 * No motion of its own: the foil angle and the torch position are custom
 * properties written by `usePressTilt` on the static `.press-zone`.
 */
const ROW_COUNT = 14
/** `name · ` copies per row — enough characters to outrun any CTA width. */
const ROW_CHARS = 240

export function PressWatermark({ text }: { readonly text?: string | null }) {
  const name = (text ?? '').trim()
  if (name.length === 0) return null

  const unit = `${name} · `
  const repeats = Math.max(2, Math.ceil(ROW_CHARS / unit.length))
  const row = unit.repeat(repeats)
  const rows = Array.from({ length: ROW_COUNT }, (_, index) => index)

  return (
    <span aria-hidden="true" data-press-watermark className="press-wm">
      {/* The light itself: a soft pool under the cursor. It sits BELOW the
          stencil on purpose — a white light drawn on top of the foil washes the
          colours out (measured on the live pill), while light under the marks
          brightens the pill and lets the foil stay saturated. */}      <span className="press-wm-pool" />
      <span className="press-wm-foil press-wm-torch">
        {rows.map((index) => (
          <span key={index}>{row}</span>
        ))}
      </span>
    </span>
  )
}
