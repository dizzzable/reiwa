import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import type { AdminClient } from "../lib/admin-client.js";
import type { SessionStore } from "../lib/session-store.js";
import { WebSessionStore, createWebSessionMiddleware } from "../infrastructure/redis/session.js";
import type { SessionConfig } from "../infrastructure/redis/session.js";
import type { ReiwaConfig } from "../config.js";
import { resolveReiwaPublicUrl } from "../config.js";
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

export function createApp(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  webSessionStore: WebSessionStore | null;
  config: ReiwaConfig;
}) {
  const { config } = deps;
  const reiwaPublicUrl = resolveReiwaPublicUrl(config);
  const app = express();

  // ── Security ──────────────────────────────────────────────────────────────
  app.use(helmet());
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

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
      cookieSecure: config.REIWA_COOKIE_SECURE || config.NODE_ENV === "production",
      isProduction: config.NODE_ENV === "production",
    };
    app.use(createWebSessionMiddleware(deps.webSessionStore, sessionConfig));
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
  app.use("/api/v1", createBrandingRouter(deps));
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

  // ── Global error handler ──────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[reiwa-api error]", err.message);
    res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
