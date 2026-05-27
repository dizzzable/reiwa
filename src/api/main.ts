import { createServer } from "node:http";
import { loadConfig, resolveRezeisAdminUrl } from "../config.js";
import { AdminClient } from "../lib/admin-client.js";
import { SessionStore } from "../lib/session-store.js";
import { WebSessionStore } from "../redis/session.js";
import { createApp } from "./app.js";

const config = loadConfig();
const rezeisAdminUrl = resolveRezeisAdminUrl(config);

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
  ? new SessionStore(config.REDIS_URL)
  : null;

const webSessionStore = config.REDIS_URL
  ? new WebSessionStore(config.REDIS_URL)
  : null;

const app = createApp({ adminClient, sessionStore, webSessionStore, config });

// ── Server ────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  if (sessionStore) await sessionStore.connect();
  if (webSessionStore) await webSessionStore.connect();

  const server = createServer(app);
  const port = config.PORT ?? config.REIWA_PORT;
  server.listen(port, "0.0.0.0", () => {
    console.log(`[reiwa-api] Listening on port ${port}`);
    console.log(
      `[reiwa-api] HMAC signing: ${config.REZEIS_INTERNAL_SHARED_SECRET ? "enabled" : "disabled"}`,
    );
    console.log(
      `[reiwa-api] Web session store: ${webSessionStore ? "enabled" : "disabled"}`,
    );
  });

  const shutdown = async () => {
    if (sessionStore) await sessionStore.disconnect();
    if (webSessionStore) await webSessionStore.disconnect();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch(console.error);
