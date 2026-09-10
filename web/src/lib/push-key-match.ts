/**
 * Does a live push subscription carry the VAPID key we are about to use?
 *
 * ── Three answers, not two ───────────────────────────────────────────────────
 *
 * `PushSubscriptionOptions.applicationServerKey` is not exposed by every
 * engine — historically Firefox and some Safari builds report `null` for a
 * perfectly healthy subscription. Collapsing that into "different" is what made
 * the heal destructive on exactly those browsers: every cabinet load
 * unsubscribed a working endpoint and minted a new one, the freshly minted one
 * reported no key either, and the next load did it again. The panel's rows
 * accumulated one per load until each 410'd, and a single notification fanned
 * out to every one of them.
 *
 * So "the browser told us nothing" is its own answer, and the caller decides
 * what to do with it — which is: keep the subscription and simply re-register
 * it. The cost of that choice is stated where it is made.
 *
 * ── No imports, on purpose ───────────────────────────────────────────────────
 *
 * The service worker needs this comparison too and is bundled separately
 * (`vite-plugin-pwa`, `injectManifest`). It cannot reach `lib/push.ts`, which
 * pulls the whole SPA API client — axios, i18n, `window` — into a worker that
 * has none of it. A module with no dependencies at all is importable from both
 * builds, and this comparison is the only thing the two halves must agree on.
 */

/**
 * `unknown` means the engine did not report a key, NOT that the key is wrong.
 */
export type ApplicationServerKeyMatch = 'same' | 'different' | 'unknown'

export function matchApplicationServerKey(
  current: ArrayBuffer | ArrayBufferView | null | undefined,
  desired: ArrayBuffer,
): ApplicationServerKeyMatch {
  if (current === null || current === undefined) return 'unknown'
  const a =
    ArrayBuffer.isView(current)
      ? new Uint8Array(current.buffer, current.byteOffset, current.byteLength)
      : new Uint8Array(current)
  // An empty buffer is the same non-answer as `null`, and at least one engine
  // returns it instead. Treating it as "different" would restore the churn
  // above for that engine alone, which is the kind of partial fix that reads as
  // fixed everywhere it is tested.
  if (a.byteLength === 0) return 'unknown'
  const b = new Uint8Array(desired)
  if (a.byteLength !== b.byteLength) return 'different'
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return 'different'
  }
  return 'same'
}
