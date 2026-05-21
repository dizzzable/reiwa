import { loadConfig, resolveRezeisAdminUrl } from "../config.js";
import { AdminClient } from "../lib/admin-client.js";

const config = loadConfig();
const rezeisAdminUrl = resolveRezeisAdminUrl(config);

const adminClient =
  rezeisAdminUrl && config.REZEIS_TOKEN
    ? new AdminClient(
        rezeisAdminUrl,
        config.REZEIS_TOKEN,
        config.REZEIS_INTERNAL_SHARED_SECRET ?? undefined,
      )
    : null;

const BOT_TOKEN = config.BOT_TOKEN;

// ── Telegram Bot API helper ───────────────────────────────────────────────────

async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: "HTML" | undefined = "HTML",
): Promise<boolean> {
  if (!BOT_TOKEN) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    const data = (await res.json()) as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
}

// ── Expiry alert job ──────────────────────────────────────────────────────────

async function runExpiryAlerts(): Promise<void> {
  if (!adminClient) return;

  try {
    // Call the internal expiry-alerts endpoint (returns users with expiring subs).
    // Falls back gracefully if the endpoint doesn't exist yet (404 / network error).
    const alerts = (await adminClient
      .getExpiryAlerts()
      .catch(() => null)) as Array<{
      telegramId: string;
      daysLeft: number;
      planName: string;
      expireAt: string;
    }> | null;

    if (!alerts || !alerts.length) return;

    console.log(`[worker] Sending ${alerts.length} expiry alert(s)`);

    for (const alert of alerts) {
      const { telegramId, daysLeft, planName } = alert;

      const text =
        daysLeft <= 1
          ? `⚠️ <b>Подписка истекает сегодня!</b>\n\n` +
            `Тариф: ${planName}\n\n` +
            `Продлите подписку, чтобы не потерять доступ.`
          : `🕐 <b>Подписка истекает через ${daysLeft} ${daysLeft < 5 ? "дня" : "дней"}</b>\n\n` +
            `Тариф: ${planName}\n\n` +
            `Заблаговременно продлите подписку.`;

      await sendTelegramMessage(telegramId, text, "HTML");

      // Small delay between messages to avoid Telegram rate limits
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (err: unknown) {
    console.error("[worker] Expiry alerts error:", (err as Error).message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runWorker(): Promise<void> {
  console.log("[reiwa-worker] Starting...");

  if (!adminClient) {
    console.warn(
      "[reiwa-worker] Admin client not configured — worker in degraded mode",
    );
  }
  if (!BOT_TOKEN) {
    console.warn("[reiwa-worker] BOT_TOKEN not set — Telegram pushes disabled");
  }

  // Run immediately on startup, then on schedule
  await runExpiryAlerts();

  // Run expiry alerts every hour
  setInterval(runExpiryAlerts, 60 * 60 * 1_000);

  console.log("[reiwa-worker] Running. Expiry alerts: every 1h");

  // Keep process alive and handle graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[reiwa-worker] Shutting down (SIGTERM)");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log("[reiwa-worker] Shutting down (SIGINT)");
    process.exit(0);
  });
}

runWorker().catch(console.error);
