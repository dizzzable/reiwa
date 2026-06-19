/**
 * client-error-reporter
 * ──────────────────────
 * Forwards browser/Mini App runtime errors to the reiwa BFF
 * (`POST /api/v1/client-errors`), which relays them into the rezeis
 * firehose (audit log → Events page → dev DM). This is what makes a
 * crash "on the user's phone" visible to the operator instead of a blind
 * guess.
 *
 * Hardening (a render loop must never DDoS the API):
 *   - dedup: identical message+kind is sent at most once per `DEDUP_MS`.
 *   - cap: at most `MAX_PER_MIN` reports per rolling minute.
 *   - fire-and-forget: uses `fetch(keepalive)` and never throws.
 */
import { getClientSource } from './client-source';

const ENDPOINT = '/api/v1/client-errors';
const DEDUP_MS = 30_000;
const MAX_PER_MIN = 10;

/**
 * Transient / benign browser noise that must NOT reach the operator error feed.
 * Service-worker update/fetch failures happen routinely on redeploy (the cached
 * `sw.js` hash changes) or on flaky mobile networks, and `ResizeObserver loop`
 * is a harmless layout warning. Mirrors the rezeis admin client-logger filter.
 */
const NON_REPORTABLE_PATTERNS: readonly RegExp[] = [
  /failed to (update|register|unregister) a serviceworker/i,
  /an unknown error occurred when fetching the script/i,
  /the script resource is behind a redirect/i,
  /serviceworker.*(fetch|script)/i,
  /resizeobserver loop/i,
  // React vs. 3rd-party/extension DOM reconciliation races (most often a
  // browser translation extension mutating React's tree) — not an app bug.
  /failed to execute '(removechild|insertbefore)' on 'node'/i,
  /the node (to be removed|before which the new node is to be inserted) is not a child of this node/i,
];

const recent = new Map<string, number>();
let windowStart = Date.now();
let windowCount = 0;

export interface ClientErrorInput {
  readonly message: string;
  readonly stack?: string;
  readonly componentStack?: string;
  /** Origin of the report: window.onerror / unhandledrejection / react.errorBoundary. */
  readonly kind?: string;
}

export function reportClientError(input: ClientErrorInput): void {
  try {
    const message = (input.message || '').toString().slice(0, 2000);
    if (message.length === 0) return;

    // Drop transient/benign browser noise (service-worker churn, RO loop) so it
    // never lands in the operator's error feed as an ERROR event.
    if (NON_REPORTABLE_PATTERNS.some((re) => re.test(message))) return;

    const now = Date.now();
    const key = `${input.kind ?? 'error'}:${message}`.slice(0, 200);
    const last = recent.get(key);
    if (last !== undefined && now - last < DEDUP_MS) return;
    recent.set(key, now);
    if (recent.size > 100) recent.clear();

    if (now - windowStart > 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount >= MAX_PER_MIN) return;
    windowCount += 1;

    const payload = JSON.stringify({
      message,
      ...(input.stack ? { stack: input.stack.slice(0, 8000) } : {}),
      ...(input.componentStack ? { componentStack: input.componentStack.slice(0, 8000) } : {}),
      kind: input.kind ?? 'client.error',
      surface: getClientSource(),
      url:
        typeof location !== 'undefined'
          ? `${location.pathname}${location.search}`
          : undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    });

    if (typeof fetch === 'function') {
      void fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        credentials: 'same-origin',
      }).catch(() => undefined);
    } else if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    }
  } catch {
    /* never let error reporting break the app */
  }
}

let installed = false;

/**
 * Wire the global browser error hooks once. React render errors are caught
 * separately by the app-level ErrorBoundary (which has the componentStack).
 */
export function installGlobalErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    reportClientError({
      message: event.message || (event.error instanceof Error ? event.error.message : 'window.onerror'),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      kind: 'window.onerror',
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    reportClientError({
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      kind: 'unhandledrejection',
    });
  });
}
