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
 *     place iOS and iPadOS deliver web push. iPadOS sends a Mac user agent, which
 *     `detectPushSupport()` cannot see through, hence `isAppleMobileDevice()`;
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
 * The onboarding tour's spotlight layer (`SpotlightOverlay`, a full-screen
 * `fixed inset-0 z-[9998]` sheet over the cabinet). The tour exposes no state
 * of its own outside its provider, so its layer is how its presence is read —
 * by the one class token nothing else in the cabinet uses.
 * `web/test/push-prompt-tour-contract.test.tsx` renders the real tour and fails
 * if this stops finding it.
 */
export const ONBOARDING_TOUR_LAYER_SELECTOR = '[class~="z-[9998]"]';

export function isOnboardingTourOnScreen(root: ParentNode | null = typeof document === "undefined" ? null : document): boolean {
  if (root === null) return false;
  return root.querySelector(ONBOARDING_TOUR_LAYER_SELECTOR) !== null;
}

/**
 * How long after the prompt is ready it keeps waiting for a tour that has not
 * appeared yet. The tour starts 600 ms after a new subscription's card settles,
 * for a customer who has not seen it (`onboarding-tour-controller.tsx`); past
 * this, a tour that has not started is not going to, and the prompt stops
 * waiting for it.
 */
export const TOUR_START_GRACE_MS = 3_000;

/**
 * Whether the prompt must keep waiting: the tour is on screen, or it is still
 * due — the session says it has never run — and has had less than the grace
 * period to start.
 */
export function mustWaitForTour(input: {
  readonly tourOnScreen: boolean;
  readonly tourDue: boolean;
  readonly msSinceReady: number;
}): boolean {
  if (input.tourOnScreen) return true;
  return input.tourDue && input.msSinceReady < TOUR_START_GRACE_MS;
}
