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

/**
 * The purchase channel rezeis understands for a request's context.
 *
 * `PurchaseChannel` has exactly two members, `WEB` and `TELEGRAM`. Three call
 * sites used to spell the Mini App case `"TMA"`, which is not one of them,
 * and the three failed differently:
 *
 *   • the gateway list takes it as a query and rezeis silently falls back to
 *     `WEB`, which filters Telegram Stars out of the Mini App — under a
 *     comment claiming the opposite;
 *   • renewal options and partner-balance checkout put it in a body behind
 *     `@IsEnum(PurchaseChannel)` with `forbidNonWhitelisted`, so those two
 *     answered 400 for every Mini App caller.
 *
 * One function now, so the next caller cannot invent a fourth spelling.
 */
export function resolvePurchaseChannel(context: string | undefined): 'WEB' | 'TELEGRAM' {
  return context === 'tma' ? 'TELEGRAM' : 'WEB';
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
