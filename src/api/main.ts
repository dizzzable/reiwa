import { createServer } from "node:http";
import { loadConfig, resolveRezeisAdminUrl } from "../config.js";
import { warnOnUnreachableCrossHostUrls } from "../core/config/index.js";
import { AdminClient } from "../lib/admin-client.js";
import { SessionStore } from "../lib/session-store.js";
import { WebSessionStore } from "../infrastructure/redis/session.js";
import { createLogger } from "../infrastructure/logger/index.js";
import { createErrorReporter } from "../infrastructure/error-reporter/index.js";
import { installProcessErrorGuards } from "../infrastructure/error-reporter/process-guards.js";
import { REIWA_VERSION } from "../core/version.js";
import { printReiwaBanner } from "../core/banner.js";
import type { LatestConfigVersionsPort } from "../infrastructure/config-versions/latest.js";
import {
  ConfigVersionPoller,
  type VersionedGroup,
} from "../infrastructure/config-versions/poller.js";
import { pruneBrandingAssetCache } from "./branding-pwa.js";
import { createApp } from "./app.js";

const config = loadConfig();
const rezeisAdminUrl = resolveRezeisAdminUrl(config);

// ── Logger ────────────────────────────────────────────────────────────────────
// Single root logger per process; child loggers are spawned per request
// by `pino-http` and inherit the `service` binding.
const logger = createLogger({
  service: "api",
});

// ── Clients ───────────────────────────────────────────────────────────────────
const adminClient =
  rezeisAdminUrl && config.REZEIS_TOKEN
    ? new AdminClient(
        rezeisAdminUrl,
        config.REZEIS_TOKEN,
        config.REZEIS_INTERNAL_SHARED_SECRET ?? undefined,
      )
    : null;

const sessionStore = config.REDIS_URL
  ? new SessionStore(config.REDIS_URL, { logger })
  : null;

const webSessionStore = config.REDIS_URL
  ? new WebSessionStore(config.REDIS_URL, { logger })
  : null;

// Last-resort guards for failures that escape the per-route try/catch and
// the Express error middleware (stray rejections, uncaught throws in timers).
const errorReporter = createErrorReporter({ adminClient, source: "api" });
installProcessErrorGuards({ logger, errorReporter });

const app = createApp({ adminClient, sessionStore, webSessionStore, config, logger });

// ── Redis readiness (fail-closed in production) ────────────────────────────────
// Redis backs web sessions, the rate limiter and brute-force detection. In
// production a missing Redis silently disables those protections, so we
// refuse to boot when the connection fails — unless the operator explicitly
// opts into degraded mode via REIWA_ALLOW_DEGRADED=true. Non-production
// always permits degraded boot for local dev / smoke tests.
async function connectStore(
  store: { connect: () => Promise<void> } | null,
  name: string,
): Promise<void> {
  if (!store) return;
  try {
    await store.connect();
  } catch (err) {
    const degradedAllowed =
      config.NODE_ENV !== "production" || config.REIWA_ALLOW_DEGRADED;
    if (!degradedAllowed) {
      throw new Error(
        `${name}: Redis connection required in production but unavailable. ` +
          `Fix the Redis connection or set REIWA_ALLOW_DEGRADED=true to boot ` +
          `without it (sessions, rate limiting and brute-force protection will not work).`,
        { cause: err },
      );
    }
    logger.warn(
      { err, component: name },
      "Redis unavailable — booting in DEGRADED mode (sessions / rate-limit / brute-force disabled)",
    );
  }
}

// ── Server ────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  await connectStore(sessionStore, "SessionStore");
  await connectStore(webSessionStore, "WebSessionStore");

  const server = createServer(app);
  const port = config.PORT ?? config.REIWA_PORT;
  server.listen(port, config.REIWA_HOST, () => {
    logger.info(
      {
        port,
        version: REIWA_VERSION,
        hmacSigning: Boolean(config.REZEIS_INTERNAL_SHARED_SECRET),
        webSessionStore: Boolean(webSessionStore),
      },
      "reiwa-api listening",
    );
    // Success banner — printed only once the HTTP server is actually listening.
    printReiwaBanner("api");
    // Split-VPS guard: warn (never fail) when REZEIS_HOST still names a docker
    // service that does not resolve from this host. Runs on the api process
    // only — bot and worker share the same .env, so a second and third copy of
    // the same warning would add noise, not information. Returns immediately;
    // the probes run on unref'd timers over the next five minutes.
    warnOnUnreachableCrossHostUrls(config, logger);
  });

  // Report our running version to the admin panel so its "Updates" widget
  // can show the live reiwa version next to the latest release. Fire on
  // boot, then re-announce hourly so an admin restart re-learns it without
  // requiring a reiwa redeploy. Best-effort: failures are logged at debug.
  if (adminClient) {
    const announce = (): void => {
      adminClient.system
        .reportReiwaVersion(REIWA_VERSION)
        .catch((err: unknown) =>
          logger.debug({ err }, "reiwa version heartbeat failed"),
        );
    };
    announce();
    const heartbeat = setInterval(announce, 60 * 60 * 1_000);
    heartbeat.unref();
  }

  // The version poll: the safety net under the panel's settings webhook. Every
  // ~20 s it asks the panel which version of each settings group is current,
  // re-reads the groups this process holds an older copy of, and tells the
  // panel what it holds (`infrastructure/config-versions/poller.ts`).
  // What the panel answers goes into reiwa's key of latest versions as well
  // (`config-versions/latest.ts`): the bot compares the copy it holds with it
  // on every press, so a change this process hears of first reaches the bot's
  // next press rather than the bot's own next poll.
  const latestConfigVersions = app.locals["latestConfigVersions"] as LatestConfigVersionsPort | undefined;
  const configVersionPoller =
    adminClient !== null
      ? new ConfigVersionPoller({
          consumer: "api",
          groups: app.locals["configVersionGroups"] as readonly VersionedGroup[],
          poll: (report) => adminClient.system.pollConfigVersions(report),
          onVersions: (versions, answeredAt) => void latestConfigVersions?.recordPoll(versions, answeredAt),
          logger,
        })
      : null;
  configVersionPoller?.start();

  // The logo / PWA-icon mirror is no longer wiped on every branding save, so
  // what nobody asks for is removed here instead: a minute after start, then
  // daily. Nothing depends on it running.
  const pruneMirror = (): void => {
    pruneBrandingAssetCache()
      .then((removed) => {
        if (removed > 0) logger.info({ removed }, "branding mirror: removed files unused for 30 days");
      })
      .catch((err: unknown) => logger.debug({ err }, "branding mirror prune failed"));
  };
  const firstPrune = setTimeout(pruneMirror, 60 * 1_000);
  firstPrune.unref();
  const dailyPrune = setInterval(pruneMirror, 24 * 60 * 60 * 1_000);
  dailyPrune.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "reiwa-api shutting down");
    configVersionPoller?.stop();
    if (sessionStore) await sessionStore.disconnect();
    if (webSessionStore) await webSessionStore.disconnect();
    if (adminClient) await adminClient.close().catch(() => undefined);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((err: unknown) => {
  logger.fatal({ err }, "reiwa-api failed to start");
  process.exit(1);
});
