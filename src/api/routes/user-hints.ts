import { Router } from "express";

import { UpstreamError } from "../../core/errors/index.js";
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
 * answers `{ hint: null }` or `{ ok: false }` and is logged instead — at WARN,
 * throttled, see `reportPanelFailure`.
 */
/**
 * The pop-up modes THIS cabinet image can put on screen.
 *
 * The single source of truth is the controller that draws them
 * (`web/src/features/hints/hint-controller.tsx`), and this must be widened in
 * the same commit that teaches it a new one — a mode listed here and not drawn
 * is the exact failure the declaration exists to prevent, only now caused from
 * this side. `hint-modes-are-declared.test.ts` compares the two.
 *
 * ── It travels as a HEADER, and that is the whole reason the pair is safe ────
 *
 * It was a field of the request body. The panel validates that body with a
 * global pipe configured `forbidNonWhitelisted`, so a panel whose DTO has not
 * learned the field yet does not IGNORE it — it answers 400. A cabinet upgraded
 * before its panel would therefore have had every single hint request rejected,
 * and the route swallows the failure into `{ hint: null }`: no hints for
 * anybody, and — while those failures were logged at debug — nothing anywhere
 * saying why.
 *
 * A header an old panel has never heard of is simply not read. That is the only
 * shape of this negotiation that survives being deployed in either order.
 */
const DRAWABLE_HINT_MODES = ["MODAL", "TOAST"] as const;

/**
 * How often one route may say that the panel failed it, per process.
 *
 * ── Why these failures are WARN now ────────────────────────────────────────
 *
 * They were `debug`, which the default log level does not print. An operator
 * whose pop-ups never arrived — a panel that refuses every ask, an expired
 * token, a panel that is simply down — had no trace of it anywhere: the
 * customer is answered "nothing to show" either way, by design, so the log is
 * the only place the failure can surface at all.
 *
 * ── Why throttled ──────────────────────────────────────────────────────────
 *
 * Every cabinet page load asks, so an unreachable panel fails once per
 * customer per visit. One line per failure would bury the log in the very
 * outage it reports. The first failure of a route warns at once, later ones
 * are counted, and the next warn — at most a minute on — says how many were
 * kept quiet, so a long outage still shows up every minute and a blip costs
 * one line.
 */
const PANEL_FAILURE_WARN_INTERVAL_MS = 60_000;

/** The longest stretch of the panel's own words carried into one log line. */
const PANEL_MESSAGE_MAX_CHARS = 300;

type HintRoute = "/hints/next" | "/hints/moment" | "/hints/shown" | "/hints/closed";

export function createUserHintsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  /** Injectable clock for the warn throttle; tests drive the window with it. */
  now?: () => number;
}) {
  const { adminClient, sessionStore } = deps;
  const clock = deps.now ?? Date.now;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  /**
   * Per route: when it last warned, and how many failures it has kept quiet
   * about since. Lives in the router, which the API builds once per process —
   * so a test that builds two apps gets two throttles, not one shared by both.
   */
  const lastWarned = new Map<HintRoute, { at: number; suppressed: number }>();

  /**
   * A panel failure, told to the operator without telling them who.
   *
   * The context is the route, the HTTP status and the panel's own message when
   * the panel answered, or the failure's code and text when it did not — and
   * nothing else. No identity, no delivery id, no request body: those are the
   * customer's, and the route alone says which call failed.
   */
  function reportPanelFailure(
    req: AuthRequest,
    route: HintRoute,
    what: string,
    err: unknown,
  ): void {
    const at = clock();
    const previous = lastWarned.get(route);
    if (previous !== undefined && at - previous.at < PANEL_FAILURE_WARN_INTERVAL_MS) {
      previous.suppressed += 1;
      return;
    }
    const suppressed = previous?.suppressed ?? 0;
    lastWarned.set(route, { at, suppressed: 0 });

    // NOTHING IN HERE MAY REACH THE CUSTOMER. This runs inside the `catch`
    // that is about to answer "no hint", and Express 5 turns anything thrown
    // out of it into a 500 — so an error too strange to describe would have
    // broken the one promise this route makes. The answer outranks the line.
    try {
      const failure = describePanelFailure(err);
      const answer =
        "status" in failure
          ? `the panel answered ${failure.status}`
          : "the call failed before the panel answered";
      const quiet =
        suppressed > 0 ? `; ${suppressed} more kept quiet since the last warning` : "";
      req.log?.warn(
        { route, ...failure, suppressedSinceLastWarn: suppressed },
        `hints: ${what} — ${answer}${quiet}`,
      );
    } catch {
      // Unlogged, deliberately: see above.
    }
  }

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
      const answer = await adminClient.userHints.next(
        { ...identity, ...audienceOf(req) },
        [...DRAWABLE_HINT_MODES],
      );
      res.json(answer);
    } catch (err: unknown) {
      reportPanelFailure(
        req,
        "/hints/next",
        "could not read the queue, so the customer was shown no hint",
        err,
      );
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
      reportPanelFailure(
        req,
        "/hints/moment",
        "could not raise the subscription-ready moment, so its hint was not queued",
        err,
      );
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
      reportPanelFailure(
        req,
        "/hints/shown",
        "could not stamp a hint shown, so it may be shown once more",
        err,
      );
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
      reportPanelFailure(
        req,
        "/hints/closed",
        "could not record how a hint ended (acted or dismissed)",
        err,
      );
      res.json({ ok: false });
    }
  });

  return router;
}

/**
 * What went wrong, in fields a log pipeline can filter on.
 *
 * `UpstreamError` is what the admin transport throws for any non-2xx answer;
 * it carries the status and the raw body. Anything else never got an HTTP
 * answer at all — a refused connection, a timeout — or is a bug on this side,
 * and its code and text are what say which.
 */
function describePanelFailure(
  err: unknown,
): { status: number; panelMessage: string } | { errorCode?: string; error: string } {
  if (err instanceof UpstreamError) {
    return { status: err.status, panelMessage: panelMessageOf(err.body) };
  }
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return {
    ...(typeof code === "string" && code.length > 0 ? { errorCode: code } : {}),
    error: clip(textOf(err)),
  };
}

/**
 * The panel's own sentence out of an error body.
 *
 * Nest answers `{ statusCode, message, error, … }`, with `message` a string or
 * — for a validation refusal — a list of them. Anything else, an edge's HTML
 * page or a proxy's plain text, is carried as it came, clipped.
 */
function panelMessageOf(body: string): string {
  let text = body;
  try {
    const parsed: unknown = JSON.parse(body);
    const message =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { message?: unknown }).message
        : undefined;
    if (typeof message === "string") {
      text = message;
    } else if (Array.isArray(message)) {
      const parts = message.filter((part): part is string => typeof part === "string");
      if (parts.length > 0) text = parts.join("; ");
    }
  } catch {
    // Not JSON: carried as it came.
  }
  return clip(text);
}

/** A thrown value as text. May throw on an exotic value; its caller catches. */
function textOf(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** One line, bounded: whitespace collapsed, and cut with a mark that says so. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PANEL_MESSAGE_MAX_CHARS
    ? flat
    : `${flat.slice(0, PANEL_MESSAGE_MAX_CHARS - 1)}…`;
}
