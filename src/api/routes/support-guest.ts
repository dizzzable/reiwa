import { Router, type Request, type Response } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../../config.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { sendSafeError } from "../lib/error-response.js";
import { isUpstreamStatus } from "../lib/upstream-error.js";
import { createRedisRateLimiter } from "../middleware/rate-limit.js";
import { resolveClientIp } from "../lib/client-ip.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import type { GuestRuntimeConfig } from "../../infrastructure/admin-client/namespaces/support.js";
import { getGuestSupportConfigCache } from "../../infrastructure/admin-client/guest-support-config-cache.js";

/**
 * Anonymous (guest) support chat — public, session-less surface.
 *
 * A visitor opens a conversation without logging in. reiwa issues an
 * httpOnly cookie (`reiwa_support`) carrying the server-bound guest token
 * and returns a human-readable resume code the visitor can save to come
 * back later. Every guest request relays the raw token to rezeis in the
 * `x-support-guest-token` header; rezeis resolves it by hash. The client
 * never asserts a conversation/user id, so it can only ever reach its own
 * conversation.
 *
 * Abuse protection (dedicated rate limiter + captcha) is layered on by the
 * caller in `app.ts`; this router stays transport-only.
 */
const COOKIE_NAME = "reiwa_support";

/**
 * One device signal out of the request body, or `null`.
 *
 * Bounded here as well as upstream so an oversized value is dropped at the edge
 * rather than relayed. The panel validates the shape properly; this only keeps
 * obvious junk off the wire.
 */
function readSignal(body: unknown, key: "installId" | "deviceHash"): string | null {
  if (body === null || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

/**
 * The guest page's language out of the request body — `ru` or `en`, anything
 * else is none. The panel writes the guest's reply letters in it; with none it
 * writes them in Russian, as it always did. Relayed as a header
 * (`AdminClient.support.createGuest` / `replyGuest`), never in the panel's
 * body: a panel that does not know the field would refuse the whole request.
 */
function readLocale(body: unknown): "ru" | "en" | null {
  if (body === null || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)["locale"];
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  return normalised === "ru" || normalised === "en" ? normalised : null;
}
/**
 * How long the device keeps its key (`reiwa_support`). The key's lifetime must
 * never be what ends a guest's access — the panel decides that: the support
 * TTL (72 h by default, up to 8760 h) from the conversation's start, renewed
 * from each operator reply. At 72 h the cookie dropped the device out of a
 * conversation an operator had just answered on day 4. A stale key is inert:
 * the panel refuses it, and the page shows the start form, as with none.
 */
const KEY_MAX_AGE_HOURS = 8760;
const MAX_SUBJECT = 200;
const MAX_CONTENT = 10_000;

export function createSupportGuestRouter(deps: {
  adminClient: AdminClient | null;
  config: ReiwaConfig;
  webSessionStore: WebSessionStore | null;
}) {
  const { adminClient, config, webSessionStore } = deps;
  const router = Router();

  // Dedicated Redis limiters — strict on creation (bounds open conversations
  // per IP), looser on replies. Separate from the global apiLimiter so a
  // public spam burst can't be hidden inside the generic 120/min budget.
  const redis = webSessionStore?.getRedis() ?? null;
  const createLimiter = createRedisRateLimiter(redis, "guestCreate");
  const replyLimiter = createRedisRateLimiter(redis, "guestReply");
  const uploadLimiter = createRedisRateLimiter(redis, "guestUpload");

  // Runtime config (enabled flag + Turnstile keys) is panel-managed in rezeis,
  // so operators tune it from the admin UI without touching reiwa env /
  // restarting. Cached by `GuestSupportConfigCache`: 30 s, served stale while
  // it refreshes, a failure remembered, and the last config the panel answered
  // kept in reiwa's Redis — a restart during a panel outage keeps the captcha
  // instead of answering "enabled, no captcha" (W8 report D13). `null` only
  // when no config was ever known.
  const runtimeConfig = async (): Promise<GuestRuntimeConfig | null> => {
    if (!adminClient) return null;
    return getGuestSupportConfigCache(adminClient).get();
  };

  const secure =
    config.REIWA_COOKIE_SECURE ||
    (config.NODE_ENV === "production" && !config.REIWA_ALLOW_INSECURE_COOKIES);
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: KEY_MAX_AGE_HOURS * 3_600_000,
  };

  // Public widget config — the site key the browser needs to render the
  // Turnstile challenge (null when captcha is not configured) + whether the
  // anonymous chat is currently enabled (panel-managed).
  router.get("/support/guest/config", async (_req: Request, res: Response) => {
    const cfg = await runtimeConfig();
    res.json({
      enabled: cfg ? cfg.enabled : true,
      turnstileSiteKey: cfg && cfg.turnstileSiteKey.length > 0 ? cfg.turnstileSiteKey : null,
    });
  });

  // POST /support/guest — open a new anonymous conversation.
  router.post("/support/guest", createLimiter, async (req: Request, res: Response) => {
    const { subject, message, email, captchaToken } = (req.body ?? {}) as {
      subject?: string;
      message?: string;
      email?: string;
      captchaToken?: string;
    };
    if (!subject?.trim() || !message?.trim()) {
      res.status(400).json({ error: "Subject and message are required" });
      return;
    }
    if (subject.trim().length > MAX_SUBJECT || message.trim().length > MAX_CONTENT) {
      res.status(413).json({ error: "Subject or message too long" });
      return;
    }
    // ── The optional field that could fail the whole conversation ──────────
    //
    // `email` is optional here and validated with `@IsEmail()` on the panel, so
    // a visitor who typed `john@` had it forwarded verbatim, got a 400 back
    // from the panel, and — because the catch below only recognises 404 — met
    // "Failed to start conversation" as a 500. They could not open a support
    // conversation at all, were never told which field was at fault, and the
    // refusal was booked as a server error in our own metrics.
    //
    // Checked here rather than made stricter there: the address is a courtesy
    // for the resume link, and nothing about it is worth failing a support
    // request over.
    const trimmedEmail = email?.trim() ?? "";
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(trimmedEmail)) {
      res.status(400).json({ error: "invalid_email" });
      return;
    }
    // Panel-managed gate + captcha. When disabled, the feature is off (404).
    const cfg = await runtimeConfig();
    if (cfg && !cfg.enabled) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const turnstileSecret = cfg?.turnstileSecret ?? null;
    // Human-verification gate — only enforced when configured.
    if (turnstileSecret !== null) {
      const ok = await verifyTurnstile(turnstileSecret, captchaToken, resolveClientIp(req));
      if (!ok) {
        res.status(400).json({ error: "captcha_failed" });
        return;
      }
    }
    try {
      const result = await adminClient?.support.createGuest({
        subject: subject.trim(),
        message: message.trim(),
        email: email?.trim() || null,
        clientIp: resolveClientIp(req),
        // Read from the body, because only the browser can compute them — and
        // read leniently, because a visitor who blocks them is a visitor with
        // an unmarked conversation, which is what any unrecognised visitor
        // gets anyway. Nothing here is worth failing a support request over.
        installId: readSignal(req.body, "installId"),
        deviceHash: readSignal(req.body, "deviceHash"),
        locale: readLocale(req.body),
      });
      if (!result) {
        res.status(503).json({ error: "unavailable" });
        return;
      }
      res.cookie(COOKIE_NAME, result.token, cookieOptions);
      // `resumeCode` is the visitor's to keep (magic-link parity); the token
      // itself stays in the httpOnly cookie and is never exposed again.
      res.json({ resumeCode: result.resumeCode, ticket: result.ticket });
    } catch (err: unknown) {
      // A 404 from the panel is either "support is switched off" or "this
      // device was silenced by an operator", and the panel answers both
      // identically ON PURPOSE. Falling through to a 500 undid that: a
      // disabled surface answered 404 while a silenced device answered 500,
      // and `GET /support/guest/config` says `enabled: true` — so one request
      // told whoever was testing which of their machines we know. That is the
      // oracle that makes churning through devices cheap, which is the entire
      // thing the silence feature exists to make expensive.
      //
      // It also stops booking a 5xx in our own error metrics for a refusal we
      // meant to make.
      if (isUpstreamStatus(err, 404)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      sendSafeError(req, res, err, 500, "Failed to start conversation", "support/guest/create");
    }
  });

  // GET /support/guest — fetch the conversation bound to the cookie/resume code.
  router.get("/support/guest", async (req: Request, res: Response) => {
    const cookieToken = (req.cookies?.[COOKIE_NAME] as string | undefined) ?? null;
    const token = readToken(req);
    if (token === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const found = asGuestThread(await adminClient?.support.getGuest(token));
      // A token that came WITH the request, on a device with no cookie (a
      // page from before `/support/guest/resume`), becomes the cookie — as
      // the conversation's durable credential when the panel exchanged it.
      // An ordinary poll rides on the cookie and writes nothing.
      if (found !== null && cookieToken === null) {
        res.cookie(COOKIE_NAME, found.deviceToken ?? token, cookieOptions);
      }
      res.json(found?.thread ?? null);
    } catch (err: unknown) {
      if (isUpstreamStatus(err, 404)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      sendSafeError(req, res, err, 500, "Failed to load conversation", "support/guest/get");
    }
  });

  // POST /support/guest/resume — follow a way in: the «Открыть переписку»
  // link in a reply letter, or a resume code typed into «Есть код возврата?».
  //
  // A letter's token is not the device's key: the panel issues a new one with
  // every operator reply and forgets the old one. Kept as the cookie, it
  // dropped the visitor out of the conversation at the operator's next reply —
  // the device that started the thread included. So the panel answers a link
  // with the conversation's durable credential, and the device keeps THAT.
  //
  //   opened    — the device now holds the conversation (cookie written);
  //   continued — it already held this very conversation (cookie untouched);
  //   stale     — the link is out of date or unknown; `ticket` is the
  //               conversation the device already holds, if any, to carry on;
  //   confirm   — the device holds ANOTHER open conversation, and a link is
  //               not allowed to swap it silently (a crafted one would slip
  //               the visitor into a thread its sender reads). Nothing is
  //               written until the page sends `confirm: true`.
  router.post("/support/guest/resume", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { resume?: unknown; confirm?: unknown };
    const resume = typeof body.resume === "string" ? body.resume.trim() : "";
    if (resume.length === 0) {
      res.status(400).json({ error: "resume_required" });
      return;
    }
    const cookieToken = (req.cookies?.[COOKIE_NAME] as string | undefined) ?? null;
    try {
      const current = cookieToken !== null ? await lookUpGuest(cookieToken) : null;
      const incoming = await lookUpGuest(resume);
      if (incoming === null) {
        res.json({ status: "stale", ticket: current?.thread ?? null });
        return;
      }
      if (current !== null && current.thread.id === incoming.thread.id) {
        res.json({ status: "continued", ticket: current.thread });
        return;
      }
      if (current !== null && body.confirm !== true) {
        res.json({
          status: "confirm",
          opening: { subject: incoming.thread.subject },
          current: { subject: current.thread.subject },
        });
        return;
      }
      res.cookie(COOKIE_NAME, incoming.deviceToken ?? resume, cookieOptions);
      res.json({ status: "opened", ticket: incoming.thread });
    } catch (err: unknown) {
      sendSafeError(req, res, err, 500, "Failed to open conversation", "support/guest/resume");
    }
  });

  /** The thread a token opens (with any credential split off), or `null` when it opens none. */
  async function lookUpGuest(token: string): Promise<GuestThread | null> {
    try {
      return asGuestThread(await adminClient?.support.getGuest(token));
    } catch (err: unknown) {
      if (isUpstreamStatus(err, 404)) return null;
      throw err;
    }
  }

  // POST /support/guest/reply — append a guest message.
  router.post("/support/guest/reply", replyLimiter, async (req: Request, res: Response) => {
    const token = readToken(req);
    if (token === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const cfg = await runtimeConfig();
    if (cfg && !cfg.enabled) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) {
      res.status(400).json({ error: "Content is required" });
      return;
    }
    if (content.trim().length > MAX_CONTENT) {
      res.status(413).json({ error: "Message too long" });
      return;
    }
    try {
      const ticket = await adminClient?.support.replyGuest(token, content.trim(), readLocale(req.body));
      res.json(ticket ?? null);
    } catch (err: unknown) {
      if (isUpstreamStatus(err, 404)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      sendSafeError(req, res, err, 500, "Failed to send message", "support/guest/reply");
    }
  });

  // POST /support/guest/close — visitor closes their own conversation.
  router.post("/support/guest/close", async (req: Request, res: Response) => {
    const token = readToken(req);
    if (token === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      await adminClient?.support.closeGuest(token);
      res.clearCookie(COOKIE_NAME, { path: "/" });
      res.json({ ok: true });
    } catch (err: unknown) {
      if (isUpstreamStatus(err, 404)) {
        res.clearCookie(COOKIE_NAME, { path: "/" });
        res.status(404).json({ error: "not_found" });
        return;
      }
      sendSafeError(req, res, err, 500, "Failed to close conversation", "support/guest/close");
    }
  });

  // POST /support/guest/attachments — attach a file to the conversation.
  router.post(
    "/support/guest/attachments",
    uploadLimiter,
    async (req: Request, res: Response) => {
      const token = readToken(req);
      if (token === null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const cfg = await runtimeConfig();
      if (cfg && !cfg.enabled) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { filename, mimeType, content, dataBase64 } = (req.body ?? {}) as {
        filename?: string;
        mimeType?: string;
        content?: string;
        dataBase64?: string;
      };
      if (!filename?.trim() || !dataBase64?.trim()) {
        res.status(400).json({ error: "File is required" });
        return;
      }
      if (content && content.trim().length > MAX_CONTENT) {
        res.status(413).json({ error: "Caption too long" });
        return;
      }
      try {
        const ticket = await adminClient?.support.uploadGuestAttachment(token, {
          filename: filename.trim().slice(0, 255),
          mimeType: mimeType?.trim() || undefined,
          content: content?.trim() || undefined,
          dataBase64,
        });
        res.json(ticket ?? null);
      } catch (err: unknown) {
        // Surface the upstream validation verdict (415 type / 413 size) so the
        // widget can show a precise message; everything else stays generic.
        if (isUpstreamStatus(err, 404)) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (isUpstreamStatus(err, 415)) {
          res.status(415).json({ error: "type_not_allowed" });
          return;
        }
        if (isUpstreamStatus(err, 413)) {
          res.status(413).json({ error: "too_large" });
          return;
        }
        sendSafeError(req, res, err, 500, "Failed to upload file", "support/guest/upload");
      }
    },
  );

  // GET /support/guest/attachments/:id — stream an attachment to its owner.
  router.get(
    "/support/guest/attachments/:attachmentId",
    async (req: Request, res: Response) => {
      const token = readToken(req);
      if (token === null) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const rawId = req.params["attachmentId"];
      const attachmentId = Array.isArray(rawId) ? (rawId[0] ?? "") : (rawId ?? "");
      try {
        const file = await adminClient?.support.downloadGuestAttachment(token, attachmentId);
        if (!file) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (file.contentType) res.setHeader("Content-Type", file.contentType);
        if (file.contentLength !== null) res.setHeader("Content-Length", String(file.contentLength));
        res.setHeader("Cache-Control", "private, no-store");
        file.body.pipe(res);
      } catch (err: unknown) {
        sendSafeError(req, res, err, 500, "Failed to load attachment", "support/guest/attachment");
      }
    },
  );

  /**
   * Resolve the guest token from the httpOnly cookie first, then an
   * explicit resume code (header / body / query), which only a device with
   * no cookie can use this way. Switching a device to ANOTHER conversation
   * is `POST /support/guest/resume`'s job alone, where it is confirmed.
   */
  function readToken(req: Request): string | null {
    const cookie = req.cookies?.[COOKIE_NAME] as string | undefined;
    if (typeof cookie === "string" && cookie.length > 0) return cookie;
    const header = req.get("x-support-resume");
    if (typeof header === "string" && header.length > 0) return header;
    const body = (req.body ?? {}) as { resume?: unknown };
    if (typeof body.resume === "string" && body.resume.length > 0) return body.resume;
    const query = req.query?.["resume"];
    if (typeof query === "string" && query.length > 0) return query;
    return null;
  }

  return router;

}

/** A guest thread as the browser may see it, and the credential it must not. */
interface GuestThread {
  readonly thread: { readonly id: string; readonly subject?: string } & Record<string, unknown>;
  /** The conversation's durable credential, when the token was a letter's link. */
  readonly deviceToken: string | null;
}

/**
 * Split the panel's answer: `deviceToken` goes into the cookie and nowhere
 * else — never into a JSON body the page's scripts can read.
 */
function asGuestThread(payload: unknown): GuestThread | null {
  if (payload === null || typeof payload !== "object") return null;
  const { deviceToken, ...thread } = payload as Record<string, unknown>;
  if (typeof thread["id"] !== "string") return null;
  return {
    thread: thread as GuestThread["thread"],
    deviceToken: typeof deviceToken === "string" && deviceToken.length > 0 ? deviceToken : null,
  };
}
