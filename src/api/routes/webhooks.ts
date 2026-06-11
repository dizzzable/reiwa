import { Router, Request, Response } from "express";

import type { ReiwaConfig } from "../../config.js";
import { getPolicyCache } from "../../infrastructure/admin-client/policy-cache.js";
import type { AdminClient } from "../../lib/admin-client.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { verifyWebhookSignature } from "../../lib/webhook-signature.js";
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from "../../lib/internal-hmac.js";

/**
 * Inbound rezeis-admin webhook receiver — the snoups/remnashop model.
 *
 * rezeis-admin (the panel) delivers operator events to reiwa's PUBLIC
 * domain here, signed with the admin's `WEBHOOK_SECRET_HEADER`
 * (`X-Rezeis-Signature: t=<sec>,v1=<hmac>` over `<t>.<rawBody>`). reiwa
 * verifies the signature with `REZEIS_WEBHOOK_SECRET` (the matching value),
 * then relays the action to the reiwa-bot process over the private,
 * same-VPS docker hop (`REIWA_BOT_INTERNAL_URL`, default
 * `http://reiwa-bot:5100`) — signed with the internal HMAC scheme.
 *
 * This replaces the old admin→bot direct push (`REIWA_BOT_URL`): the bot
 * is never exposed publicly; admin only knows reiwa's public domain.
 *
 * Event contract (reads `{ event, metadata }` from the admin webhook body):
 *   - `reiwa.bot.invalidate`    → POST bot `/invalidate`        { reason }
 *   - `reiwa.user.notify`       → POST bot `/notify`            { eventId, telegramId, text, parseMode?, buttons? }
 *   - `reiwa.channel.broadcast` → POST bot `/notify-broadcast`  { eventId, chatId, topicThreadId?, text, parseMode?, buttons? }
 * Unknown event types are ack'd (204) so the admin dispatcher doesn't retry.
 */
export function createRezeisWebhookRouter(deps: { config: ReiwaConfig }) {
  const { config } = deps;
  const router = Router();

  const secret = config.REZEIS_WEBHOOK_SECRET;
  const botUrl = config.REIWA_BOT_INTERNAL_URL.replace(/\/+$/, "");
  const relaySecret = config.REZEIS_INTERNAL_SHARED_SECRET ?? null;

  router.post("/webhooks/rezeis", async (req: Request, res: Response) => {
    // 1. Verify the admin signature over the RAW body (captured by the
    //    json body-parser `verify` hook in app.ts).
    const raw = (req as { rawBody?: Buffer }).rawBody?.toString("utf8") ?? "";
    const headerRaw = req.headers["x-rezeis-signature"];
    const header = typeof headerRaw === "string" ? headerRaw : undefined;
    if (!secret || !verifyWebhookSignature({ secret, header, body: raw })) {
      getRequestLogger(req).warn(
        { remoteAddress: req.ip },
        "rezeis webhook: rejected (bad or missing signature)",
      );
      res.status(401).json({ message: "invalid signature" });
      return;
    }

    const payload = (req.body ?? {}) as { event?: unknown; metadata?: unknown };
    const event = typeof payload.event === "string" ? payload.event : "";
    const meta =
      payload.metadata !== null && typeof payload.metadata === "object"
        ? (payload.metadata as Record<string, unknown>)
        : {};

    try {
      switch (event) {
        case "reiwa.bot.invalidate": {
          await relayToBot("/invalidate", {
            reason: str(meta["reason"]) ?? "admin-webhook",
          });
          break;
        }
        case "reiwa.user.notify": {
          const telegramId = str(meta["telegramId"]);
          const text = str(meta["text"]);
          const eventId = str(meta["eventId"]);
          if (!telegramId || !text || !eventId) {
            res.status(400).json({ message: "missing telegramId/text/eventId" });
            return;
          }
          await relayToBot("/notify", {
            eventId,
            telegramId,
            text,
            ...(str(meta["parseMode"]) ? { parseMode: str(meta["parseMode"]) } : {}),
            ...(Array.isArray(meta["buttons"]) ? { buttons: meta["buttons"] } : {}),
          });
          break;
        }
        case "reiwa.channel.broadcast": {
          const chatId = str(meta["chatId"]);
          const text = str(meta["text"]);
          const eventId = str(meta["eventId"]);
          if (!chatId || !text || !eventId) {
            res.status(400).json({ message: "missing chatId/text/eventId" });
            return;
          }
          await relayToBot("/notify-broadcast", {
            eventId,
            chatId,
            text,
            ...(typeof meta["topicThreadId"] === "number"
              ? { topicThreadId: meta["topicThreadId"] }
              : {}),
            ...(str(meta["parseMode"]) ? { parseMode: str(meta["parseMode"]) } : {}),
            ...(Array.isArray(meta["buttons"]) ? { buttons: meta["buttons"] } : {}),
          });
          break;
        }
        case "reiwa.platform.policy_invalidated": {
          // Drop the cached platform policy so the next gated request
          // refetches the current accessMode immediately.  No relay
          // to the bot — the bot reads through the same cache.
          getPolicyCache((req.app.locals['adminClient'] ?? null) as AdminClient | null).invalidate();
          break;
        }
        default:
          // Unknown/irrelevant event — ack so the dispatcher stops retrying.
          res.status(204).end();
          return;
      }
      res.status(204).end();
    } catch (err: unknown) {
      getRequestLogger(req).error({ err, event }, "rezeis webhook relay failed");
      // 502 so the admin dispatcher retries with backoff.
      res.status(502).json({ message: "relay failed" });
    }
  });

  /**
   * Relay a verified webhook action to the reiwa-bot internal listener over
   * the private docker hop, signed with the internal HMAC scheme so the bot
   * accepts it the same way it accepts the (now-removed) direct admin push.
   */
  async function relayToBot(path: string, body: unknown): Promise<void> {
    const bodyStr = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (relaySecret) {
      const { timestamp, signature } = buildInternalSignature({
        secret: relaySecret,
        method: "POST",
        path,
        body: bodyStr,
      });
      headers[REQUEST_TIMESTAMP_HEADER] = timestamp;
      headers[REQUEST_SIGNATURE_HEADER] = signature;
    }
    const resp = await fetch(`${botUrl}${path}`, {
      method: "POST",
      headers,
      body: bodyStr,
    });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`bot relay ${path} -> ${resp.status}`);
    }
  }

  return router;
}

/** Coerce an unknown value to a non-empty trimmed string, or undefined. */
function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
