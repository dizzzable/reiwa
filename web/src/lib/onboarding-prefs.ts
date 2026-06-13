/**
 * onboardingPrefs
 * ───────────────
 * Non-authoritative, per-browser onboarding UX state for the web cabinet:
 *   - `tutorialSeen`     — the intro tutorial was completed/dismissed (one-shot).
 *   - `trialDeclined`    — the user dismissed the trial offer (→ demo tutorial).
 *   - `lastOfferShownAt` — epoch ms the web trial offer was last surfaced, used
 *                          to throttle how often the cabinet re-shows it.
 *
 * This is pure UX state — it never gates money or auth (those are server-side:
 * claim = `WebAccount` existence, conversion = active `Subscription`). So it
 * lives in `localStorage` with a graceful in-memory fallback when storage is
 * unavailable (private mode): the offer may re-show next session, but nothing
 * breaks. See `.kiro/specs/web-cabinet-onboarding`.
 */

export interface OnboardingPrefs {
  tutorialSeen: boolean;
  trialDeclined: boolean;
  lastOfferShownAt: number | null;
}

const STORAGE_KEY = "reiwa_onboarding_prefs";

/** Re-show the web trial offer at most once per this window. */
export const WEB_OFFER_THROTTLE_MS = 24 * 60 * 60 * 1000;

const DEFAULTS: OnboardingPrefs = {
  tutorialSeen: false,
  trialDeclined: false,
  lastOfferShownAt: null,
};

// In-memory fallback used when localStorage throws (private mode / disabled).
let memoryFallback: OnboardingPrefs = { ...DEFAULTS };

export function readOnboardingPrefs(): OnboardingPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...memoryFallback };
    const parsed = JSON.parse(raw) as Partial<OnboardingPrefs>;
    return {
      tutorialSeen: parsed.tutorialSeen === true,
      trialDeclined: parsed.trialDeclined === true,
      lastOfferShownAt:
        typeof parsed.lastOfferShownAt === "number" ? parsed.lastOfferShownAt : null,
    };
  } catch {
    return { ...memoryFallback };
  }
}

export function writeOnboardingPrefs(patch: Partial<OnboardingPrefs>): OnboardingPrefs {
  const next = { ...readOnboardingPrefs(), ...patch };
  memoryFallback = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* in-memory only — non-fatal */
  }
  return next;
}

/**
 * Whether the web cabinet may surface the trial offer right now, given the
 * throttle window. The bot button is NOT throttled — only the web offer is.
 */
export function shouldShowWebOffer(prefs: OnboardingPrefs, now: number = Date.now()): boolean {
  if (prefs.lastOfferShownAt === null) return true;
  return now - prefs.lastOfferShownAt >= WEB_OFFER_THROTTLE_MS;
}
