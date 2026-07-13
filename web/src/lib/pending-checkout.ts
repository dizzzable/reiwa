/**
 * pendingCheckout
 * ───────────────
 * A session-scoped bridge that carries the payment provider's `checkoutUrl`
 * (+ retry route + purchase label) from the flow that created the checkout
 * (purchase / upgrade / renewal / addon) to the `PaymentReturnPage`.
 *
 * Why this exists: inside a Telegram Mini App the redirect to the provider is
 * done via `WebApp.openLink(url)`, which — per the Telegram Web Apps spec — may
 * only be called **in response to a user interaction**. Telegram Desktop
 * enforces this strictly: the auto-open call fired from a mutation's async
 * `onSuccess` (after the network round-trip) has already lost the user-gesture
 * context, so nothing opens (mobile clients are lenient, hence the desktop-only
 * report). The fix is to also stash the URL here so the return page can render
 * a manual "Open payment" button that calls `openLink` from a fresh click.
 *
 * Storage: `sessionStorage` (survives the client-side navigate + a manual tab
 * refresh, auto-clears when the tab closes). Entries are keyed by `paymentId`
 * in a small bounded map, so two checkouts started in the same tab no longer
 * overwrite each other's manual-open URL (fixes the one-slot overwrite).
 */

const KEY = "reiwa:pending-checkout";
/** Cap on retained entries — a tab rarely juggles more than a couple of
 *  in-flight checkouts; the oldest is evicted past this. */
const MAX_ENTRIES = 8;

interface PendingCheckout {
  url: string;
  /** SPA route to send the user back to on retry after a failed/timed-out
   *  payment (e.g. "/addons", "/renew", "/upgrade"). Defaults handled by the
   *  return page. */
  returnTo?: string;
  /** Human label of what was purchased (e.g. the add-on name), shown on the
   *  success screen so it names the purchase instead of a generic message. */
  label?: string;
}

type PendingCheckoutMap = Record<string, PendingCheckout>;

function readMap(): PendingCheckoutMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as PendingCheckoutMap)
      : {};
  } catch {
    return {};
  }
}

function writeMap(map: PendingCheckoutMap): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // sessionStorage can throw in private-mode / quota edge cases — the manual
    // button is a best-effort enhancement, so a failure here is non-fatal.
  }
}

function readEntry(paymentId: string): PendingCheckout | null {
  if (!paymentId) return null;
  const entry = readMap()[paymentId];
  return entry && typeof entry.url === "string" ? entry : null;
}

export function savePendingCheckout(
  paymentId: string,
  url: string | null,
  meta?: { returnTo?: string; label?: string },
): void {
  if (typeof window === "undefined") return;
  if (!paymentId || !url) return;
  const map = readMap();
  const record: PendingCheckout = { url };
  if (meta?.returnTo) record.returnTo = meta.returnTo;
  if (meta?.label) record.label = meta.label;
  map[paymentId] = record;
  // Bound the map: drop oldest insertion-order keys past the cap.
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[stale];
    }
  }
  writeMap(map);
}

/** Returns the stashed checkout URL iff it belongs to `paymentId`, else null. */
export function readPendingCheckout(paymentId: string): string | null {
  return readEntry(paymentId)?.url ?? null;
}

/** Returns the stashed `returnTo` route iff it belongs to `paymentId`. */
export function readPendingCheckoutReturnTo(paymentId: string): string | null {
  return readEntry(paymentId)?.returnTo ?? null;
}

/** Returns the stashed purchase `label` iff it belongs to `paymentId`. */
export function readPendingCheckoutLabel(paymentId: string): string | null {
  return readEntry(paymentId)?.label ?? null;
}

/**
 * Clears the entry for `paymentId` (the finished payment). Called with no
 * argument it wipes the whole map (legacy behaviour / hard reset).
 */
export function clearPendingCheckout(paymentId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (!paymentId) {
      window.sessionStorage.removeItem(KEY);
      return;
    }
    const map = readMap();
    if (map[paymentId] !== undefined) {
      delete map[paymentId];
      writeMap(map);
    }
  } catch {
    // ignore
  }
}
