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
  // Chrome/Safari phrasing when the SW (or any worker) script fetch fails
  // during register()/update() — e.g. "Script https://…/sw.js load failed".
  // Routine on redeploy or a flaky mobile network; not an app bug.
  /script .*\bload failed/i,
  /sw\.js.*\bload failed/i,
  /resizeobserver loop/i,
  // React vs. 3rd-party/extension DOM reconciliation races (most often a
  // browser translation extension mutating React's tree) — not an app bug.
  /failed to execute '(removechild|insertbefore)' on 'node'/i,
  /the node (to be removed|before which the new node is to be inserted) is not a child of this node/i,
];

/**
 * URL schemes a browser uses for code IT injected, not code we shipped.
 *
 * Deliberately omits Safari's `webkit-masked-url://`: Safari hides more than
 * extensions behind it, so treating it as foreign would silently discard real
 * reports from our own bundle. A false negative here costs noise; a false
 * positive costs a crash nobody hears about.
 */
const EXTENSION_URL_SCHEMES: readonly string[] = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://',
  'safari-extension://',
  'ms-browser-extension://',
  'opera-extension://',
]

/** Every `scheme://host/...` token in a string, in order. */
const URL_IN_STACK = /\b[a-z][a-z0-9.+-]*:\/\/[^\s)]+/gi

/**
 * Did this error come out of a browser extension AND nowhere else?
 *
 * Wallet extensions in particular throw on almost every page load — two of them
 * racing to define `window.ethereum`, or to register a Solana provider, is a
 * daily event on any desktop with a crypto wallet installed. Those exceptions
 * reach `window.onerror` on OUR page, so without this they arrive in the
 * operator's error feed carrying our service name, our version and our commit,
 * and they crowd out the reports that are actually ours — worst of all during
 * an incident, when the feed is the thing being read.
 *
 * The bar is EVERY located frame, not any. An extension that calls into our
 * code and trips a bug there produces a stack with both origins in it, and that
 * one is ours to fix. Likewise an error with no URL anywhere (`<anonymous>`
 * frames only, or no stack at all) is kept: unattributable is not the same as
 * foreign, and guessing in that direction loses real crashes.
 */
export function isExtensionOriginError(input: {
  readonly filename?: string
  readonly stack?: string
}): boolean {
  const urls: string[] = []
  const filename = normalizeString(input.filename, 2_000)
  if (filename !== undefined) urls.push(filename)
  if (typeof input.stack === 'string') {
    for (const match of input.stack.matchAll(URL_IN_STACK)) urls.push(match[0])
  }
  if (urls.length === 0) return false
  return urls.every((url) => {
    const lower = url.toLowerCase()
    return EXTENSION_URL_SCHEMES.some((scheme) => lower.startsWith(scheme))
  })
}

const recent = new Map<string, number>();
let windowStart = Date.now();
let windowCount = 0;

export interface ClientErrorInput {
  readonly message: string;
  readonly stack?: string;
  readonly componentStack?: string;
  /** Origin of the report: window.onerror / unhandledrejection / react.errorBoundary. */
  readonly kind?: string;
  /** Script location exposed by ErrorEvent for same-origin/CORS-enabled code. */
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly errorName?: string;
}

export function reportClientError(input: ClientErrorInput): void {
  try {
    const message = (input.message || '').toString().slice(0, 2000);
    if (message.length === 0) return;

    // Drop transient/benign browser noise (service-worker churn, RO loop) so it
    // never lands in the operator's error feed as an ERROR event.
    if (NON_REPORTABLE_PATTERNS.some((re) => re.test(message))) return;

    // Same idea, by ORIGIN rather than by wording. Extension exceptions carry
    // ordinary messages ("t is not a function"), so no pattern list can catch
    // them; what gives them away is that every frame lives under an extension
    // scheme. Checked BEFORE the dedup and rate-limit bookkeeping below, so a
    // page full of wallet noise cannot spend the per-minute budget that a real
    // crash needs.
    if (isExtensionOriginError(input)) return;

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

    const filename = normalizeString(input.filename, 2_000);
    const errorName = normalizeString(input.errorName, 128);
    const lineno = normalizePosition(input.lineno);
    const colno = normalizePosition(input.colno);

    const payload = JSON.stringify({
      message,
      ...(input.stack ? { stack: input.stack.slice(0, 8000) } : {}),
      ...(input.componentStack ? { componentStack: input.componentStack.slice(0, 8000) } : {}),
      kind: input.kind ?? 'client.error',
      surface: getClientSource(),
      ...(filename ? { filename } : {}),
      ...(lineno !== undefined ? { lineno } : {}),
      ...(colno !== undefined ? { colno } : {}),
      ...(errorName ? { errorName } : {}),
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

function normalizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined
}

function normalizePosition(value: unknown): number | undefined {
  // ErrorEvent uses zero when a location is unavailable; JavaScript source
  // positions are 1-based, so keep zero out of operator reports.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function getErrorName(value: unknown): string | undefined {
  if (value instanceof Error) return normalizeString(value.name, 128)
  if (typeof value !== 'object' || value === null) return undefined
  return normalizeString((value as { name?: unknown }).name, 128)
}

/**
 * Browsers intentionally redact a cross-origin script exception to this bare
 * shape. With no stack, URL or source position it is not actionable; a
 * same-origin/CORS-enabled error keeps at least one of those details and is
 * still reported normally.
 */
function isOpaqueCrossOriginScriptError(event: ErrorEvent): boolean {
  return (
    /^script error\.?$/i.test(event.message.trim()) &&
    event.error == null &&
    !normalizeString(event.filename, 2_000) &&
    normalizePosition(event.lineno) === undefined &&
    normalizePosition(event.colno) === undefined
  )
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
    if (isOpaqueCrossOriginScriptError(event)) return
    const error = event.error
    reportClientError({
      message: event.message || (error instanceof Error ? error.message : 'window.onerror'),
      stack: error instanceof Error ? error.stack : undefined,
      kind: 'window.onerror',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      errorName: getErrorName(error),
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
