/**
 * pendingCheckout
 * ───────────────
 * A one-slot, session-scoped bridge that carries the payment provider's
 * `checkoutUrl` from the flow that created the checkout (purchase / upgrade /
 * renewal / addon) to the `PaymentReturnPage`.
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
 * refresh, auto-clears when the tab closes). Keyed by `paymentId` so a stale
 * URL from a previous attempt can never be shown for a different payment.
 */

const KEY = "reiwa:pending-checkout";

interface PendingCheckout {
  paymentId: string;
  url: string;
}

export function savePendingCheckout(paymentId: string, url: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!paymentId || !url) {
      window.sessionStorage.removeItem(KEY);
      return;
    }
    window.sessionStorage.setItem(KEY, JSON.stringify({ paymentId, url }));
  } catch {
    // sessionStorage can throw in private-mode / quota edge cases — the manual
    // button is a best-effort enhancement, so a failure here is non-fatal.
  }
}

/** Returns the stashed checkout URL iff it belongs to `paymentId`, else null. */
export function readPendingCheckout(paymentId: string): string | null {
  if (typeof window === "undefined" || !paymentId) return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingCheckout>;
    if (parsed?.paymentId === paymentId && typeof parsed.url === "string") {
      return parsed.url;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPendingCheckout(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
