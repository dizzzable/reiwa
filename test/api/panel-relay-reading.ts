/**
 * How the panel reads one answer from `POST /api/v1/webhooks/rezeis`.
 *
 * Restated from `rezeis-admin` rather than imported — the two repositories
 * build and ship separately and share no package — so a relay test can assert
 * in the panel's own terms ("recorded as delivered", "retried") instead of
 * against a bare number whose meaning lives in another repository:
 *
 *  - `BotNotifierClient.deliver`
 *    (`src/modules/notifications/services/bot-notifier.client.ts`):
 *    non-2xx -> `rejected`; 204 -> `unconfirmed`; a 2xx whose JSON body has a
 *    numeric `messageId` -> `confirmed`, carrying that id; any other 2xx ->
 *    `unconfirmed`. On a non-2xx it also reads `Retry-After` (delta-seconds)
 *    into `retryAfterSeconds`, which the relay queue's backoff honours
 *    (`resolveRelayBackoff`: the later of its own delay and the wait + 1s,
 *    capped at 15 minutes) — WHEN a retry happens, never WHETHER. Nothing in
 *    the body of a non-2xx changes the classification either, so neither
 *    appears in the reading below.
 *  - whether an outcome is DELIVERED has two owners. `isRelayDelivered`
 *    (`src/modules/notifications/reiwa-relay.policy.ts`), for the relay queue:
 *    `reiwa.user.notify` only when `confirmed`, every other queued event also
 *    when `unconfirmed`. `reiwa.backup.document` is not on that queue: its
 *    caller, `BackupService.deliverToTelegram`
 *    (`src/modules/backup/services/backup.service.ts`), accepts only
 *    `confirmed` — anything else stamps the backup local-only.
 *  - `isRetryableRelayOutcome` (`src/modules/backup/backup-delivery-retry.util.ts`):
 *    a `rejected` outcome is retried only for `status >= 500 || 408 || 429`.
 *  - not in the reading: whether an undelivered outcome ALERTS. The relay
 *    processor stays quiet for a user notification's `unconfirmed` and for a
 *    dev route that reached nobody, its 424 or its 422 (`shouldAlertOperator`,
 *    `isDevRelayDeadEnd`).
 *  - `ReiwaRelayProcessor.rememberChannelPost`
 *    (`src/modules/notifications/reiwa-relay.processor.ts`), run only for a
 *    delivered job: for `reiwa.channel.broadcast` whose `eventId` starts with
 *    `broadcast-channel:` (`BROADCAST_CHANNEL_EVENT_PREFIX`,
 *    `src/modules/broadcast/broadcast.constants.ts`), it stores
 *    `{ channelChatId: metadata.chatId, channelMessageId: BigInt(messageId) }`
 *    on that broadcast — and stores nothing when `messageId` is null. That row
 *    is the only address the panel's channel-post edit and recall can use.
 *
 * If the panel changes one of those rules this copy has to follow; the
 * literals are deliberate, so the copy cannot quietly agree with itself.
 */
export interface PanelReading {
  readonly status: 'confirmed' | 'unconfirmed' | 'rejected';
  readonly delivered: boolean;
  readonly retryable: boolean;
}

/** `NotifyDeliveryResult`, minus the fields no assertion here needs. */
export interface PanelDeliveryResult {
  readonly status: PanelReading['status'];
  readonly messageId: number | null;
}

interface WebhookAnswer {
  readonly status: number;
  readonly text: string;
}

export function panelDeliveryResult(answer: WebhookAnswer): PanelDeliveryResult {
  if (answer.status < 200 || answer.status >= 300) return { status: 'rejected', messageId: null };
  if (answer.status === 204) return { status: 'unconfirmed', messageId: null };
  let messageId: unknown = null;
  try {
    messageId = (JSON.parse(answer.text) as { messageId?: unknown } | null)?.messageId;
  } catch {
    messageId = null;
  }
  return typeof messageId === 'number'
    ? { status: 'confirmed', messageId }
    : { status: 'unconfirmed', messageId: null };
}

/** The events delivered only on proof: a Telegram message id. */
const DELIVERED_ONLY_WHEN_CONFIRMED: ReadonlySet<string> = new Set(['reiwa.user.notify', 'reiwa.backup.document']);

export function panelReading(event: string, answer: WebhookAnswer): PanelReading {
  const { status } = panelDeliveryResult(answer);
  const delivered = DELIVERED_ONLY_WHEN_CONFIRMED.has(event) ? status === 'confirmed' : status !== 'rejected';
  const retryable =
    status === 'rejected' && (answer.status >= 500 || answer.status === 408 || answer.status === 429);
  return { status, delivered, retryable };
}

export const BROADCAST_CHANNEL_EVENT_PREFIX = 'broadcast-channel:';

/** What `rememberChannelPost` writes for this delivery, or `null` when it writes nothing. */
export function panelRememberedChannelPost(
  event: string,
  metadata: Readonly<Record<string, unknown>>,
  answer: WebhookAnswer,
): { readonly broadcastId: string; readonly channelChatId: string; readonly channelMessageId: bigint } | null {
  if (!panelReading(event, answer).delivered) return null;
  if (event !== 'reiwa.channel.broadcast') return null;
  const eventId = typeof metadata['eventId'] === 'string' ? metadata['eventId'] : '';
  if (!eventId.startsWith(BROADCAST_CHANNEL_EVENT_PREFIX)) return null;
  const broadcastId = eventId.slice(BROADCAST_CHANNEL_EVENT_PREFIX.length);
  const { messageId } = panelDeliveryResult(answer);
  if (broadcastId.length === 0 || messageId === null) return null;
  const chatId = typeof metadata['chatId'] === 'string' ? metadata['chatId'] : null;
  if (chatId === null) return null;
  return { broadcastId, channelChatId: chatId, channelMessageId: BigInt(messageId) };
}
