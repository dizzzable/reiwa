import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createOptionalSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity, hasUserIdentity } from "../middleware/user-identity.js";
import { sendSafeError } from "../lib/error-response.js";
import { resolvePurchaseChannel } from "../middleware/user-identity.js";

/**
 * Keys the panel's plan catalog must never put in front of a visitor.
 *
 * Both are the operator's own Remnawave squad identifiers, copied straight off
 * the plan row. `/api/v1/plans` is served behind an OPTIONAL session, so this
 * payload reaches anyone who opens the site — and nothing in this repository,
 * the browser bundle or the bot has ever read either field.
 *
 * The panel stopped sending them in 0.9.7.54. This strip exists because the two
 * images upgrade separately: a cabinet on a NEWER image in front of an older
 * panel would otherwise keep publishing them until the operator got round to
 * the panel, and "it is fixed upstream" is not a thing a visitor benefits from.
 */
const INTERNAL_PLAN_FIELDS = ["internalSquads", "externalSquad"] as const;

/**
 * Drop the internal fields from the catalog, and forward everything else.
 *
 * A DENYLIST here, where `narrowServerList` in `subscription.ts` uses an
 * allow-list, and the difference is deliberate rather than sloppy. That payload
 * is seven flat fields that have not moved in months; this one nests durations,
 * gateway prices, display prices and discount sources, and grows whenever
 * pricing does. An allow-list that fell one field behind the panel would
 * silently drop a PRICE — a broken catalog for everyone, to guard against a
 * field nobody is adding. The cheap failure is the right one to accept: if the
 * panel ever introduces another internal field, it goes in the list above, and
 * the panel-side guard test names the whole public key set so nobody adds one
 * by accident in the first place.
 */
function stripInternalPlanFields(plans: unknown): unknown[] {
  if (!Array.isArray(plans)) return [];
  return plans.map((plan) => {
    if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return plan;
    const copy: Record<string, unknown> = { ...(plan as Record<string, unknown>) };
    for (const field of INTERNAL_PLAN_FIELDS) delete copy[field];
    return copy;
  });
}

export function createPlansRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  const router = Router();
  // Optional session: a logged-in caller's identity is forwarded so the
  // catalog is resolved per context (paid trials + NEW/EXISTING/INVITED
  // plans appear). Logged-out callers still get the anonymous catalog.
  const optionalSession = createOptionalSessionMiddleware(sessionStore);

  // GET /api/v1/plans
  router.get("/plans", optionalSession, async (req: AuthRequest, res) => {
    try {
      const identity = hasUserIdentity(req) ? resolveUserIdentity(req) : undefined;
      const plans = await adminClient?.catalog.getPublicPlans(identity);
      res.json(stripInternalPlanFields(plans));
    } catch (e: unknown) {
      sendSafeError(req, res, e, 500, "Failed to load plans", "plans");
    }
  });

  // GET /api/v1/gateways
  router.get("/gateways", async (req, res) => {
    try {
      // Drop gateways that can't operate in the caller's context. In the
      // browser cabinet (`web`) this hides TELEGRAM_STARS, which only
      // works inside a Telegram invoice. Mini App callers do get Stars —
      // which was the intent all along, but the channel used to be spelled
      // `"TMA"`, a value `PurchaseChannel` has never had, so rezeis fell back
      // to `WEB` and filtered Stars out under this very comment.
      const ctx = (req as { context?: string }).context;
      const channel = resolvePurchaseChannel(ctx);
      const gateways = await adminClient?.payments.getEnabledGateways(channel);
      res.json(gateways ?? []);
    } catch (e: unknown) {
      sendSafeError(req, res, e, 500, "Failed to load gateways", "gateways");
    }
  });

  return router;
}
