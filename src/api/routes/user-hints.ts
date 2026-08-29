import { Router } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";

/**
 * In-cabinet hints — the cabinet's side of the queue.
 *
 * ── Identity comes from the session, never from the body ──────────────────
 *
 * The same rule every route here follows, and it matters more than usual: a
 * body that named its own user id would let anybody read a stranger's queued
 * hints, and hints are raised by events like "your payment failed" and "your
 * subscription ended". That is a readable trail of somebody else's account.
 *
 * The surface and form factor DO come from the body, because only the browser
 * knows them — but they can only narrow what this session is already entitled
 * to see, so lying about them wins nothing.
 *
 * ── Failures are silent, not loud ─────────────────────────────────────────
 *
 * A hint is a convenience. When the panel is unreachable the cabinet must
 * render its page as though there were nothing to show, rather than surface an
 * error about a feature the customer did not ask for. So every failure here
 * answers `{ hint: null }` or `{ ok: false }` and is logged instead.
 */
export function createUserHintsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
}) {
  const { adminClient, sessionStore } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  /** Identity for the upstream call, taken from the session alone. */
  function identityOf(req: AuthRequest): { userId?: string; telegramId?: string } | null {
    const userId = req.webSession?.userId;
    if (typeof userId === "string" && userId.length > 0) return { userId };
    const telegramId = req.session?.telegramId;
    if (typeof telegramId === "string" && telegramId.length > 0) return { telegramId };
    return null;
  }

  /** The audience half, which only the client can know. Narrowing only. */
  function audienceOf(req: AuthRequest): {
    surface?: "tma" | "pwa" | "browser";
    formFactor?: "mobile" | "tablet" | "desktop";
    locale?: "ru" | "en";
  } {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const surface = body.surface;
    const formFactor = body.formFactor;
    const locale = body.locale;
    return {
      surface:
        surface === "tma" || surface === "pwa" || surface === "browser" ? surface : undefined,
      formFactor:
        formFactor === "mobile" || formFactor === "tablet" || formFactor === "desktop"
          ? formFactor
          : undefined,
      locale: locale === "en" ? "en" : "ru",
    };
  }

  router.post("/hints/next", requireSession, async (req: AuthRequest, res) => {
    const identity = identityOf(req);
    if (identity === null || adminClient === null) {
      res.json({ hint: null });
      return;
    }
    try {
      const answer = await adminClient.userHints.next({ ...identity, ...audienceOf(req) });
      res.json(answer);
    } catch (err: unknown) {
      req.log?.debug({ err }, "hints: could not read the queue");
      res.json({ hint: null });
    }
  });

  /**
   * A moment the cabinet detected. The name is validated upstream against a
   * closed list — a browser must not be able to queue an arbitrary hint out of
   * context, even one addressed to itself.
   */
  router.post("/hints/moment", requireSession, async (req: AuthRequest, res) => {
    const identity = identityOf(req);
    const moment = (req.body as { moment?: unknown } | undefined)?.moment;
    if (identity === null || adminClient === null || moment !== "subscription-ready") {
      res.json({ raised: false });
      return;
    }
    try {
      res.json(await adminClient.userHints.moment({ ...identity, moment }));
    } catch (err: unknown) {
      req.log?.debug({ err }, "hints: could not raise a moment");
      res.json({ raised: false });
    }
  });

  router.post("/hints/shown", requireSession, async (req: AuthRequest, res) => {
    const identity = identityOf(req);
    const deliveryId = (req.body as { deliveryId?: unknown } | undefined)?.deliveryId;
    if (identity === null || adminClient === null || typeof deliveryId !== "string") {
      res.json({ ok: false });
      return;
    }
    try {
      res.json(await adminClient.userHints.markShown({ ...identity, deliveryId }));
    } catch (err: unknown) {
      // Losing this stamp shows the hint once more on the next visit, which is
      // a far better failure than an error over a hint the customer is reading.
      req.log?.debug({ err }, "hints: could not stamp shown");
      res.json({ ok: false });
    }
  });

  router.post("/hints/closed", requireSession, async (req: AuthRequest, res) => {
    const identity = identityOf(req);
    const body = (req.body ?? {}) as { deliveryId?: unknown; outcome?: unknown };
    if (identity === null || adminClient === null || typeof body.deliveryId !== "string") {
      res.json({ ok: false });
      return;
    }
    try {
      res.json(
        await adminClient.userHints.close({
          ...identity,
          deliveryId: body.deliveryId,
          // Anything but an explicit `acted` is a dismissal. The safe default:
          // over-counting "people close it to be rid of it" understates how well
          // a hint works, while the reverse would make every hint look useful.
          outcome: body.outcome === "acted" ? "acted" : "dismissed",
        }),
      );
    } catch (err: unknown) {
      req.log?.debug({ err }, "hints: could not record the outcome");
      res.json({ ok: false });
    }
  });

  return router;
}
