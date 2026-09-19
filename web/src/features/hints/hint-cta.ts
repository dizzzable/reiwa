import type { NavigateFunction } from "react-router";

import { openConnectDoorForHint } from "@/features/dashboard/connect-door";
import type { CabinetHint } from "@/lib/api-client/hints";
import { openExternalUrl } from "@/lib/utils";

/**
 * What the button on a hint does, in one place.
 *
 * A hint is drawn two ways now — a modal and a toast — and the decision about
 * its call to action is the same in both: a route is navigated, an external
 * address goes through the shared opener, and a kind this build has not heard
 * of does nothing at all. Two copies of that would drift, and this codebase has
 * documented what happens when they do: the modal used to carry its own opener
 * and got Telegram wrong, showing `t.me` links as a landing page in an in-app
 * browser instead of resolving them natively.
 */

/**
 * The DOORS this build opens itself: symbolic `ROUTE` targets that are not a
 * path but a decision.
 *
 * `@connect` is «Подключить» exactly as the dashboard's button means it — the
 * operator's switch between the cabinet's connect screen and the external
 * subscription page. A plain route to `/subscription/connect` would bypass that
 * switch, which is why the panel refuses one; a door lets a pop-up say
 * "connect" and leaves the how to the cabinet.
 *
 * An older cabinet would navigate to `@connect` as a path, so the panel holds a
 * door back from any cabinet that has not declared it. This list and the one
 * the BFF declares (`DRAWABLE_HINT_DOORS` in `src/api/routes/user-hints.ts`)
 * must be the same list, and so must the cases in `openHintDoor` below —
 * `test/hint-doors-are-declared.test.ts` compares all three.
 */
export const HINT_DOORS = ["@connect"] as const;

/** A `ROUTE` target that names a door rather than a path. */
function isDoorTarget(target: string): boolean {
  return target.startsWith("@");
}

/**
 * True when the hint has a button worth drawing.
 *
 * `ROUTE` and `EXTERNAL` only. A kind a newer panel introduces would otherwise
 * render a control that does nothing, closes the hint and reports `acted` — a
 * dead button counted as the hint working. A door this build does not know is
 * the same dead button, and navigating to its raw name would be worse.
 */
export function hasHintCta(hint: CabinetHint): boolean {
  if (
    !(
      (hint.ctaKind === "ROUTE" || hint.ctaKind === "EXTERNAL") &&
      typeof hint.ctaTarget === "string" &&
      hint.ctaTarget.length > 0 &&
      typeof hint.ctaLabel === "string" &&
      hint.ctaLabel.length > 0
    )
  ) {
    return false;
  }
  if (hint.ctaKind === "ROUTE" && isDoorTarget(hint.ctaTarget)) {
    return (HINT_DOORS as readonly string[]).includes(hint.ctaTarget);
  }
  return true;
}

/**
 * Follow the hint's call to action.
 *
 * `openExternalUrl` rather than a local opener: it classifies the link and
 * picks `openTelegramLink` for `t.me` addresses, and it is the only copy of
 * that decision in the cabinet. "Open our bot" is the most likely external
 * destination an operator will ever author.
 */
export function runHintCta(hint: CabinetHint, navigate: NavigateFunction): void {
  if (hint.ctaKind === "ROUTE" && hint.ctaTarget) {
    if (isDoorTarget(hint.ctaTarget)) {
      openHintDoor(hint.ctaTarget, navigate);
      return;
    }
    void navigate(hint.ctaTarget);
    return;
  }
  if (hint.ctaKind === "EXTERNAL" && hint.ctaTarget) {
    openExternalUrl(hint.ctaTarget);
  }
}

/**
 * Opens one door. A name this build does not know does nothing at all —
 * `hasHintCta` drew no button for it, and a navigation to `@something` would
 * land on the catch-all page.
 */
function openHintDoor(door: string, navigate: NavigateFunction): void {
  switch (door) {
    case "@connect":
      // The pop-up names no subscription: the newest one still waiting for
      // help, else the dashboard's own card. A tap, so the external page may
      // open right here; see `connect-door.ts`.
      openConnectDoorForHint(navigate);
      return;
    default:
      return;
  }
}
