/**
 * Is a cabinet hint on screen right now?
 *
 * Asked by the onboarding tour, answered by `hint-controller.tsx`.
 *
 * ── Why the two need to know about each other ─────────────────────────────
 *
 * They are raised by the SAME moment. A purchase finishes provisioning, and
 * that instant both queues a hint («Готово! Подписка оформлена» with its
 * «Подключиться») and releases the tour, which has been waiting for a real
 * subscription card to spotlight. Neither knew about the other, so they drew
 * together: the tour dimmed the whole page including the modal it could not
 * see, and the customer was handed two overlapping things to read, one of them
 * greyed out and still clickable.
 *
 * The rule is that the tutorial goes first. That is enforced in two places,
 * because one is not enough:
 *
 *   * the hint does not draw while the tour is on screen or due — that is
 *     `mustWaitForTour` in the hint controller, the push prompt's own rule
 *     reused;
 *   * the tour does not start while a hint is already up — this module. The
 *     first rule cannot cover it: a hint drawn a second before the tour became
 *     due (the subscription list still loading, a receipt still clearing) is
 *     already on screen, and nothing about the tour's own state says so.
 *
 * Together they never overlap. In the ordinary case the tutorial runs and the
 * hint follows it; in the race the hint came first, the tour waits for it to
 * be closed and then runs. The tour stays due either way — it is marked seen
 * when it actually starts, not when it becomes due.
 *
 * ── Why a module and not context ──────────────────────────────────────────
 *
 * The hint controller sits in the shell and must degrade to "no hint" rather
 * than take a page down, so it holds no hook that needs a provider. A plain
 * module flag plus a window event is the same shape the tour already uses for
 * provisioning receipts, and it works in whichever order the two mount.
 */

/** Fired whenever the answer changes. `detail.onScreen` carries the new one. */
export const HINT_PRESENCE_CHANGED_EVENT = "reiwa:hint-presence-changed"

let onScreen = false

/** Whether a hint — modal or toast — currently holds the screen. */
export function isHintOnScreen(): boolean {
  return onScreen
}

/**
 * Called by the hint controller as it claims and releases its one slot.
 *
 * Silent when nothing changed, so a release on unmount after a release on
 * dismiss does not wake the tour twice.
 */
export function setHintOnScreen(next: boolean): void {
  if (onScreen === next) return
  onScreen = next
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent(HINT_PRESENCE_CHANGED_EVENT, { detail: { onScreen: next } }),
  )
}
