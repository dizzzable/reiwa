/**
 * The number on the home-screen icon.
 *
 * ── What it is, and where it actually shows ─────────────────────────────────
 *
 * The Badging API draws a count on the app icon itself — the red circle on a
 * phone's home screen, the dot on a taskbar. It is NOT the notification
 * banner: a banner is read once and gone, the badge sits there until the
 * subscriber has dealt with what raised it.
 *
 * It only exists for an INSTALLED app. In a browser tab there is no icon to
 * draw on, so every call here is a no-op — correctly, and without an error.
 *
 * ── Why every call is wrapped ───────────────────────────────────────────────
 *
 * The three failure modes are all silent-by-design, and each is normal:
 *
 *   - the API is absent (Firefox, older Safari) — `setAppBadge` is undefined;
 *   - it exists and refuses. On iOS the badge is tied to notification
 *     permission: with permission not granted the promise REJECTS, and an
 *     unhandled rejection in a render path is a crash for a decoration;
 *   - it exists, resolves, and draws nothing, because the app is not
 *     installed.
 *
 * None of the three is worth telling anybody about, and none may take a screen
 * down with it. So: feature-detect, swallow, move on.
 *
 * ── The count is a state, not an increment ──────────────────────────────────
 *
 * Always set the TOTAL, never `badge + 1`. Two devices, a push that arrives
 * while the app is open, a notification read on another device — an increment
 * drifts within a day and there is no way back from a wrong number the
 * subscriber can see but not correct. The total is idempotent: setting it
 * twice with the same value is the same as setting it once.
 */

interface BadgingNavigator {
  setAppBadge?: (count?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

/** True when this browser has the API at all. Says nothing about permission. */
export function supportsAppBadge(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as BadgingNavigator).setAppBadge === 'function'
  )
}

/**
 * Draw `count` on the icon, or clear it when the count is zero.
 *
 * Never throws and never rejects: a refused badge is a decoration that did not
 * appear, not an error the caller can do anything about.
 */
export async function setAppBadge(count: number): Promise<void> {
  const badging = navigator as BadgingNavigator
  try {
    if (!Number.isFinite(count) || count <= 0) {
      await badging.clearAppBadge?.()
      return
    }
    // Whole numbers only; the API takes an unsigned integer and a fractional
    // count is a programming mistake rather than something to render.
    await badging.setAppBadge?.(Math.floor(count))
  } catch {
    // See the header: absent, refused, or nothing to draw on. All fine.
  }
}

/** Take the number off the icon. Same guarantees as {@link setAppBadge}. */
export async function clearAppBadge(): Promise<void> {
  try {
    await (navigator as BadgingNavigator).clearAppBadge?.()
  } catch {
    // Same three reasons.
  }
}
