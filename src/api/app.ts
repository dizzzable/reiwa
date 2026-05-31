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
import type { SessionConfig } from "../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../config.js";
import { resolveReiwaPublicUrl } from "../config.js";
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
import { createLinkingRouter } from "./routes/linking.js";
import { createPushRouter } from "./routes/push.js";
import { createRealtimeRouter } from "./routes/realtime.js";
import { createContentRouter } from "./routes/content.js";

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
          "img-src": ["'self'", "data:", "https://telegram.org"],
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
        // Pino-http logs the full URL by default. Cookies/Auth headers
        // are already in the redact list on the root logger.
      }),
    );
  }

  // ── Parsers ───────────────────────────────────────────────────────────────
  app.use(express.json({ limit: "1mb" }));
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
    res.json({ status: "ok", service: "reiwa-api", version: "1.0.0" });
  });

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
  app.use("/api/v1", createLinkingRouter(deps));
  app.use("/api/v1", createPushRouter(deps));
  app.use("/api/v1", createRealtimeRouter(deps));
  app.use("/api/v1", createContentRouter(deps));

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
    res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
