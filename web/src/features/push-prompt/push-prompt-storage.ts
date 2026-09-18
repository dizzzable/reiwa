/**
 * What the push prompt remembers, and where.
 *
 * ── Eligibility: this tab, 30 minutes ──────────────────────────────────────
 *
 * The prompt is offered only right after something was bought or started: a
 * subscription became ready (a purchase or a free trial —
 * `SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT`), a payment returned paid
 * (`/payment-return`), or a renewal was paid from the partner balance. Those
 * places mark it here — `sessionStorage`, so it belongs to this tab — and the
 * dashboard reads it. After 30 minutes the moment has passed.
 *
 * Kept free of imports on purpose: the payment-return and renewal pages call
 * `markPushPromptEligible()`, and must not pull the card, the push helpers or
 * the API client in with it.
 *
 * ── The record: this browser profile, forever ─────────────────────────────
 *
 * `reiwa:push-prompt:v1` in `localStorage` says the prompt was shown here, and
 * later how it ended: `accepted`, `denied`, `failed` or `dismissed`
 * («Не сейчас»). ANY value there means it is never shown again — push
 * permission belongs to the browser, so one browser is asked once. Where
 * storage throws (a private window, blocked site data) the record lives in
 * memory for the rest of the page's life instead: once per visit is the best
 * such a browser allows, and a crash is not an option.
 */

export const PUSH_PROMPT_ELIGIBLE_KEY = "reiwa:push-prompt-eligible";
export const PUSH_PROMPT_RECORD_KEY = "reiwa:push-prompt:v1";
export const PUSH_PROMPT_ELIGIBLE_TTL_MS = 30 * 60 * 1000;
/** A mark from the future beyond this is not trusted (a clock moved back). */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type PushPromptOutcome = "accepted" | "denied" | "failed" | "dismissed";
export type PushPromptRecordState = "shown" | PushPromptOutcome;

let eligibleInMemory: string | null = null;
let recordInMemory: string | null = null;

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(store: Storage | null, key: string): string | null {
  if (store === null) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** `true` when the value reached storage; `false` sends the caller to memory. */
function write(store: Storage | null, key: string, value: string): boolean {
  if (store === null) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** A purchase, a trial or a paid renewal just finished: offer push on the dashboard. */
export function markPushPromptEligible(now: number = Date.now()): void {
  const value = JSON.stringify({ at: now });
  eligibleInMemory = value;
  write(sessionStore(), PUSH_PROMPT_ELIGIBLE_KEY, value);
}

/** Whether this tab was marked within the last 30 minutes. */
export function isPushPromptEligible(now: number = Date.now()): boolean {
  const raw = read(sessionStore(), PUSH_PROMPT_ELIGIBLE_KEY) ?? eligibleInMemory;
  if (raw === null) return false;
  let at: unknown;
  try {
    at = (JSON.parse(raw) as { at?: unknown } | null)?.at;
  } catch {
    return false;
  }
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  return at <= now + MAX_FUTURE_SKEW_MS && now - at <= PUSH_PROMPT_ELIGIBLE_TTL_MS;
}

export function clearPushPromptEligibility(): void {
  eligibleInMemory = null;
  const store = sessionStore();
  if (store === null) return;
  try {
    store.removeItem(PUSH_PROMPT_ELIGIBLE_KEY);
  } catch {
    // Nothing to undo: it expires on its own.
  }
}

/** Whether this browser was ever shown the prompt. Any value counts, unreadable ones included. */
export function wasPushPromptShown(): boolean {
  return read(localStore(), PUSH_PROMPT_RECORD_KEY) !== null || recordInMemory !== null;
}

export function writePushPromptRecord(state: PushPromptRecordState, now: number = Date.now()): void {
  const value = JSON.stringify({ state, at: now });
  // Memory first, whatever storage does: the rest of this page's life must see
  // it even when the write below is refused.
  recordInMemory = value;
  write(localStore(), PUSH_PROMPT_RECORD_KEY, value);
}

/** The stored record, for the card and its tests; `null` when none can be read. */
export function readPushPromptRecord(): { state: string; at: number } | null {
  const raw = read(localStore(), PUSH_PROMPT_RECORD_KEY) ?? recordInMemory;
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown; at?: unknown } | null;
    if (typeof parsed?.state !== "string" || typeof parsed.at !== "number") return null;
    return { state: parsed.state, at: parsed.at };
  } catch {
    return null;
  }
}

/** Tests only: forget the in-memory copies a previous case left behind. */
export function resetPushPromptMemoryForTests(): void {
  eligibleInMemory = null;
  recordInMemory = null;
}
