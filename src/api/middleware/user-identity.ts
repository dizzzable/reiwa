import type { Request } from "express";
import type { AuthRequest } from "./session.js";

/**
 * Canonical caller identity for rezeis internal calls.
 *
 * `userId` is the reiwa_id (CUID) — the stable identifier that works for
 * every user including browser-registered ones with no Telegram.
 * `telegramId` is the legacy/Telegram-only fallback.
 *
 * Resolution order prefers the WebSession's reiwa_id (set for web,
 * Mini App magic-link and bot magic-link logins) and falls back to the
 * legacy Telegram session's `telegramId`. rezeis accepts either.
 */
export interface ResolvedUserIdentity {
  readonly userId?: string;
  readonly telegramId?: string;
}

export function resolveUserIdentity(req: Request | AuthRequest): ResolvedUserIdentity {
  const identity: { userId?: string; telegramId?: string } = {};
  const webUserId = req.webSession?.userId;
  if (typeof webUserId === "string" && webUserId.length > 0) {
    identity.userId = webUserId;
  }
  const telegramId = (req as AuthRequest).telegramId;
  if (typeof telegramId === "string" && telegramId.length > 0) {
    identity.telegramId = telegramId;
  }
  return identity;
}

/**
 * True when the request carries a usable identity (either a WebSession
 * reiwa_id or a legacy Telegram id). Purchase routes require this.
 */
export function hasUserIdentity(req: Request | AuthRequest): boolean {
  const identity = resolveUserIdentity(req);
  return identity.userId !== undefined || identity.telegramId !== undefined;
}
