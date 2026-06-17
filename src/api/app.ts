import express, { Request, Response, NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { AdminClient } from "../lib/admin-client.js";
import type { SessionStore } from "../lib/session-store.js";
import { WebSessionStore, createWebSessionMiddleware } from "../infrastructure/redis/session.js";
import { createErrorReporter } from "../infrastructure/error-reporter/index.js";
import type { SessionConfig } from "../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../config.js";
import { resolveReiwaPublicUrl, resolveRezeisAdminUrl } from "../config.js";
import { REIWA_VERSION } from "../core/version.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { apiLimiter } from "./middleware/rate-limit.js";
import { createCsrfProtection } from "./middleware/csrf-protection.js";
import { createContextDetectionMiddleware } from "./middleware/context-detection.js";
import { createAuthRouter } from "./routes/auth.js";
import { createBrandingRouter } from "./routes/branding.js";
import { createProfileRouter } from "./routes/profile.js";
import { createPlansRouter } from "./routes/plans.js";
import { createSubscriptionRouter } from "./routes/subscription.js";
import { createPaymentsRouter } from "./routes/payments.js";
import { createActivityRouter } from "./routes/activity.js";
import { createPromoRouter } from "./routes/promo.js";
import { createReferralsRouter } from "./routes/referrals.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createPartnerRouter } from "./routes/partner.js";
import { createSupportRouter } from "./routes/support.js";
import { createSupportGuestRouter } from "./routes/support-guest.js";
import { createLinkingRouter } from "./routes/linking.js";
import { createPushRouter } from "./routes/push.js";
import { createRealtimeRouter } from "./routes/realtime.js";
import { createContentRouter } from "./routes/content.js";
import { createRezeisWebhookRouter } from "./routes/webhooks.js";
import { createInternalMetricsRouter } from "./routes/internal-metrics.js";
import { createClientErrorsRouter } from "./routes/client-errors.js";

export interface CreateAppDeps {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  webSessionStore: WebSessionStore | null;
  config: ReiwaConfig;
  /**
   * Optional root logger. When supplied, the app installs `pino-http`
   * with request-id propagation and the global error handler logs
   * structured records. When omitted (legacy callers, tests), the app
   * falls back to `console.*` so existing behaviour is preserved.
   */
  logger?: Logger;
}

export function createApp(deps: CreateAppDeps) {
  const { config, logger } = deps;
  const errorReporter = createErrorReporter({ adminClient: deps.adminClient, source: 'api' });
  const reiwaPublicUrl = resolveReiwaPublicUrl(config);
  const app = express();

  // ── Security ──────────────────────────────────────────────────────────────
  // In single-image mode the API also serves the SPA, so the Helmet CSP now
  // governs the front-end too. The default policy is SPA-compatible
  // (`script-src 'self'` for hashed bundles, `style-src ... 'unsafe-inline'`
  // for React inline styles, same-origin `connect-src`). We only relax
  // `frame-ancestors` so the Telegram Mini App can embed the cabinet in its
  // webview (the old nginx used `X-Frame-Options: ALLOWALL` for this).
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "frame-ancestors": [
            "'self'",
            "https://web.telegram.org",
            "https://*.telegram.org",
            "https://*.t.me",
          ],
          // The SPA loads the Telegram Mini App SDK from telegram.org, so
          // it must be allowed as a script source (default is 'self' only).
          "script-src": ["'self'", "https://telegram.org"],
          "script-src-elem": ["'self'", "https://telegram.org"],
          // The service worker fetches the Telegram SDK via the Fetch API,
          // which is governed by connect-src (not script-src). Allow the
          // same-origin API (SSE/XHR) plus telegram.org so the SW can pull
          // the SDK without a CSP violation.
          "connect-src": ["'self'", "https://telegram.org"],
          // The SDK is also pulled into the document; allow telegram.org as
          // a generic default-src source for any sub-resource it triggers.
          // `https:` + `blob:` let operator-configured brand logos
          // (`branding.logoUrl` / `cardLogoUrl`) load from any HTTPS host or
          // a blob/data URI — otherwise external logos render as a broken
          // image in the Mini App. Mirrors the rezeis-admin img-src policy.
          "img-src": ["'self'", "data:", "blob:", "https:"],
        },
      },
      // Telegram embeds the Mini App in an iframe; the legacy
      // `X-Frame-Options` header is superseded by the `frame-ancestors`
      // CSP directive above (X-Frame-Options can't express an allow-list).
      frameguard: false,
    }),
  );
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // ── Request-id + structured access log ────────────────────────────────────
  // Inbound `x-request-id` is honoured (lets the bot/web propagate a
  // correlation id). Otherwise a fresh UUID v4 is generated and echoed
  // back on the response so downstream services and the browser can
  // surface it in error reports. Mounted *before* pino-http so the
  // access log binds the same id.
  app.use(requestIdMiddleware());
  if (logger) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as unknown as { id?: string }).id ?? "",
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return "error";
          if (res.statusCode >= 400) return "warn";
          return "info";
        },
        // Don't log the high-frequency health/readiness probes — the Docker
        // healthcheck hits `/api/v1/health` every few seconds and would
        // otherwise drown the log stream in noise.
        autoLogging: {
          ignore: (req) => {
            const url = (req.url ?? "").split("?")[0];
            return (
              url === "/api/v1/health" ||
              url === "/api/v1/ready" ||
              url === "/api/v1/live" ||
              url.endsWith("/health") ||
              url.endsWith("/ready") ||
              url.endsWith("/live") ||
              url.endsWith("/favicon.ico")
            );
          },
        },
        // Compact, structured one-liners. The default serializers dump every
        // request/response header (CSP, cookies, rate-limit, etc.) on every
        // line; we keep only the fields that matter for tracing a request.
        serializers: {
          req: (req: { id?: string; method?: string; url?: string }) => ({
            id: req.id,
            method: req.method,
            url: (req.url ?? "").split("?")[0],
          }),
          res: (res: { statusCode?: number }) => ({
            statusCode: res.statusCode,
          }),
        },
      }),
    );
  }

  // ── Parsers ───────────────────────────────────────────────────────────────
  // Guest attachment uploads relay the file as base64 JSON, so this single
  // endpoint needs a larger body budget than the global 1 MB cap. It is
  // mounted BEFORE the global parser: body-parser sets `req._body`, so the
  // global `express.json` below skips re-parsing. rezeis re-validates the
  // decoded bytes (allow-list + magic-byte + true size cap) regardless.
  app.use(
    "/api/v1/support/guest/attachments",
    express.json({ limit: "16mb" }),
  );
  // Capture the raw body bytes so the rezeis-admin webhook receiver can verify
  // the HMAC signature over the exact payload (the signature is computed over
  // `<timestamp>.<rawBody>`, so a re-serialised body would never match).
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin: config.REIWA_CORS_ORIGIN ?? reiwaPublicUrl ?? true,
      credentials: true,
    }),
  );

  // ── Web Session Middleware (Redis-backed, httpOnly, sameSite=lax) ──────────
  if (deps.webSessionStore) {
    const sessionConfig: SessionConfig = {
      redisUrl: config.REDIS_URL ?? "",
      cookieSecret: config.REIWA_COOKIE_SECRET ?? "dev-secret",
      // Secure cookies are forced on in production (cookies only travel
      // over TLS behind the reverse proxy). The explicit
      // `REIWA_ALLOW_INSECURE_COOKIES=true` escape hatch turns that off
      // for trusted/no-TLS deployments and local HTTP testing of the
      // unified image — otherwise the browser silently drops the `Secure`
      // session cookie on http:// and the user can never stay logged in.
      cookieSecure:
        config.REIWA_COOKIE_SECURE ||
        (config.NODE_ENV === "production" && !config.REIWA_ALLOW_INSECURE_COOKIES),
      isProduction: config.NODE_ENV === "production",
      allowInsecureCookies: config.REIWA_ALLOW_INSECURE_COOKIES,
    };
    app.use(createWebSessionMiddleware(deps.webSessionStore, sessionConfig, logger));
  }

  // ── Global rate limit ─────────────────────────────────────────────────────
  app.use("/api", apiLimiter);

  // ── Context Detection (TMA vs Web) ────────────────────────────────────────
  app.use(createContextDetectionMiddleware({ botToken: config.BOT_TOKEN }));

  // ── CSRF Protection (Origin/Referer validation for state-changing requests) ─
  app.use(
    "/api",
    createCsrfProtection({
      allowedOrigin: config.REIWA_CORS_ORIGIN ?? reiwaPublicUrl ?? null,
    }),
  );

  // ── Health ────────────────────────────────────────────────────────────────
  app.get("/api/v1/health", (_req, res) => {
    res.json({ status: "ok", service: "reiwa-api", version: REIWA_VERSION });
  });

  // Stash adminClient on `app.locals` so the access-mode middleware
  // (which accepts per-request locals — not deps) can read it without
  // an extra factory layer per route.
  app.locals['adminClient'] = deps.adminClient;

  // ── Routers (all mounted at /api/v1; sub-paths live inside each router) ───
  app.use("/api/v1", createBrandingRouter({ adminClient: deps.adminClient, logger }));
  app.use("/api/v1", createAuthRouter(deps));
  app.use("/api/v1", createProfileRouter(deps));
  app.use("/api/v1", createPlansRouter(deps));
  app.use("/api/v1", createSubscriptionRouter(deps));
  app.use("/api/v1", createPaymentsRouter(deps));
  app.use("/api/v1", createActivityRouter(deps));
  app.use("/api/v1", createPromoRouter(deps));
  app.use("/api/v1", createReferralsRouter(deps));
  app.use("/api/v1/devices", createDevicesRouter(deps));
  app.use("/api/v1", createPartnerRouter(deps));
  app.use("/api/v1", createSupportRouter(deps));
  // Anonymous guest support chat — public (no session). Abuse protection is
  // layered in Phase 2 task 6 (dedicated limiter + captcha).
  app.use(
    "/api/v1",
    createSupportGuestRouter({
      adminClient: deps.adminClient,
      config,
      webSessionStore: deps.webSessionStore,
    }),
  );
  app.use("/api/v1", createLinkingRouter(deps));
  app.use("/api/v1", createPushRouter(deps));
  app.use("/api/v1", createRealtimeRouter(deps));
  app.use("/api/v1", createContentRouter(deps));

  // Client-error ingest — the web/TMA cabinet SPA reports its own runtime
  // errors here so they join the bot/api/worker firehose.
  app.use("/api/v1", createClientErrorsRouter(deps));
  // Inbound rezeis-admin webhook receiver (admin → reiwa public domain →
  // relayed to the bot locally). Signature-authenticated; see webhooks.ts.
  app.use("/api/v1", createRezeisWebhookRouter({ config }));
  // Internal metrics for the admin dashboard's Reiwa monitoring tab.
  app.use("/api/v1", createInternalMetricsRouter({ config }));

  // ── Admin uploads proxy (icons) ───────────────────────────────────────────
  // Custom icons live on the admin host under `/uploads/icons/<file>`. The
  // reiwa SPA is a different origin, so it can't load that path directly — we
  // proxy it through reiwa-api (which reaches admin over the internal network)
  // so the browser uses a same-origin relative URL. Read-only, public assets;
  // the filename pattern is constrained to avoid traversal/SSRF.
  const adminBaseUrl = resolveRezeisAdminUrl(deps.config);
  app.get("/uploads/icons/:file", async (req: Request, res: Response) => {
    const file = String(req.params["file"] ?? "");
    if (!adminBaseUrl || !/^[A-Za-z0-9._-]+$/.test(file) || file.includes("..")) {
      res.status(404).end();
      return;
    }
    try {
      const upstream = await fetch(`${adminBaseUrl}/uploads/icons/${file}`);
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status === 404 ? 404 : 502).end();
        return;
      }
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(buffer);
    } catch (err: unknown) {
      if (logger) logger.debug({ err, file }, "icon proxy failed");
      res.status(502).end();
    }
  });

  // ── Admin uploads proxy (custom emoji) ────────────────────────────────────
  // Custom emoji assets (PNG + Lottie JSON) live on the admin host under
  // `/uploads/emoji/<file>`. Same cross-origin reasoning as the icons proxy.
  app.get("/uploads/emoji/:file", async (req: Request, res: Response) => {
    const file = String(req.params["file"] ?? "");
    if (!adminBaseUrl || !/^[A-Za-z0-9._-]+$/.test(file) || file.includes("..")) {
      res.status(404).end();
      return;
    }
    try {
      const upstream = await fetch(`${adminBaseUrl}/uploads/emoji/${file}`);
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status === 404 ? 404 : 502).end();
        return;
      }
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(buffer);
    } catch (err: unknown) {
      if (logger) logger.debug({ err, file }, "emoji proxy failed");
      res.status(502).end();
    }
  });

  // ── Static SPA (single-image mode) ────────────────────────────────────────
  // When `REIWA_WEB_DIST` points at a built SPA (the unified Docker image
  // copies `web/dist` here), the API also serves the front-end: hashed
  // assets with long-lived caching, everything else falling back to
  // index.html for client-side routing. This collapses the old
  // reiwa + reiwa-web (nginx) split into one container/image. When the
  // env is unset (dev, where Vite serves the SPA on :5173) the block is
  // skipped and the API stays API-only.
  const webDist = process.env["REIWA_WEB_DIST"];
  if (webDist !== undefined && webDist.length > 0 && fs.existsSync(webDist)) {
    const indexHtml = path.join(webDist, "index.html");
    // Hashed assets are immutable — cache hard. index.html is revalidated.
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith("index.html")) {
            res.setHeader("Cache-Control", "no-cache");
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );
    // SPA fallback for non-API GETs — hand any unmatched route to the
    // client router. API 404s are left to the routers above.
    app.get(/^(?!\/api\/).*/, (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET") {
        next();
        return;
      }
      res.sendFile(indexHtml, (err) => {
        if (err) next(err);
      });
    });
    if (logger) {
      logger.info({ webDist }, "serving SPA from API (single-image mode)");
    }
  }

  // ── Global error handler ──────────────────────────────────────────────────
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    // Prefer the per-request child logger attached by `pino-http`; it
    // already carries the request-id binding so the error line is
    // correlated with the access log.
    const reqLogger = (req as { log?: Logger }).log;
    if (reqLogger) {
      reqLogger.error({ err }, "Unhandled API error");
    } else if (logger) {
      logger.error({ err }, "Unhandled API error");
    } else {
      console.error("[reiwa-api error]", err.message);
    }
    errorReporter.report({
      message: err.message,
      stack: err.stack,
      context: { scope: 'api.error-handler', path: (req.path ?? '').split('?')[0] },
    });
    res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
