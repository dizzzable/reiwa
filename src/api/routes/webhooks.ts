import { Router, Request, Response } from "express";
import { z } from "zod";

import type { ReiwaConfig } from "../../config.js";
import { invalidateLegalDocumentsCache } from '../../infrastructure/admin-client/legal-documents-cache.js';
import { getPolicyCache } from "../../infrastructure/admin-client/policy-cache.js";
import { resetBrandingCache } from "./branding.js";
import { resetLandingCache } from "./landing.js";
import { resetConnectPageCache } from "./connect-page.js";
import { evictBrandingAssetCache } from "../branding-pwa.js";
import type { AdminClient } from "../../lib/admin-client.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { verifyWebhookSignature } from "../../lib/webhook-signature.js";
import {
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
  buildInternalSignature,
} from "../../lib/internal-hmac.js";

/**
 * Total deadline for a bot relay that produces a Telegram *message*.
 *
 * 8s matches the only other bound on the same underlying call: the worker's
 * own `sendMessage` fetch (`worker/main.ts`). This hop is that call one
 * process further out (reiwa -> bot over the docker hop -> api.telegram.org),
 * and it sits alongside the request path's other outbound fetch, Turnstile at
 * 5s. Without a signal the only ceiling is undici's 300s default, so a wedged
 * bot pins an express handler for five minutes -- long after rezeis gave up
 * at 10s (`RELAY_MESSAGE_TIMEOUT_MS`), meaning nobody is even waiting for the
 * answer being held.
 *
 * THE ORDER IS AN INVARIANT, and it spans both repositories: this deadline
 * must stay strictly BELOW the panel's for the same route, so the cabinet is
 * always the side that gives up first. Invert it and the panel abandons a hop
 * the cabinet is still serving, reads its own timeout as a delivery failure,
 * and the relay queue retries an event that WAS being delivered -- a second
 * operator card, or a second document. That is not hypothetical: the panel
 * used to bound every route at 10s including the 30s document routes, and a
 * document slower than ten seconds produced exactly that duplicate.
 *
 * `PANEL_RELAY_TIMEOUTS_MS` below mirrors the panel's numbers so the ordering
 * can be tested here. The panel remains the source of truth.
 */
export const BOT_RELAY_TIMEOUT_MS = 8_000;

/**
 * Same, for the relays that carry an INLINE document: the bot has to upload
 * those bytes to Telegram before it answers, so the message budget is too
 * tight. `documentContentSchema` caps the payload at 1 MB, for which 30s is
 * generous, and it is still four orders of magnitude below "forever".
 */
export const BOT_RELAY_DOCUMENT_TIMEOUT_MS = 30_000;

/**
 * The panel's half of the same two hops, restated by hand.
 *
 * These are deliberately NOT imported. The two repositories build, version and
 * deploy separately and share no package, so there is nothing to import from;
 * a mirrored constant plus a test is the strongest link available. Change a
 * number on the panel and this copy has to follow -- `bot-relay-timeout-order`
 * is what makes forgetting fail loudly instead of quietly duplicating an
 * operator card months later.
 *
 * Source of truth:
 * `rezeis-admin/src/modules/notifications/services/bot-notifier.client.ts`
 * (`RELAY_MESSAGE_TIMEOUT_MS`, `RELAY_DOCUMENT_TIMEOUT_MS`,
 * `relayRequestTimeoutMs`). `null` there and here means the same thing: no
 * total deadline, because cutting a multi-gigabyte backup upload mid-flight
 * costs a 502, a queue retry, and a duplicate copy of those gigabytes.
 */
export const PANEL_RELAY_TIMEOUTS_MS = {
  message: 10_000,
  document: 35_000,
  backupDocument: null,
} as const;

const parseModeSchema = z.enum(["HTML", "MarkdownV2"]);
// The notify button contract mirrors what the reiwa-bot listener actually
// renders (see `internal-http-listener.ts`): a label plus exactly one target —
// an https `url`, a relative Mini App `webAppPath`, or a `callbackData` token —
// with optional `style` (Bot API 9.4 colour) and `row` (keyboard layout). The
// earlier `z.never()` shape locked out webAppPath/callbackData/style/row, which
// silently 400'd every promo broadcast and every templated button. We validate
// each target's format (this endpoint is HMAC-verified, so the sender is
// already authenticated — validation is shape hygiene, not an auth boundary)
// and let the bot apply target precedence and drop any target-less button.
const buttonStyleSchema = z.enum(["primary", "success", "danger"]);
const buttonUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => /^https:\/\/\S+$/i.test(value), {
    message: "button url must be an absolute https URL",
  });
// Relative Mini App path (e.g. `/promo?code=X`). Intentionally only bounded, not
// format-checked: the bot anchors it to its own `miniAppUrl` and re-validates the
// resolved URL with `isTelegramSafeButtonUrl`, dropping just that button if it's
// unsafe. Rejecting a malformed path here would 400 the WHOLE notification (text +
// banner + other buttons) — stricter than the bot and against this fix's goal.
const webAppPathSchema = z.string().trim().min(1).max(512);
// Telegram caps callback_data at 64 bytes; keep the charset permissive since the
// operator authors it and the source is authenticated.
const callbackDataSchema = z.string().trim().min(1).max(64);
const buttonSchema = z.object({
  text: z.string().trim().min(1).max(64),
  url: buttonUrlSchema.optional(),
  webAppPath: webAppPathSchema.optional(),
  callbackData: callbackDataSchema.optional(),
  style: buttonStyleSchema.optional(),
  row: z.number().int().min(0).max(99).optional(),
});
// Buttons degrade INDIVIDUALLY. One malformed entry — an `http://` url, a
// callbackData over the limit, a hand-edited `row` — used to reject the entire
// notification, so a decoration killed the message. The bot already drops
// unusable buttons one by one; match that, and keep the text on its way.
const buttonsSchema = z
  .array(z.unknown())
  .max(50)
  .transform((entries) => {
    const kept: z.infer<typeof buttonSchema>[] = [];
    for (const entry of entries) {
      const parsed = buttonSchema.safeParse(entry);
      if (parsed.success && kept.length < 20) kept.push(parsed.data);
    }
    return kept.length > 0 ? kept : undefined;
  });
const eventIdSchema = z.string().trim().min(1).max(128);
/**
 * The same dedup key, OPTIONAL, for the two dev-fallback events.
 *
 * The three subscriber/operator events below REQUIRE `eventId`, and that stays
 * right for them: the panel mints it as `UserNotificationEvent.id` and
 * `BotNotifierClient.notifyUser` / `notifyBroadcast` / `notifyBroadcastDocument`
 * all declare `eventId: string` as a required argument, so no shipped panel can
 * produce one of those payloads without it.
 *
 * `notifyDev` / `notifyDevDocument` have no such argument — today's panel sends
 * these two with `{ text, parseMode }` / `{ filename, content, caption,
 * parseMode }` and nothing else (the panel records the gap itself, in
 * `modules/notifications/reiwa-relay.policy.ts`: `botDedupKeyed: false`, "the fix
 * is cabinet-side"). Requiring the field here would 400 every dev alert coming
 * from a panel that predates the field — and these two are the firehose that
 * only matters while something is already broken, so the rejection would land
 * exactly during the incident it exists to report.
 *
 * `.catch(undefined)` for the same reason a malformed `bannerUrl` is dropped
 * rather than fatal: a key that fails the shape check degrades this event to
 * "delivered, not deduped" — one extra card for the operator to glance past —
 * whereas rejecting it loses the alert outright.
 */
const optionalEventIdSchema = eventIdSchema.optional().catch(undefined);
// Upper bound is deliberately generous, NOT Telegram's 4096: that limit counts
// RENDERED characters, while what arrives here is HTML. rezeis composes
// `<b>title</b>\n\n<body>` from a title of up to 500 and a body of up to 8000
// chars, so a perfectly deliverable message routinely exceeds 4096 bytes of
// markup — capping at 4096 here was rejecting real notifications outright.
// Keep `min(1)` WITHOUT trimming:
// rezeis sends a ` ` placeholder when a banner carries the message and the text
// is empty (a photo caption may be blank), so trimming here would 400 the whole
// banner notification. reiwa's job is to forward well-shaped payloads; whether a
// text-only ` ` is deliverable is the bot's/Telegram's concern, not ours.
const textSchema = z.string().min(1).max(4096);
// Telegram caption limit is 1024. Captions here are HTML (`parseMode: HTML`
// on every document sender), so slicing at 1024 CHARACTERS would cut a tag in
// half and Telegram would reject the whole send with "can't parse entities" —
// which the bot reports as a permanent 4xx, i.e. the document would vanish
// silently. Drop an over-long caption instead: the full text is already in the
// document body, so the report still arrives, just without the preview card.
const captionSchema = z
  .string()
  .max(100_000)
  .transform((value) => (value.length > 1024 ? undefined : value));
const filenameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
// Numeric chat id (`-100…` for channels) OR an `@username` — operators may
// configure either; the bot forwards the value to Telegram verbatim.
// `.trim()` first: the operator types this into a settings field, and a stray
// space would otherwise 400 every single broadcast.
const chatIdSchema = z
  .string()
  .trim()
  .regex(/^(?:-?\d{1,19}|@[A-Za-z0-9_]{4,32})$/);
const telegramIdSchema = z.string().regex(/^\d{1,19}$/);
const topicThreadIdSchema = z.number().int().positive();
const documentContentSchema = z.string().min(1).max(1_000_000);
// Banner accepted by the bot's `banner-resolver`: an absolute http(s) URL
// (Telegram fetches it), a relative `/uploads/…` path (fetched from the admin
// over the docker hop), or a Telegram `file_id` (opaque token, reused as-is).
const bannerUrlSchema = z.union([
  z.string().trim().max(2048).regex(/^https?:\/\/\S+$/i, "https(s) banner url"),
  // Mirror the bot's `RELATIVE_UPLOADS_RE` exactly: fixed upload subdirs and a
  // single filename — no nested paths, so `..` traversal can't slip through.
  z
    .string()
    .trim()
    .max(1024)
    .regex(
      /^\/uploads\/(?:bot-banners|bot-flow|branding|emoji|faq|icons)\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)?$/,
      "relative /uploads banner path",
    ),
  z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/, "telegram file_id"),
]);
/**
 * A banner is decoration. `bannerUrl` is a free-text field on the admin side,
 * so an operator can easily save something the resolver cannot use — and losing
 * the whole notification over a broken image is the wrong trade. Drop just the
 * banner and deliver the text, which is what the bot does when the image fails
 * to load anyway.
 */
const optionalBannerUrlSchema = bannerUrlSchema.optional().catch(undefined);

/**
 * Metadata objects are intentionally NOT `.strict()`. rezeis and reiwa ship as
 * separate images, so a field added on the admin side lands here before this
 * service is updated; rejecting unknown keys would 400 the whole event during
 * every staggered deploy. Nothing can leak through: each relay body below is
 * rebuilt from named fields only, so extra keys are simply ignored.
 */
function parseRelayMetadata<T>(schema: z.ZodType<T>, metadata: Record<string, unknown>): T {
  return schema.parse(metadata);
}

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
 *   - `reiwa.user.notify`       → POST bot `/notify`            { eventId, telegramId, text, parseMode?, buttons?, bannerUrl? }
 *   - `reiwa.channel.broadcast` → POST bot `/notify-broadcast`  { eventId, chatId, topicThreadId?, text, parseMode?, buttons? }
 *   - `reiwa.channel.broadcast.document` → POST bot `/notify-broadcast-document` { eventId, chatId, content, filename?, caption?, topicThreadId?, parseMode? }
 *   - `reiwa.dev.notify`        → POST bot `/notify-dev`            { eventId?, text, parseMode? }
 *   - `reiwa.dev.notify.document` → POST bot `/notify-dev-document` { eventId?, content, filename?, caption?, parseMode? }
 *   - `reiwa.backup.document`   → POST bot `/notify-backup-document` { recordId, token, chatId, filename?, caption?, topicThreadId? }
 * Unknown event types are ack'd (204).
 *
 * RETRIES — these webhooks ARE retried, which was not true when this block was
 * first written. The panel now puts them through `ReiwaRelayQueueService`
 * (BullMQ): durable events get 4 attempts on a 15s -> 30s -> 60s backoff,
 * bounded ones 2 attempts at a fixed 10s. Deadlines per route are
 * `relayRequestTimeoutMs` — 10s for messages, 35s for inline documents, none
 * for `reiwa.backup.document`.
 *
 * A handler here can therefore see the SAME event more than once, and must not
 * treat a second arrival as news. That is what `eventId` is for: every event
 * above except the four cache invalidations carries one, and the bot claims it
 * through `IDEMPOTENCY_CACHE` before acting. The invalidations need no key —
 * dropping a cache twice is dropping it once.
 *
 * Not to be confused with the panel's OTHER retrying dispatcher
 * (`modules/webhooks/services/webhook-dispatcher.service.ts`), which serves the
 * OPERATOR-facing external webhook system and never touches this path.
 *
 * The one exception is `reiwa.backup.document`: its caller (`BackupService`)
 * inspects the outcome and re-runs on a BullMQ job with `attempts: 3`. So the
 * 4xx-vs-502 split below changes what actually happens only for that event.
 * For every other event a 502 means the message is simply lost — the panel
 * writes one `logger.warn` and moves on.
 *
 * Response contract: the two events whose delivery rezeis has to record —
 * `reiwa.user.notify` and `reiwa.backup.document` — answer `200 { messageId }`,
 * echoing Telegram's own id (or `null` when the bot could not prove a
 * delivery). Every other event acks with a bodiless 204. rezeis treats a 2xx
 * without a numeric `messageId` as "accepted but unconfirmed", never as
 * delivered, so the id must not be dropped on those two paths.
 */
export function createRezeisWebhookRouter(deps: { config: ReiwaConfig }) {
  const { config } = deps;
  const router = Router();

  const secret = config.REZEIS_WEBHOOK_SECRET;
  const botUrl = config.REIWA_BOT_INTERNAL_URL.replace(/\/+$/, "");
  const relaySecret = config.REZEIS_INTERNAL_SHARED_SECRET;

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
          const parsed = parseRelayMetadata(z.object({ telegramId: telegramIdSchema, text: textSchema, eventId: eventIdSchema, parseMode: parseModeSchema.optional(), buttons: buttonsSchema.optional(), bannerUrl: optionalBannerUrlSchema }), meta);
          const { telegramId, text, eventId } = parsed;
          // The bot's /notify only accepts a plain Telegram numeric id
          // (1-19 digits). A non-numeric / out-of-range value (e.g. a dirty
          // imported id, or a negative chat id) would be rejected there with a
          // 400 → surfaced here as a misleading 502. Catch it up front: such a
          // push can never reach Telegram, so drop the Telegram channel (the
          // cabinet feed + web-push already fired on the rezeis side) and ack.
          if (!/^\d{1,19}$/.test(telegramId)) {
            getRequestLogger(req).warn(
              { telegramId },
              "reiwa.user.notify: telegramId is not a Telegram numeric id; dropping Telegram push",
            );
            res.status(200).json({ messageId: null });
            return;
          }
          const relayed = await relayToBot("/notify", {
            eventId,
            telegramId,
            text,
            ...(parsed.parseMode ? { parseMode: parsed.parseMode } : {}),
            ...(parsed.buttons ? { buttons: parsed.buttons } : {}),
            ...(parsed.bannerUrl ? { bannerUrl: parsed.bannerUrl } : {}),
          });
          // Surface the Telegram message id back to admin so it can persist
          // it (broadcast edits/deletes need it within the 48h window).
          res.status(200).json({ messageId: relayed.messageId });
          return;
        }
        case "reiwa.dev.notify": {
          // Auto dev-fallback: deliver a system-event card to the bot's
          // BOT_DEV_ID (the bot knows it; rezeis doesn't). Used when no
          // operator group/topic is configured. Best-effort.
          const parsed = parseRelayMetadata(z.object({ text: textSchema, eventId: optionalEventIdSchema, parseMode: parseModeSchema.optional() }), meta);
          // Forward the dedup key when the panel sent one: the panel now relays
          // this event off a BullMQ queue with 4 attempts (15s/30s/60s backoff),
          // so the bot can see the same card up to four times. Omit the field
          // entirely when absent, so the bot tells "no key" apart from "empty key".
          await relayToBot("/notify-dev", {
            ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
            text: parsed.text,
            ...(parsed.parseMode ? { parseMode: parsed.parseMode } : {}),
          });
          break;
        }
        case "reiwa.dev.notify.document": {
          // Auto dev-fallback (errors): deliver the full `.txt` error report as
          // a Telegram document to the bot's BOT_DEV_ID, with the sectioned
          // card as caption + a Close button. Best-effort.
          const parsed = parseRelayMetadata(z.object({ content: documentContentSchema, eventId: optionalEventIdSchema, filename: filenameSchema.optional(), caption: captionSchema.optional(), parseMode: parseModeSchema.optional() }), meta);
          await relayToBot("/notify-dev-document", {
            ...(parsed.eventId ? { eventId: parsed.eventId } : {}),
            content: parsed.content,
            ...(parsed.filename ? { filename: parsed.filename } : {}),
            ...(parsed.caption ? { caption: parsed.caption } : {}),
            ...(parsed.parseMode ? { parseMode: parsed.parseMode } : {}),
          }, BOT_RELAY_DOCUMENT_TIMEOUT_MS);
          break;
        }
        case "reiwa.channel.broadcast": {
          const parsed = parseRelayMetadata(z.object({ chatId: chatIdSchema, text: textSchema, eventId: eventIdSchema, topicThreadId: topicThreadIdSchema.optional(), parseMode: parseModeSchema.optional(), buttons: buttonsSchema.optional() }), meta);
          await relayToBot("/notify-broadcast", {
            eventId: parsed.eventId,
            chatId: parsed.chatId,
            text: parsed.text,
            ...(parsed.topicThreadId ? { topicThreadId: parsed.topicThreadId } : {}),
            ...(parsed.parseMode ? { parseMode: parsed.parseMode } : {}),
            ...(parsed.buttons ? { buttons: parsed.buttons } : {}),
          });
          break;
        }
        case "reiwa.channel.broadcast.document": {
          const parsed = parseRelayMetadata(z.object({ eventId: eventIdSchema, chatId: chatIdSchema, content: documentContentSchema, filename: filenameSchema.optional(), caption: captionSchema.optional(), topicThreadId: topicThreadIdSchema.optional(), parseMode: parseModeSchema.optional() }), meta);
          await relayToBot("/notify-broadcast-document", {
            eventId: parsed.eventId,
            chatId: parsed.chatId,
            content: parsed.content,
            ...(parsed.filename ? { filename: parsed.filename } : {}),
            ...(parsed.caption ? { caption: parsed.caption } : {}),
            ...(parsed.topicThreadId ? { topicThreadId: parsed.topicThreadId } : {}),
            ...(parsed.parseMode ? { parseMode: parsed.parseMode } : {}),
          }, BOT_RELAY_DOCUMENT_TIMEOUT_MS);
          break;
        }
        case "reiwa.backup.document": {
          // rezeis hands the bot a signed download URL token; the bot fetches
          // the backup file from rezeis (docker hop) and uploads it to the
          // configured chat/topic. No bytes travel through this webhook.
          const parsed = parseRelayMetadata(z.object({ recordId: eventIdSchema, token: z.string().trim().min(1).max(2048), chatId: chatIdSchema, filename: filenameSchema.optional(), caption: captionSchema.optional(), topicThreadId: topicThreadIdSchema.optional() }), meta);
          // The `null` deadline below is DELIBERATE — this is the only relay
          // without one. The bot answers this call only AFTER streaming the
          // backup out of rezeis and up to Telegram, and that file can be
          // gigabytes (the bot budgets for 2 GB via a Local Bot API Server).
          // `AbortSignal.timeout` is a TOTAL deadline, so any value small
          // enough to be useful against a wedged bot is also small enough to
          // cut a legitimately slow upload — and cutting it lands in the one
          // state the bot's handler documents as unsafe to repeat: the abort
          // surfaces here as a 502, which is the single signal BackupService
          // DOES retry (BullMQ `attempts: 3`), so one slow backup becomes two
          // or three multi-gigabyte copies in the operator's topic. Bounding
          // it safely needs an IDLE timeout, which global `fetch` cannot
          // express; it stays on undici's 300s idle default. This relay also
          // runs on a backup schedule rather than per notification, so the
          // handler-pinning cost the other six paths carry barely applies.
          const relayed = await relayToBot("/notify-backup-document", {
            recordId: parsed.recordId,
            token: parsed.token,
            chatId: parsed.chatId,
            ...(parsed.filename ? { filename: parsed.filename } : {}),
            ...(parsed.caption ? { caption: parsed.caption } : {}),
            ...(parsed.topicThreadId ? { topicThreadId: parsed.topicThreadId } : {}),
          }, null);
          // Surface the Telegram message id back to admin — same shape as
          // `reiwa.user.notify` above. A 2xx only proves this relay instruction
          // was accepted; the bot fetches and uploads afterwards, so the id is
          // the sole evidence the backup actually reached Telegram. Answering
          // 204 here (no body, no id) makes rezeis record EVERY backup as not
          // delivered, and it classifies that outcome as non-retryable.
          // `messageId` is null when the bot could not prove a delivery — never
          // a fabricated id.
          res.status(200).json({ messageId: relayed.messageId });
          return;
        }
        case "reiwa.platform.policy_invalidated": {
          // Drop the cached platform policy so the next gated request
          // refetches the current accessMode immediately.  No relay
          // to the bot — the bot reads through the same cache.
          getPolicyCache((req.app.locals['adminClient'] ?? null) as AdminClient | null).invalidate();
          // The panel fires this same webhook when a legal document is edited
          // (reason `legal.<KEY>`), so the bot's copy is dropped here too —
          // otherwise switching a document on would take up to a minute to
          // change which link the rules screen offers.
          invalidateLegalDocumentsCache();
          break;
        }
        case "reiwa.branding.invalidate": {
          // Drop the cached public-config so the cabinet picks up the new
          // theme on its next load instead of waiting for the HTTP TTL.
          resetBrandingCache();
          // Also evict the on-disk branding-asset mirror so a re-uploaded logo
          // / PWA icon is re-fetched fresh on the next request.
          void evictBrandingAssetCache();
          break;
        }
        case "reiwa.connect-page.invalidate": {
          // Drop the cached connect-screen catalog so the apps an operator just
          // edited appear on the next tap of "Подключить" rather than after the
          // HTTP TTL. Cabinet-only — the bot has no part in this screen.
          resetConnectPageCache();
          break;
        }
        case "reiwa.landing.invalidate": {
          // Drop the cached web-landing payload so a freshly-published landing
          // (or a rollback) appears on the next visitor load instead of waiting
          // for the HTTP TTL. Web-only — no relay to the bot.
          resetLandingCache();
          break;
        }
        default:
          // Unknown/irrelevant event — ack. Nothing retries this path (see the
          // RETRIES note in the file header); the ack only avoids a bogus 5xx.
          res.status(204).end();
          return;
      }
      res.status(204).end();
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ message: "invalid webhook metadata" });
        return;
      }
      if (err instanceof BotRelayError && err.status >= 400 && err.status < 500) {
        // The bot rejected the payload as permanently invalid (4xx) — e.g. a
        // telegramId that isn't a Telegram numeric id, or empty text. A retry
        // could never succeed, so ack (2xx) and log the details for diagnosis
        // instead of returning a 502. (Nothing retries `reiwa.user.notify`
        // either way — see the RETRIES note in the file header.)
        getRequestLogger(req).warn(
          { event, botStatus: err.status, path: err.path },
          "rezeis webhook: bot rejected payload as invalid (permanent); dropping",
        );
        res.status(200).json({ dropped: true });
        return;
      }
      getRequestLogger(req).error({ err, event }, "rezeis webhook relay failed");
      // 502 = transient (bot 5xx / network), unlike the 4xx bad payload above.
      // Only `reiwa.backup.document` is actually retried on this signal
      // (BackupService re-runs it on a BullMQ job, `attempts: 3`). For every
      // other event this 502 is recorded and dropped — see the file header.
      res.status(502).json({ message: "relay failed" });
    }
  });

  /**
   * Relay a verified webhook action to the reiwa-bot internal listener over
   * the private docker hop, signed with the internal HMAC scheme so the bot
   * accepts it the same way it accepts the (now-removed) direct admin push.
   *
   * Returns the bot's `messageId` when it replies with one (the `/notify`
   * endpoint does on success); `null` for 204 acks or bodies without an id.
   *
   * `timeoutMs` is a TOTAL deadline (`AbortSignal.timeout`), not an idle one,
   * and it covers reading the response body as well as the round-trip. Pass
   * `null` only where a correct call can legitimately outrun any fixed budget
   * — today that is the backup relay alone, and its call site says why.
   */
  async function relayToBot(
    path: string,
    body: unknown,
    timeoutMs: number | null = BOT_RELAY_TIMEOUT_MS,
  ): Promise<{ messageId: number | null }> {
    const bodyStr = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!relaySecret) throw new Error("bot relay authentication is not configured");
    const { timestamp, signature } = buildInternalSignature({ secret: relaySecret, method: "POST", path, body: bodyStr });
    headers[REQUEST_TIMESTAMP_HEADER] = timestamp;
    headers[REQUEST_SIGNATURE_HEADER] = signature;
    const resp = await fetch(`${botUrl}${path}`, {
      method: "POST",
      headers,
      body: bodyStr,
      ...(timeoutMs === null ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });
    if (!resp.ok && resp.status !== 204) {
      throw new BotRelayError(path, resp.status);
    }
    if (resp.status === 204) return { messageId: null };
    const json = (await resp.json().catch(() => null)) as { messageId?: unknown } | null;
    const messageId =
      json !== null && typeof json.messageId === "number" ? json.messageId : null;
    return { messageId };
  }

  return router;
}

/** Coerce an unknown value to a non-empty trimmed string, or undefined. */
function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Thrown by `relayToBot` on a non-2xx/204 bot response. Carries the bot's HTTP
 * status so the webhook can distinguish a permanent 4xx (bad payload — ack &
 * drop) from a transient 5xx/network error (502). Only the backup relay has a
 * caller that retries on that 502 — see the RETRIES note in the file header.
 */
class BotRelayError extends Error {
  public constructor(
    public readonly path: string,
    public readonly status: number,
  ) {
    super(`bot relay ${path} -> ${status}`);
    this.name = "BotRelayError";
  }
}
