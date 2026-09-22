/**
 * `POST /api/v1/auth/browser-key` — a one-time key to open the cabinet in the
 * phone's own browser, already signed in.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * «Кабинет» in the bot used to be a plain link with a sign-in key stamped into
 * it when the menu was DRAWN. Telegram, not the bot, decides where a link
 * opens, and on a phone that is its own in-app browser; and the key lives five
 * minutes while the menu stays in the chat for days, so a tap later than that
 * reached the sign-in form. Now the button opens the Mini App
 * (`/open-in-browser`), which asks this route for a key — with the tap's own
 * launch data — and hands it to `openLink`.
 * Nothing is baked into a message, so there is nothing to forward and nothing
 * to go stale (owner's decision, 22.09.2026).
 *
 * ── The same key as the bot's ───────────────────────────────────────────────
 *
 * It is `bot-signin`, issued by the panel for this account's Telegram id and
 * spent by `POST /auth/bot-signin` like every key the bot has ever handed out:
 * single use, taken atomically (`RawCacheService.take`), five minutes. One
 * mechanism, one consumer, one set of tests — this route only decides WHO may
 * ask: a signed-in session, for its own Telegram account and nobody else's.
 *
 * ── The session must be the account that tapped ──────────────────────────────
 *
 * The Mini App runs on its cookie session, and uses Telegram's launch data only
 * when it has none (`stealth-layout.tsx`, `tma-bootstrap-page.tsx`). Telegram
 * keeps several accounts in one app, with ONE cookie store: account B opening
 * the Mini App on a phone where account A signed in earlier is A in the cabinet.
 * That predates this route — but a key minted here for the session would hand
 * B a browser signed in as A, outside Telegram, for as long as that browser
 * keeps the session. So the key is issued only against the launch data of the
 * tap itself (`Authorization: tma <initData>`), verified with the bot token's
 * HMAC like `/auth/telegram/bootstrap` does, and only when its user IS this
 * session's Telegram account. Never an unsigned id.
 *
 * ── What it deliberately does not check ─────────────────────────────────────
 *
 * «Канал обязателен». The Mini App walls its whole screen until the gate
 * passes, and this is only reached from inside it; the browser cabinet is not
 * gated at all (owner's decision, 14.09.2026), so a refusal here would stop
 * nobody who could not simply sign in on the website.
 */
import { Router, type Response } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import { validateTelegramInitData } from "../../lib/telegram-auth.js";
import { createTelegramUserIdCache, parseTelegramUserId } from "../lib/telegram-user-id.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { createAccountRateLimiter } from "../middleware/rate-limit.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";

/** Keys one account may ask for per window: a tap every thirty seconds for ten minutes. */
export const BROWSER_KEY_LIMIT = 20;
export const BROWSER_KEY_WINDOW_MS = 10 * 60 * 1000;

export interface BrowserKeyRouterDeps {
  readonly adminClient: AdminClient | null;
  readonly sessionStore: SessionStore | null;
  /** For the launch data's HMAC; without it no key can be issued. */
  readonly config: { readonly BOT_TOKEN?: string | null };
}

/** The Telegram user the tap's launch data names, verified — or why there is none. */
type LaunchUser =
  | { readonly kind: "verified"; readonly id: number }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

function launchUserOf(authorization: string | undefined, botToken: string): LaunchUser {
  const initData = (authorization ?? "").replace(/^tma\s+/i, "").trim();
  if (initData.length === 0) return { kind: "missing" };
  // A forged or tampered payload, or one older than the 24 h window.
  const user = validateTelegramInitData(initData, botToken);
  return user !== null && Number.isSafeInteger(user.id) ? { kind: "verified", id: user.id } : { kind: "invalid" };
}

export function createBrowserKeyRouter(deps: BrowserKeyRouterDeps): Router {
  const { adminClient } = deps;
  const botToken = deps.config.BOT_TOKEN ?? null;
  const requireSession = createFlexibleSessionMiddleware(deps.sessionStore);
  const limiter = createAccountRateLimiter({ windowMs: BROWSER_KEY_WINDOW_MS, limit: BROWSER_KEY_LIMIT });
  const telegramUserIds = createTelegramUserIdCache({
    lookup: async (userId) => {
      if (adminClient === null) throw new Error("AdminClient not configured");
      const session = (await adminClient.user.getSession({ userId })) as
        | { readonly telegramId?: unknown }
        | null
        | undefined;
      return session?.telegramId ?? null;
    },
  });

  /** This session's own Telegram id; `null` for an account that has none. */
  async function telegramIdOf(req: AuthRequest): Promise<number | null> {
    const accountId = req.webSession?.userId;
    if (typeof accountId === "string" && accountId.length > 0) return telegramUserIds.resolve(accountId);
    return parseTelegramUserId(req.telegramId);
  }

  const router = Router();
  // The session guard comes FIRST: the budget is counted per account, and a
  // caller that has none is answered 401 before anything is counted.
  router.post("/auth/browser-key", requireSession, limiter, async (req: AuthRequest, res: Response) => {
    // A credential: no cache, no shared proxy, no browser history of it.
    res.setHeader("Cache-Control", "no-store");
    if (adminClient === null || botToken === null || botToken.length === 0) {
      res.status(503).json({ message: "Service unavailable" });
      return;
    }
    // Local and cheap, so before the panel is asked anything.
    const launch = launchUserOf(req.headers.authorization, botToken);
    if (launch.kind !== "verified") {
      res.status(401).json({ message: launch.kind === "missing" ? "LAUNCH_DATA_REQUIRED" : "LAUNCH_DATA_INVALID" });
      return;
    }
    try {
      const telegramId = await telegramIdOf(req);
      if (telegramId === null) {
        // A website account with no Telegram behind it is already in a browser;
        // there is nothing to hand over, and no key the panel could issue.
        res.status(409).json({ message: "NOT_A_TELEGRAM_ACCOUNT" });
        return;
      }
      if (telegramId !== launch.id) {
        // Another Telegram account's session in this app's shared cookie store.
        // The Mini App offers to sign in as the account that tapped.
        res.status(409).json({ message: "LAUNCH_ACCOUNT_MISMATCH" });
        return;
      }
      const issued = await adminClient.webAuth.issueBotSigninToken(String(telegramId));
      if (typeof issued.token !== "string" || issued.token.length === 0) {
        res.status(409).json({ message: "KEY_NOT_ISSUED" });
        return;
      }
      res.json({ key: issued.token, expiresAt: issued.expiresAt });
    } catch (err: unknown) {
      getRequestLogger(req).error({ err }, "auth/browser-key: the panel did not issue a key");
      res.status(502).json({ message: "KEY_NOT_ISSUED" });
    }
  });
  return router;
}
