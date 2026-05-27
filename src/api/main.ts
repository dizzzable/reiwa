import { createServer } from "node:http";
import { loadConfig, resolveRezeisAdminUrl } from "../config.js";
import { AdminClient } from "../lib/admin-client.js";
import { SessionStore } from "../lib/session-store.js";
import { WebSessionStore } from "../infrastructure/redis/session.js";
import { createLogger } from "../infrastructure/logger/index.js";
import { createApp } from "./app.js";

const config = loadConfig();
const rezeisAdminUrl = resolveRezeisAdminUrl(config);

// ── Logger ────────────────────────────────────────────────────────────────────
// Single root logger per process; child loggers are spawned per request
// by `pino-http` and inherit the `service` binding.
const logger = createLogger({
  service: "api",
  pretty: config.NODE_ENV !== "production",
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

const app = createApp({ adminClient, sessionStore, webSessionStore, config, logger });

// ── Server ────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  if (sessionStore) await sessionStore.connect();
  if (webSessionStore) await webSessionStore.connect();

  const server = createServer(app);
  const port = config.PORT ?? config.REIWA_PORT;
  server.listen(port, "0.0.0.0", () => {
    logger.info(
      {
        port,
        hmacSigning: Boolean(config.REZEIS_INTERNAL_SHARED_SECRET),
        webSessionStore: Boolean(webSessionStore),
      },
      "reiwa-api listening",
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "reiwa-api shutting down");
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
