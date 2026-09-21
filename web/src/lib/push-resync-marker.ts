/**
 * "This tab has already healed its push subscription."
 *
 * ── Why the marker had to grow a timestamp ───────────────────────────────────
 *
 * It was the string `"1"` in `sessionStorage`, and `sessionStorage` survives
 * reloads and `location.replace` for the whole life of a browsing context. So
 * the marker meant "once per TAB", and a tab a customer keeps pinned lives for
 * weeks. That is fine while nothing else can break push — and something can:
 *
 *   09:00  the tab heals; the marker stands.
 *   next day, the session lapses. The browser fires `pushsubscriptionchange`,
 *          the worker mints a new subscription and POSTs it; the POST answers
 *          401. The old endpoint is gone and the server never learned the new
 *          one.
 *   the customer reloads and signs in — and the marker still says done, so the
 *          heal is skipped. Push is dead in that tab for as long as it lives.
 *
 * The marker now carries WHEN, and is honoured only while it is young. That
 * turns "once per tab" into "once every few hours per tab", which is the same
 * cheapness with an upper bound on how long a wrong answer can stand. It needs
 * nothing to be open, nothing to be delivered and no cooperation from the panel
 * — which is why it is the mechanism and the worker's message below is only an
 * accelerator.
 *
 * A value this module cannot parse — the legacy `"1"`, anything truncated —
 * reads as ABSENT, so an upgrade mid-session heals once and then settles. That
 * is the safe direction: the failure of a heal that was not needed is one
 * request.
 */

/** The `sessionStorage` key. Unchanged, so a legacy value is found and retired. */
export const PUSH_RESYNC_KEY = 'reiwa_push_resynced'

/**
 * How long a successful heal is believed.
 *
 * Long enough that ordinary use — a session invalidated by a purchase, a
 * payment, a referral reward — never re-runs it, short enough that a
 * subscription pruned server-side (a 410 sweep) is repaired the same day
 * rather than never.
 */
export const PUSH_RESYNC_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * What the service worker sends a page when a re-registration did not land.
 *
 * The worker cannot reach `sessionStorage` and has no session of its own, so it
 * cannot heal this itself — but it is the only side that KNOWS, and it used to
 * say so with `console.warn`. A worker's console is a separate pane in DevTools
 * (Application → Service Workers); nobody was ever going to read it. The
 * machinery for a real signal was already in the file — the click handler
 * `postMessage`s clients — so the report now goes there instead, and the page
 * retires the marker so the very next session change heals.
 */
export const PUSH_RESYNC_FAILED_MESSAGE = 'PUSH_RESYNC_FAILED'

interface PushResyncMarker {
  /** `Date.now()` when the heal landed. */
  readonly at: number
  /**
   * WHOSE heal it was.
   *
   * The endpoint belongs to the BROWSER and the row belongs to an ACCOUNT, and
   * a heal is what binds the two. Without this the marker said only "a heal
   * landed in this tab", so a second account signing in behind the first —
   * a shared test device, a household, one phone and two subscriptions — was
   * refused a heal for up to six hours. Its endpoint stayed registered to the
   * PREVIOUS account: pushes went to the wrong person, the settings switch
   * still read "on" because the browser did hold a subscription, and there was
   * nothing left to switch on.
   */
  readonly who: string
}

function readMarker(): PushResyncMarker | null {
  try {
    const raw = sessionStorage.getItem(PUSH_RESYNC_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const at = (parsed as { at?: unknown }).at
    if (typeof at !== 'number' || !Number.isFinite(at)) return null
    // A marker from a build that did not record the account reads as ABSENT,
    // exactly as the legacy `"1"` does: one unnecessary heal on upgrade is the
    // cheap direction, and believing it would keep the very bug `who` exists
    // to close open for the rest of the tab's life.
    const who = (parsed as { who?: unknown }).who
    if (typeof who !== 'string' || who.length === 0) return null
    return { at, who }
  } catch {
    // Storage unavailable (private mode), or a value from another build.
    return null
  }
}

/**
 * True while this tab's last successful heal is still worth believing.
 *
 * A stamp from the FUTURE counts as stale, not as fresh: a clock that moved
 * backwards would otherwise pin the marker open for as long as the skew lasts,
 * which is the same "for ever" this file exists to remove.
 *
 * A heal recorded for a DIFFERENT account is stale too, whatever its age —
 * see `PushResyncMarker.who`.
 */
export function isPushResyncFresh(accountKey: string, now: number = Date.now()): boolean {
  const marker = readMarker()
  if (marker === null) return false
  if (marker.who !== accountKey) return false
  const age = now - marker.at
  return age >= 0 && age < PUSH_RESYNC_MAX_AGE_MS
}

/** Records a heal that actually landed, for this account. Never throws. */
export function rememberPushResync(accountKey: string, now: number = Date.now()): void {
  try {
    sessionStorage.setItem(PUSH_RESYNC_KEY, JSON.stringify({ at: now, who: accountKey }))
  } catch {
    // Nothing to do — the next mount simply tries again.
  }
}

/**
 * The key a heal is recorded under, from whatever the session offers.
 *
 * Structural on purpose: this module is imported by the payment-return and
 * renewal paths and must stay free of the session and API types.
 *
 * An unidentifiable session answers the empty string, which `readMarker`
 * refuses — so the heal simply runs every time rather than being skipped on a
 * marker that could belong to anyone.
 */
export function pushResyncAccountKey(
  session: { readonly id?: string; readonly telegramId?: string | null } | null | undefined,
): string {
  const id = typeof session?.id === 'string' ? session.id.trim() : ''
  if (id.length > 0) return id
  const telegramId = typeof session?.telegramId === 'string' ? session.telegramId.trim() : ''
  return telegramId.length > 0 ? `tg:${telegramId}` : ''
}

/** Forgets it, so the next session change heals. Never throws. */
export function forgetPushResync(): void {
  try {
    sessionStorage.removeItem(PUSH_RESYNC_KEY)
  } catch {
    // Nothing to do.
  }
}

/**
 * Listen for the worker telling us a re-registration was refused.
 *
 * Registered beside the strategy-violation listener in `register-sw.ts`, i.e.
 * once per document and before any service worker work begins — the message can
 * arrive at any time, including while the customer is signed out.
 */
export function watchForPushResyncFailure(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (event: Event) => {
    const data = (event as MessageEvent).data as { type?: unknown } | null | undefined
    if (data?.type === PUSH_RESYNC_FAILED_MESSAGE) forgetPushResync()
  })
}
