import type { NavigateFunction } from "react-router";

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
 * True when the hint has a button worth drawing.
 *
 * `ROUTE` and `EXTERNAL` only. A kind a newer panel introduces would otherwise
 * render a control that does nothing, closes the hint and reports `acted` — a
 * dead button counted as the hint working.
 */
export function hasHintCta(hint: CabinetHint): boolean {
  return (
    (hint.ctaKind === "ROUTE" || hint.ctaKind === "EXTERNAL") &&
    typeof hint.ctaTarget === "string" &&
    hint.ctaTarget.length > 0 &&
    typeof hint.ctaLabel === "string" &&
    hint.ctaLabel.length > 0
  );
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
    void navigate(hint.ctaTarget);
    return;
  }
  if (hint.ctaKind === "EXTERNAL" && hint.ctaTarget) {
    openExternalUrl(hint.ctaTarget);
  }
}
