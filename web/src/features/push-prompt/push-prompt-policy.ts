/**
 * When the dashboard may offer browser push after a purchase — the decisions,
 * apart from the card that shows them.
 *
 * All of these must hold, and the ones that need no network come first:
 *   - the tab was marked eligible in the last 30 minutes (`push-prompt-storage`);
 *   - this browser was never shown the prompt;
 *   - not inside the Telegram Mini App: the bot is the channel there;
 *   - `detectPushSupport()` says `supported`;
 *   - on an iPhone or iPad only as a web app added to the Home Screen — the one
 *     place iOS and iPadOS deliver web push. `detectPushSupport()` already
 *     refuses a browser tab there (both read `isAppleMobileDevice()`, which sees
 *     through iPadOS's Mac user agent); the card asks again with its own
 *     `appleMobile` and `standalone`, so the offer never rests on one reader;
 *   - the permission is still `default`: after `denied` the browser would not
 *     ask again, and `granted` needs no asking;
 * and then, before the card appears (`push-prompt-card.tsx`): the operator's
 * public VAPID key was fetched and is not empty, and this browser has no push
 * subscription yet.
 */

import type { PushSupportStatus } from "@/lib/push";

export type PushPromptRefusal =
  | "not-eligible"
  | "already-shown"
  | "telegram-mini-app"
  | "unsupported"
  | "apple-browser-tab"
  | "permission-not-default";

export interface PushPromptEnvironment {
  readonly eligible: boolean;
  readonly alreadyShown: boolean;
  readonly inTelegramMiniApp: boolean;
  readonly support: PushSupportStatus;
  readonly appleMobile: boolean;
  readonly standalone: boolean;
  /** `Notification.permission`, or `null` where the API is missing. */
  readonly permission: NotificationPermission | null;
}

/** Why the prompt must not show, or `null` when every synchronous condition holds. */
export function pushPromptRefusal(env: PushPromptEnvironment): PushPromptRefusal | null {
  if (!env.eligible) return "not-eligible";
  if (env.alreadyShown) return "already-shown";
  if (env.inTelegramMiniApp) return "telegram-mini-app";
  if (env.support !== "supported") return "unsupported";
  if (env.appleMobile && !env.standalone) return "apple-browser-tab";
  if (env.permission !== "default") return "permission-not-default";
  return null;
}

/**
 * Whether the prompt must keep waiting for the onboarding tour: it is on screen
 * (`isActive`), or it is about to start by itself (`autoStartPending` — a
 * customer who has not seen it, 600 ms after the new subscription's card
 * settles). Both come from the tour provider (`onboarding-tour-controller.tsx`),
 * which owns them; `web/test/push-prompt-tour-contract.test.tsx` holds the
 * prompt to the real tour.
 */
export function mustWaitForTour(input: { readonly tourActive: boolean; readonly tourPending: boolean }): boolean {
  return input.tourActive || input.tourPending;
}
