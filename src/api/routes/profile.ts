import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { resolveClientIp } from "../lib/client-ip.js";
import { createFlexibleSessionMiddleware, createOptionalSessionMiddleware } from "../middleware/session.js";
import { createFreshSessionCheck } from "../middleware/fresh-session-check.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity, hasUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { sendSafeError } from "../lib/error-response.js";
import { describeUpstreamError } from "../lib/upstream-error.js";
import { invalidateStaleUserSession } from "../lib/stale-user-session.js";
import { getPolicyCache } from "../../infrastructure/admin-client/policy-cache.js";

export function createProfileRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore } = deps;
  // Identity-agnostic auth: accepts the WebSession (reiwa_id) used by
  // browser/Mini-App/magic-link logins AND the legacy Telegram session.
  // The whole profile surface (/session, /me, password, email, language)
  // is keyed by reiwa_id so web-first users with no Telegram are not
  // locked out — `getSession` previously required `telegramId` and 401'd
  // every web-auth user even after a successful login.
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const optionalSession = createOptionalSessionMiddleware(sessionStore);
  // An e-mail verified here becomes a way into the account: a session signed
  // out a moment ago must not get its last minute in (`fresh-session-check.ts`).
  const requireFreshSession = createFreshSessionCheck(adminClient?.webAuth ?? null);
  const router = Router();

  // GET /api/v1/session
  //
  // Session probe used by the SPA on every load (and the login screen). It
  // resolves the current session when present, but for an unauthenticated
  // caller it returns `200 → null` instead of `401` — the absence of a
  // session is an expected state here, not an error, and a 401 would show up
  // as a red console error on the sign-in page.
  router.get("/session", optionalSession, async (req: AuthRequest, res) => {
    if (!hasUserIdentity(req)) {
      res.json(null);
      return;
    }
    try {
      const session = await adminClient?.user.getSession(resolveUserIdentity(req));
      res.json(session ?? req.session ?? null);
    } catch (error: unknown) {
      // Preserve the probe's deliberate 200 -> null contract, but first
      // remove the stale CUID so later protected requests cannot keep using
      // an authenticated cookie for an account that has been deleted.
      if (await invalidateStaleUserSession(req, error)) {
        res.json(null);
        return;
      }
      res.json(req.session ?? null);
    }
  });

  // PATCH /api/v1/session/rules-acceptance
  router.patch(
    "/session/rules-acceptance",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.user.acceptRules(resolveUserIdentity(req));
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to accept rules", "session/rules-acceptance");
      }
    },
  );

  // PATCH /api/v1/session/onboarding — persist tour state. Body `{ completed }`.
  router.patch(
    "/session/onboarding",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const completed = (req.body as { completed?: boolean })?.completed !== false;
        const result = await adminClient?.user.setOnboarding(
          resolveUserIdentity(req),
          completed,
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to save onboarding state", "session/onboarding");
      }
    },
  );

  // POST /api/v1/surface/seen — the cabinet reports which surface it's running
  // on (tma / pwa / browser) + form factor + os, once per session. Effects:
  // (1) when standalone PWA, upgrade the session to the 30-day window; (2)
  // persist the surface snapshot + PWA-install milestone on the rezeis user
  // record for usage analytics. Best-effort: a failed persist never breaks the
  // session or cabinet. Body: `{ surface, formFactor, os }`.
  router.post("/surface/seen", requireSession, async (req: AuthRequest, res) => {
    const body = (req.body ?? {}) as { surface?: unknown; formFactor?: unknown; os?: unknown };
    const surface =
      body.surface === "tma" || body.surface === "pwa" || body.surface === "browser"
        ? body.surface
        : "browser";
    const formFactor =
      body.formFactor === "mobile" || body.formFactor === "tablet" || body.formFactor === "desktop"
        ? body.formFactor
        : "desktop";
    const os =
      typeof body.os === "string" &&
      ["ios", "android", "windows", "macos", "linux", "other"].includes(body.os)
        ? body.os
        : "other";
    // Only an installed PWA gets the long-lived 30-day session.
    if (surface === "pwa") {
      try {
        await req.markSessionStandalone(os);
      } catch (err: unknown) {
        // Best-effort — fall through to persist + ack, because failing the
        // request would cost the user the cabinet over a session-window
        // upgrade. But this one is not analytics: silently not upgrading is
        // experienced as being logged out of an installed PWA days early, for
        // no reason the user or we can see. Log it for the same reason as the
        // persist below — an outage here is otherwise indistinguishable from
        // normal operation.
        getRequestLogger(req).warn(
          { err: describeUpstreamError(err).message, os },
          "surface/seen: standalone session upgrade failed",
        );
      }
    }
    try {
      await adminClient?.user.recordSurfaceSeen(resolveUserIdentity(req), {
        surface,
        formFactor,
        os,
        // Only the edge can see it — the panel's own peer on a split
        // deployment is this service. Whether it is recorded at all is the
        // panel's call: on a VPN product most sightings are our own exit
        // nodes and are refused.
        clientIp: resolveClientIp(req),
      });
    } catch (err: unknown) {
      // The cabinet must never break on this, so the response stays a 200 —
      // that half of the original comment is right. What was wrong was
      // discarding the error: a TOTAL loss of usage analytics then looks
      // exactly like normal operation.
      //
      // And this endpoint fails all-or-nothing. rezeis-admin validates the body
      // with a global `ValidationPipe({ whitelist: true,
      // forbidNonWhitelisted: true })` against a closed-allowlist DTO
      // (`internal-surface-seen.dto.ts`), so an undeclared field is a hard 400,
      // not a silent strip — shipping a new field from here before the admin
      // DTO accepts it stops `surface`, `formFactor` AND `os` together. Getting
      // that deploy order wrong must not be invisible.
      //
      // `describeUpstreamError` yields the typed upstream body or the plain
      // message; the request logger's redaction (`infrastructure/logger`)
      // covers headers and credential fields, and nothing here stringifies the
      // request, so neither is defeated.
      getRequestLogger(req).warn(
        { err: describeUpstreamError(err).message, surface, formFactor, os },
        "surface/seen: usage analytics persist failed",
      );
    }
    res.json({ ok: true });
  });

  // GET /api/v1/platform-policy
  //
  // From the process's `PolicyCache`, the one the access-mode middleware and
  // the channel gate read (W8 report D4). It used to ask the panel on every
  // cabinet load — ten seconds on a hanging panel, and another ten on the SPA's
  // retry — and to answer `{}` on any failure, which the cabinet reads as
  // PUBLIC with recovery off: an outage silently dropped the operator's access
  // mode. Now a failure answers the last known policy, from memory or from the
  // copy in Redis; with none ever known, 503 — never an invented policy. Not
  // cached by the browser: React Query already keeps it a minute.
  router.get("/platform-policy", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const policy = await getPolicyCache(adminClient).get();
    if (policy._isFallback === true) {
      res.status(503).json({ message: "Platform policy unavailable" });
      return;
    }
    res.json(policy);
  });

  // GET /api/v1/me — full profile (same data as /session)
  router.get("/me", requireSession, async (req: AuthRequest, res) => {
    try {
      const session = await adminClient?.user.getSession(resolveUserIdentity(req));
      res.json(session ?? req.session ?? null);
    } catch (error: unknown) {
      if (await invalidateStaleUserSession(req, error)) {
        res.json(null);
        return;
      }
      res.json(req.session ?? null);
    }
  });

  // PATCH /api/v1/me/password is gone. It set a password with no proof — no
  // current password, no reset link, no sign-out of the other sessions — and
  // the panel route behind it refused every call it ever made (400: no login),
  // so nothing used it. A password changes on `/auth/change-password`, is set
  // for the first time on `/auth/first-password`, and is reset by a link.

  // POST /api/v1/me/email/challenge — send email OTP
  router.post(
    "/me/email/challenge",
    requireSession,
    requireFreshSession,
    async (req: AuthRequest, res) => {
      try {
        const { email } = (req.body ?? {}) as Record<string, unknown>;
        if (!email) {
          res.status(400).json({ message: "email is required" });
          return;
        }
        await adminClient?.user.issueEmailVerificationChallenge(
          resolveUserIdentity(req),
          String(email),
        );
        res.status(204).end();
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to send verification code", "me/email/challenge");
      }
    },
  );

  // PATCH /api/v1/me/email/verify — complete email verification
  router.patch(
    "/me/email/verify",
    requireSession,
    requireFreshSession,
    async (req: AuthRequest, res) => {
      try {
        const { code } = (req.body ?? {}) as Record<string, unknown>;
        if (!code) {
          res.status(400).json({ message: "code is required" });
          return;
        }
        const result = await adminClient?.user.completeEmailVerification(
          resolveUserIdentity(req),
          String(code),
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 401, "Email verification failed", "me/email/verify");
      }
    },
  );

  // PATCH /api/v1/me/link-prompt-snooze
  router.patch(
    "/me/link-prompt-snooze",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const result = await adminClient?.user.snoozeWebAccountLinkPrompt(
          resolveUserIdentity(req),
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to snooze link prompt", "me/link-prompt-snooze");
      }
    },
  );

  // GET /api/v1/config — public bot/app config
  router.get("/config", async (_req, res) => {
    // The bot username is a reiwa-side env (`BOT_USERNAME`), not part of the
    // rezeis branding payload. Merge it in so the SPA can build correct
    // `t.me/<bot>?start=<ref>` referral links instead of falling back to a
    // hardcoded placeholder.
    const botUsername = deps.config.BOT_USERNAME ?? null;
    try {
      const botConfig = await adminClient?.branding.getPublicConfig();
      const base = (botConfig ?? {}) as Record<string, unknown>;
      res.json({ ...base, botUsername });
    } catch {
      res.json({ botUsername });
    }
  });

  // PATCH /api/v1/me/language — update user language
  router.patch(
    "/me/language",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const { language } = (req.body ?? {}) as Record<string, unknown>;
        if (!language) {
          res.status(400).json({ message: "language is required" });
          return;
        }
        const result = await adminClient?.user.updateLanguage(
          resolveUserIdentity(req),
          String(language),
        );
        res.json(result ?? { ok: true });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 500, "Failed to update language", "me/language");
      }
    },
  );

  return router;
}
