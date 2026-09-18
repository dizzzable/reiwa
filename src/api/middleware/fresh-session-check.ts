/**
 * A FRESH answer to "was this session signed out?" before money moves or a
 * credential changes.
 *
 * The session middleware asks the panel at most once a minute per session and
 * lets a request through when the panel cannot tell (`session-revocation.ts`):
 * right for reading a dashboard, wrong for a withdrawal. A session signed out a
 * few seconds ago — the owner pressed «Выйти на всех устройствах», or reset the
 * password, to lock out whoever else was signed in — kept a minute in which it
 * could still request a withdrawal, pay with the balance, change the password,
 * or link a Telegram or an e-mail of its own.
 *
 * Before those routes this asks again, whatever the minute says, and FAILS
 * CLOSED: when the panel cannot say, the action is refused with a code the
 * cabinet explains (`SESSION_CHECK_UNAVAILABLE`, 503) — nothing moved, try
 * again. A session the panel says was signed out is ended here and now (401
 * `SESSION_REVOKED`, the browser goes back to sign-in). One answer is not a
 * refusal: a panel with no such route predates the sign-out itself, so nothing
 * of this customer was ever revoked by it — during the rollout the cabinet runs
 * ahead of its panel, and its money routes must keep working.
 *
 * A request carried by a Telegram session alone, with no web session, has
 * nothing the panel could have signed out, and is let through as before.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { isSignedOutBy } from "../../infrastructure/redis/session.js";
import { FRESH_ANSWER_DEADLINE_MS, askSessionState, type SessionStateSource } from "../lib/session-revocation.js";
import { getRequestLogger } from "./logger-accessor.js";

export const SESSION_CHECK_UNAVAILABLE = "SESSION_CHECK_UNAVAILABLE";
export const SESSION_REVOKED = "SESSION_REVOKED";

export interface FreshSessionCheckOptions {
  readonly clock?: () => number;
  readonly deadlineMs?: number;
}

export function createFreshSessionCheck(
  webAuth: SessionStateSource | null,
  options: FreshSessionCheckOptions = {},
): RequestHandler {
  const { clock, deadlineMs = FRESH_ANSWER_DEADLINE_MS } = options;
  return async function requireFreshSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    const session = req.webSession;
    // No web session: a Telegram session, or none — the route's own auth
    // decides. No panel: nothing could have been revoked, and the route has no
    // panel to act on either.
    if (!session || webAuth === null) {
      next();
      return;
    }
    const answer = await askSessionState(webAuth, session.userId, {
      deadlineMs,
      ...(clock === undefined ? {} : { clock }),
    });
    if (answer.kind === "unknown") {
      getRequestLogger(req).warn(
        { component: "FreshSessionCheck", reason: answer.reason },
        "refused: the panel could not say whether the session was signed out",
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({
        code: SESSION_CHECK_UNAVAILABLE,
        message: "Could not confirm that this sign-in is still valid. Nothing was changed. Try again in a minute.",
      });
      return;
    }
    if (answer.kind === "answered" && isSignedOutBy(session, answer.state)) {
      await req.destroyWebSession?.();
      res.setHeader("Cache-Control", "no-store");
      res.status(401).json({ code: SESSION_REVOKED, message: "This session was signed out. Sign in again." });
      return;
    }
    next();
  };
}
