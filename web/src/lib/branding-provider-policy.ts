import {
  DEFAULT_PUBLIC_CONFIG,
  type PublicConfig,
} from "../types/branding";

/**
 * Selects the configuration exposed during bootstrap. A failed refresh must
 * retain the validated browser snapshot instead of flashing back to defaults.
 */
export function selectBrandingProviderConfig(
  data: PublicConfig | undefined,
  snapshot: PublicConfig | null,
): PublicConfig {
  return data ?? snapshot ?? DEFAULT_PUBLIC_CONFIG;
}

/** Only confirmed, non-placeholder query data may replace the snapshot. */
export function shouldPersistPublicConfig(
  data: PublicConfig | undefined,
  dataUpdatedAt: number,
  isPlaceholderData: boolean,
  isSuccess: boolean,
): data is PublicConfig {
  return isSuccess && !isPlaceholderData && data !== undefined && dataUpdatedAt > 0;
}

/**
 * How long the cabinet waits before re-attempting the bootstrap fetch while it
 * still has nothing but its built-in defaults to paint.
 *
 * Matched to the visibility-refresh throttle in `branding-provider.tsx` so the
 * two recovery paths cannot beat each other into a request storm, and cheap
 * upstream regardless: `/public-config` is served from a 60s process cache.
 */
export const PUBLIC_CONFIG_RETRY_INTERVAL_MS = 15_000;

/**
 * Polling cadence for the public-config query.
 *
 * This is the query's ONLY retry, by design. `BrandingProvider` mounts once at
 * the application root and never remounts, and window-focus refetching is off,
 * so nothing else re-triggers the request for the life of the document. The
 * in-query retryer was deliberately turned off in `branding-provider.tsx`
 * because it does not fail on a host whose Page Visibility reads `hidden` — it
 * PARKS, permanently and unreportably. One blip therefore used to pin an entire
 * session to the built-in identity on any client with no stored snapshot behind
 * it.
 *
 * The argument is the query's CACHED data, not the value the provider renders:
 * `placeholderData` is deliberately never written to the cache, so `undefined`
 * here means "no operator payload has ever arrived", which is exactly the
 * condition worth retrying. Returning `false` on the first real payload is
 * what makes this self-terminating rather than a permanent poll.
 */
export function publicConfigRefetchInterval(
  fetched: PublicConfig | undefined,
): number | false {
  return fetched === undefined ? PUBLIC_CONFIG_RETRY_INTERVAL_MS : false;
}

/**
 * Must the bootstrap poll run even while the platform reports the document as
 * not visible?
 *
 * Yes, for exactly as long as no operator payload has ever arrived — and this
 * is the missing half of the retry above, not a tuning knob.
 *
 * `refetchInterval` on its own does NOT keep trying. React Query's interval
 * callback is
 *
 *   setInterval(() => {
 *     if (options.refetchIntervalInBackground || focusManager.isFocused())
 *       executeFetch();
 *   }, interval)
 *
 * (`@tanstack/query-core/build/modern/queryObserver.js`), and
 * `focusManager.isFocused()` is `document.visibilityState !== "hidden"`
 * (`.../focusManager.js`). With the flag off, every tick that lands while the
 * platform says `hidden` is SKIPPED IN SILENCE: the timer keeps running, the
 * request never goes out, and the cabinet goes on painting its built-in
 * identity for the rest of the session.
 *
 * The cabinet's only other recovery — the return listener in
 * `branding-provider.tsx` — read the same signal, so BOTH ways out of a failed
 * bootstrap rested on one capability. That is the capability this front end has
 * already been burned by: `components/reactbits/card-effect-layer.tsx`
 * documents that a document can be frozen and thawed with NO `visibilitychange`
 * at all — "the document never became hidden as far as that event is concerned,
 * it stopped existing and started again" — which is why that file had to grow
 * `pagehide`/`pageshow` handlers. The same file records that a Telegram Mini
 * App on a phone "is backgrounded constantly", so a tick arriving while the
 * platform says `hidden` is the ordinary case, not the exotic one.
 *
 * Self-terminating through the SAME mechanism as the cadence, not a second
 * rule: this reads the query's CACHED payload, so it switches off at the exact
 * moment `publicConfigRefetchInterval` returns `false` and the interval is
 * cleared outright. A healthy launch resolves long before the first tick and
 * therefore never polls in the background at all; only a cabinet that has
 * nothing but its own identity to show does, at four requests per minute
 * against an endpoint served from a 60s process cache.
 */
export function publicConfigRefetchInBackground(
  fetched: PublicConfig | undefined,
): boolean {
  return fetched === undefined;
}

/**
 * Is this event a return worth re-reading the operator configuration on?
 *
 * `visibilitychange` fires in both directions, so it still has to be filtered
 * on the resulting state. `pageshow` does not, and must not be: it IS the
 * presentation, and it is the event WebKit fires when a frozen document is
 * thawed — precisely the return where `visibilitychange` never arrives and the
 * document was never `hidden` to begin with. Filtering it on
 * `visibilityState === "visible"` would put the whole recovery back behind the
 * one signal it exists to stop depending on.
 */
export function shouldRefetchOnReturn(
  eventType: string,
  visibilityState: string | undefined,
): boolean {
  return eventType === "pageshow" || visibilityState === "visible";
}

/**
 * Is the cabinet showing its own identity instead of the operator's, with no
 * way left to recover on this render?
 *
 * This is the state behind "the theme did not apply": stock palette, the name
 * `Reiwa`, the stock mark and the three-item fallback navigation — a cabinet
 * that looks like it is working, which is why the field never reports it. The
 * error state is required: while the query is still pending the provider is
 * ALSO rendering `DEFAULT_PUBLIC_CONFIG` through `placeholderData`, and that
 * is an ordinary first paint, not a defect worth an operator-visible event.
 */
export function shouldReportDefaultsPaint(
  isError: boolean,
  data: PublicConfig | undefined,
  snapshot: PublicConfig | null,
): boolean {
  return (
    isError && selectBrandingProviderConfig(data, snapshot) === DEFAULT_PUBLIC_CONFIG
  );
}

/**
 * How long the cabinet may paint its built-in identity before that is worth an
 * operator-visible event.
 *
 * The bootstrap has ONE retry policy — the 15s poll above — and a single failed
 * attempt is ordinary: a carrier hiccup on a launch that has not reached the
 * VPN yet, a 429 out of the shared `/api` budget, an upstream still warming.
 * The report used to fire on that first failure, so a state that fixed itself
 * on the very next tick reached the operator as an ERROR, with a user agent and
 * a Telegram message behind it — one iPhone on a flaky network at 01:27
 * (18.09.2026) was exactly that.
 *
 * Three ticks in a row failing is not a hiccup: that client cannot read the
 * operator's configuration at all, and is looking at stock Reiwa — the state
 * this report exists to surface. The window is deliberately longer than two
 * poll intervals so it can only elapse after the poll itself has failed twice
 * more; a payload landing at any point before it cancels the report outright.
 */
export const DEFAULTS_PAINT_REPORT_AFTER_MS = 45_000;

/** What the operator is told, once the window above has passed unbranded. */
export const DEFAULTS_PAINT_MESSAGE =
  `public-config unavailable for ${Math.round(DEFAULTS_PAINT_REPORT_AFTER_MS / 1000)}s ` +
  "(every attempt since the launch failed) and no local snapshot: " +
  "cabinet is painting built-in default branding";
