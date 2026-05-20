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
