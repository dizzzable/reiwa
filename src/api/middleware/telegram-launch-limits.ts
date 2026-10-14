/**
 * Meters for the two routes a Telegram Mini App signs in through:
 * `POST /auth/telegram/bootstrap` (every cold start of the Mini App) and
 * `POST /auth/telegram/link-existing` ("I already have an account").
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * Both sat behind ONE in-memory budget of 20 requests per 15 minutes per
 * address. An address is not a customer: a carrier NAT, a VPN exit, an office,
 * and above all a CDN edge that does not forward the visitor's address
 * (`trust proxy` is 1, so `req.ip` is whatever the first proxy says) put an
 * operator's whole audience behind a handful of addresses. Every cold start is
 * one bootstrap, so the twenty-first customer to open the app in a quarter of
 * an hour was shown "Слишком много попыток. Попробуйте снова через 527 сек.",
 * with a perfectly valid launch.
 *
 * ── What is metered now ──────────────────────────────────────────────────────
 *
 * The launch carries a signature only Telegram (holding the bot token) can
 * make, so the signature is checked FIRST, here, before any budget is read -
 * an HMAC, no I/O - and the meters depend on what it proves:
 *
 *  - A missing or invalid launch is the only thing an attacker can send, and
 *    the only thing counted against an ADDRESS: `invalidPerAddress` strikes,
 *    then 429. A valid launch never reads this counter, so a customer is not
 *    refused because somebody else on the address is sending garbage.
 *  - A valid launch is metered by WHO signed it - the Telegram id inside the
 *    verified payload, `launchesPerUser` - which cannot be spoofed (nothing
 *    unsigned is ever a key, so nobody can spend a victim's budget), and by a
 *    high flood cap per address, `launchesPerAddress`, there to bound a script
 *    that holds many real Telegram accounts, not to ration customers.
 *  - Linking an existing account takes a PASSWORD, so a guess is what it must
 *    count: the attempts that fail (400/401), per verified Telegram id and per
 *    address. A success or a typed refusal (409: the credentials were right)
 *    is given back. A request that is over budget is answered 429 before the
 *    password is looked at.
 *
 * ── Why in memory ────────────────────────────────────────────────────────────
 *
 * Like `createAccountRateLimiter`: the API runs as one process, so a counter
 * in its memory sees every request; a restart forgets the counters, which only
 * ever errs towards letting a customer in. Nothing here depends on Redis, so a
 * Redis outage cannot refuse a launch on top of the session it breaks.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { validateTelegramInitData } from "../../lib/telegram-auth.js";
import { getRequestLogger } from "./logger-accessor.js";
import { ipRateBucket } from "./rate-limit.js";

const WINDOW_MS = 15 * 60 * 1000;

/**
 * No signed launch is anywhere near this long (a real `initData` is a couple
 * of kilobytes with the user's photo address). Past it nothing is verified:
 * the request is a strike, and no HMAC is spent on it.
 */
const INIT_DATA_MAX_LENGTH = 16 * 1024;

/** Entries kept per counter before expired ones are swept, then the oldest dropped. */
const MAX_TRACKED_KEYS = 100_000;

export interface TelegramLaunchLimits {
  /** Missing or invalid launches per address per window - the only count that reads an address for a valid caller's sake. */
  readonly invalidPerAddress: number;
  /** `bootstrap`: valid launches per address per window - a flood cap, high on purpose. */
  readonly launchesPerAddress: number;
  /** `bootstrap`: valid launches per verified Telegram id per window. */
  readonly launchesPerUser: number;
  /** `link-existing`: failed attempts per address per window. */
  readonly failuresPerAddress: number;
  /** `link-existing`: failed attempts per verified Telegram id per window. */
  readonly failuresPerUser: number;
}

export const TELEGRAM_LAUNCH_LIMITS: TelegramLaunchLimits = Object.freeze({
  invalidPerAddress: 20,
  launchesPerAddress: 1200,
  launchesPerUser: 60,
  failuresPerAddress: 30,
  failuresPerUser: 10,
});

interface Window {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window counter by key. `hit` counts and answers; `refund` gives one
 * back without moving the window; `retryAfterSeconds` says how long until the
 * window ends.
 */
export class FixedWindowCounter {
  private readonly windows = new Map<string, Window>();

  public constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public hit(key: string): Window {
    const at = this.now();
    this.makeRoom(at);
    const current = this.windows.get(key);
    if (current !== undefined && current.resetAt > at) {
      current.count += 1;
      return current;
    }
    const fresh: Window = { count: 1, resetAt: at + this.windowMs };
    this.windows.set(key, fresh);
    return fresh;
  }

  public refund(key: string): void {
    const current = this.windows.get(key);
    if (current !== undefined && current.resetAt > this.now() && current.count > 0) {
      current.count -= 1;
    }
  }

  public peek(key: string): number {
    const current = this.windows.get(key);
    return current !== undefined && current.resetAt > this.now() ? current.count : 0;
  }

  public retryAfterSeconds(window: Window): number {
    return Math.max(1, Math.ceil((window.resetAt - this.now()) / 1000));
  }

  public get size(): number {
    return this.windows.size;
  }

  /** Bounded memory: sweep what has expired, then, if a flood still fills it, drop the oldest tenth. */
  private makeRoom(at: number): void {
    if (this.windows.size < MAX_TRACKED_KEYS) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= at) this.windows.delete(key);
    }
    if (this.windows.size < MAX_TRACKED_KEYS) return;
    let drop = Math.ceil(MAX_TRACKED_KEYS / 10);
    for (const key of this.windows.keys()) {
      if (drop-- <= 0) break;
      this.windows.delete(key);
    }
  }
}

export interface TelegramLaunchLimiterOptions {
  /** Which route this guards: they keep separate counters, and `link-existing` meters guesses. */
  readonly kind: "bootstrap" | "link-existing";
  /** The bot token the launch is signed with. Unset: nothing can be verified and the handler answers for itself. */
  readonly botToken: string | undefined;
  readonly limits?: Partial<TelegramLaunchLimits>;
  /** For tests. */
  readonly now?: () => number;
}

/** The launch payload a request carries, exactly as the routes read it. */
function readInitData(req: Request): string {
  return (req.headers.authorization ?? "").replace(/^tma\s+/i, "");
}

/**
 * The Telegram id inside a launch whose signature checks out, or `null`. A
 * payload that verifies but carries no usable id is no launch either.
 */
function verifiedTelegramId(initData: string, botToken: string): string | null {
  if (initData.length === 0 || initData.length > INIT_DATA_MAX_LENGTH) return null;
  const user = validateTelegramInitData(initData, botToken);
  const id = user?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

export function createTelegramLaunchLimiter(options: TelegramLaunchLimiterOptions): RequestHandler {
  const limits: TelegramLaunchLimits = { ...TELEGRAM_LAUNCH_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const invalidByAddress = new FixedWindowCounter(WINDOW_MS, now);
  const launchesByAddress = new FixedWindowCounter(WINDOW_MS, now);
  const launchesByUser = new FixedWindowCounter(WINDOW_MS, now);
  const failuresByAddress = new FixedWindowCounter(WINDOW_MS, now);
  const failuresByUser = new FixedWindowCounter(WINDOW_MS, now);

  const reject = (
    req: Request,
    res: Response,
    retryAfter: number,
    reason: string,
    telegramId: string | null,
  ): void => {
    if (typeof req.originalUrl === "string") {
      getRequestLogger(req).warn(
        {
          component: "rate-limit",
          endpoint: `telegram-${options.kind}`,
          reason,
          originalUrl: req.originalUrl,
          ip: req.ip ?? req.socket?.remoteAddress ?? "unknown",
          telegramId,
          retryAfter,
        },
        "Telegram launch request rejected",
      );
    }
    res.setHeader("Retry-After", String(retryAfter));
    // The body the Mini App's countdown reads (`tma-bootstrap-page.tsx`).
    res.status(429).json({ message: "Too many requests, please try again later", retryAfter });
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const botToken = options.botToken;
    if (botToken === undefined || botToken.length === 0) {
      // Nothing to verify against: the route answers "Authentication unavailable".
      next();
      return;
    }
    const address = ipRateBucket(req.ip ?? req.socket?.remoteAddress ?? "unknown");
    const telegramId = verifiedTelegramId(readInitData(req), botToken);

    if (telegramId === null) {
      // Missing, malformed, forged or expired: the one thing counted against an
      // address. The route still answers 400/401 itself while the strikes last.
      const strikes = invalidByAddress.hit(address);
      if (strikes.count > limits.invalidPerAddress) {
        reject(req, res, invalidByAddress.retryAfterSeconds(strikes), "invalid-launch", null);
        return;
      }
      next();
      return;
    }

    const userKey = `tg:${telegramId}`;

    if (options.kind === "bootstrap") {
      const byAddress = launchesByAddress.hit(address);
      if (byAddress.count > limits.launchesPerAddress) {
        reject(req, res, launchesByAddress.retryAfterSeconds(byAddress), "address-flood", telegramId);
        return;
      }
      const byUser = launchesByUser.hit(userKey);
      if (byUser.count > limits.launchesPerUser) {
        reject(req, res, launchesByUser.retryAfterSeconds(byUser), "user-launches", telegramId);
        return;
      }
      next();
      return;
    }

    // link-existing: a password is about to be tried. Reserve the attempt NOW,
    // before the handler runs, so a burst of parallel guesses cannot all be
    // judged against a count none of them has raised yet; give it back once the
    // response shows the credentials were not wrong.
    const addressWindow = failuresByAddress.hit(address);
    const userWindow = failuresByUser.hit(userKey);
    if (addressWindow.count > limits.failuresPerAddress) {
      reject(req, res, failuresByAddress.retryAfterSeconds(addressWindow), "address-failures", telegramId);
      return;
    }
    if (userWindow.count > limits.failuresPerUser) {
      reject(req, res, failuresByUser.retryAfterSeconds(userWindow), "user-failures", telegramId);
      return;
    }
    res.on("finish", () => {
      // 400: junk in the body. 401: wrong login or password. Everything else -
      // linked, already linked, a typed 409 refusal (right credentials), an
      // outage - was not a wrong guess.
      if (res.statusCode === 400 || res.statusCode === 401) return;
      failuresByAddress.refund(address);
      failuresByUser.refund(userKey);
    });
    next();
  };
}
