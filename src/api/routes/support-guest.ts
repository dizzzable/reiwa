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
const DEFAULT_TTL_HOURS = 72;
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

  // Runtime config (enabled flag + Turnstile keys) is panel-managed in rezeis
  // and fetched here with a short cache, so operators tune it from the admin
  // UI without touching reiwa env / restarting. Env values stay as the seed
  // default on the rezeis side. On a fetch failure we serve the last good
  // value (or treat the feature as available, captcha-less, when never seen).
  const CONFIG_TTL_MS = 30_000;
  let cachedConfig: { value: GuestRuntimeConfig; at: number } | null = null;
  const runtimeConfig = async (): Promise<GuestRuntimeConfig | null> => {
    if (!adminClient) return null;
    const now = Date.now();
    if (cachedConfig && now - cachedConfig.at < CONFIG_TTL_MS) return cachedConfig.value;
    try {
      const value = await adminClient.support.getRuntimeConfig();
      cachedConfig = { value, at: now };
      return value;
    } catch {
      return cachedConfig?.value ?? null;
    }
  };

  const secure =
    config.REIWA_COOKIE_SECURE ||
    (config.NODE_ENV === "production" && !config.REIWA_ALLOW_INSECURE_COOKIES);
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: DEFAULT_TTL_HOURS * 3_600_000,
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
      const ticket = await adminClient?.support.getGuest(token);
      // When the visitor arrived via an emailed resume link (no cookie yet),
      // persist the token as the httpOnly cookie so the session continues
      // across subsequent polls without the code in the URL.
      if (!cookieToken && ticket) {
        res.cookie(COOKIE_NAME, token, cookieOptions);
      }
      res.json(ticket ?? null);
    } catch (err: unknown) {
      if (isUpstreamStatus(err, 404)) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      sendSafeError(req, res, err, 500, "Failed to load conversation", "support/guest/get");
    }
  });

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
      const ticket = await adminClient?.support.replyGuest(token, content.trim());
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
   * explicit resume code (header / body / query) so a returning visitor
   * can restore their conversation on a new device.
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
