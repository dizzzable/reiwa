/**
 * Stable string identifiers for system events emitted by reiwa to admin.
 *
 * These flow through `EventReporter` -> `POST /api/internal/events` ->
 * `SystemEventsService` on the admin side, where they are routed into the
 * audit log, the operator Telegram channel, and any configured webhooks.
 *
 * Conventions:
 *   - kebab-cased dotted namespace (`reiwa.<area>.<event>`)
 *   - past-tense verbs for completed actions (`reiwa.user.bootstrap.completed`)
 *   - state nouns for ongoing conditions (`reiwa.upstream.unreachable`)
 *
 * Stable values — operators may reference them in webhook filters or
 * Telegram delivery routing rules. Removing or renaming a value is a
 * breaking change for downstream consumers.
 */
export const ReiwaSystemEventType = {
  // ── Upstream reliability ──────────────────────────────────────────────
  UPSTREAM_UNREACHABLE: 'reiwa.upstream.unreachable',
  UPSTREAM_AUTH_FAILED: 'reiwa.upstream.auth_failed',
  UPSTREAM_TIMEOUT: 'reiwa.upstream.timeout',

  // ── Bot lifecycle ─────────────────────────────────────────────────────
  BOT_STARTED: 'reiwa.bot.started',
  BOT_HANDLER_FAILED: 'reiwa.bot.handler_failed',

  // ── Webapp / Mini App ─────────────────────────────────────────────────
  WEBAPP_INVALID_INITDATA: 'reiwa.webapp.invalid_initdata',
  WEBAPP_PAYMENT_RETURN_MALFORMED: 'reiwa.webapp.payment_return_malformed',

  // ── Configuration / seeding ───────────────────────────────────────────
  CONFIG_DEGRADED_DEFAULTS_USED: 'reiwa.config.degraded_defaults_used',
} as const;
export type ReiwaSystemEventType = (typeof ReiwaSystemEventType)[keyof typeof ReiwaSystemEventType];
