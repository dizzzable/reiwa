import { Request, Response, NextFunction } from "express";
import type { SessionStore, ReiwaSession } from "../../lib/session-store.js";

export interface AuthRequest extends Request {
  session?: ReiwaSession;
  telegramId?: string;
}

export function createSessionMiddleware(sessionStore: SessionStore | null) {
  return async function requireSession(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const sessionId = req.cookies?.reiwa_session as string | undefined;
    if (!sessionId || !sessionStore) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const session = await sessionStore.get(sessionId);
    if (!session) {
      res.status(401).json({ message: "Session expired" });
      return;
    }
    req.session = session;
    req.telegramId = session.telegramId;
    await sessionStore.refresh(sessionId);
    next();
  };
}

/**
 * Authentication that accepts EITHER session model:
 *   - WebSession (reiwa_id, `req.webSession.userId`) — web / Mini App /
 *     magic-link logins, including browser-registered users with no
 *     Telegram, OR
 *   - legacy Telegram session (`reiwa_session` cookie → `telegramId`).
 *
 * Used by identity-agnostic routes (purchase / subscription reads) so a
 * web-only user (reiwa_id, no telegramId) is no longer locked out. The
 * WebSession middleware runs globally upstream, so `req.webSession` is
 * already populated when present; here we additionally hydrate the
 * legacy session when its cookie is present.
 */
export function createFlexibleSessionMiddleware(sessionStore: SessionStore | null) {
  return async function requireAnySession(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // 1) WebSession (reiwa_id) — set globally by the web-session middleware.
    if (req.webSession?.userId) {
      // Best-effort: also hydrate the legacy telegram session if its
      // cookie happens to be present (lets routes that still read
      // telegramId keep working for linked users).
      const legacyId = req.cookies?.reiwa_session as string | undefined;
      if (legacyId && sessionStore) {
        const legacy = await sessionStore.get(legacyId);
        if (legacy) {
          req.session = legacy;
          req.telegramId = legacy.telegramId;
          await sessionStore.refresh(legacyId);
        }
      }
      next();
      return;
    }

    // 2) Legacy Telegram session fallback.
    const sessionId = req.cookies?.reiwa_session as string | undefined;
    if (sessionId && sessionStore) {
      const session = await sessionStore.get(sessionId);
      if (session) {
        req.session = session;
        req.telegramId = session.telegramId;
        await sessionStore.refresh(sessionId);
        next();
        return;
      }
    }

    res.status(401).json({ message: "Unauthorized" });
  };
}
