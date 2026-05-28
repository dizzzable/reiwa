import { z } from 'zod';

/**
 * Reiwa runtime configuration.
 *
 * Canonical names mirror `.env.example`. The schema is intentionally
 * permissive — every `REZEIS_*` field is optional so a reiwa process can
 * boot in degraded mode (without a functional AdminClient) for local dev
 * and smoke tests. Validation runs once at startup; loaders cache the
 * result for the process lifetime.
 *
 * See `core/config/url-resolver.ts` for the host->URL resolution logic
 * shared between `REZEIS_HOST` and `REIWA_DOMAIN`.
 */

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : null));

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const schema = z.object({
  NODE_ENV: z.string().default('development'),

  /**
   * HTTP port for the reiwa-api process. Sourced from `REIWA_PORT`
   * (canonical name in `.env.example`) with a `PORT` fallback for plain
   * Node convention and a default of 5000 to match the docker-compose
   * mapping `127.0.0.1:${REIWA_PORT:-5000}:${REIWA_PORT:-5000}`.
   */
  REIWA_PORT: z.coerce.number().int().positive().default(5000),
  PORT: z.coerce.number().int().positive().optional(),
  REDIS_URL: z.string().trim().min(1).optional(),

  // ── Connection to rezeis-admin ────────────────────────────────────────
  REZEIS_HOST: z.string().trim().min(1).optional(),
  REZEIS_PORT: z.coerce.number().int().positive().default(8000),
  REZEIS_TOKEN: optionalString,
  REZEIS_CADDY_TOKEN: optionalString,
  REZEIS_COOKIE: optionalString,
  /**
   * Optional HMAC shared secret for request signing. Independent of the
   * Bearer token — when set, every AdminClient request adds
   * `x-request-timestamp` + `x-request-signature` headers in addition to
   * the Authorization header. Verified by rezeis-admin's HMAC middleware
   * when configured on that side.
   */
  REZEIS_INTERNAL_SHARED_SECRET: z.string().trim().min(32).optional(),

  REMNAWAVE_BASE_URL: optionalUrl,
  REMNAWAVE_TOKEN: z.string().trim().min(1).optional(),

  BOT_TOKEN: z.string().trim().min(1).optional(),
  /**
   * Telegram support handle — usually `@SupportBot` or a numeric chat
   * id. Used by the bot's `help` callback and `/help` command to render
   * a "Contact support" button or link when the operator-managed
   * `BotConfig.visual.supportUsername` is empty. The leading `@` is
   * stripped on read so callers always see a bare handle.
   *
   * Operators are expected to set this via the admin Bot-Texts UI
   * eventually; this env-level fallback exists so a fresh deploy without
   * any admin overrides still gives users a way to reach support.
   */
  BOT_SUPPORT_USERNAME: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@+/, ''))
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  /**
   * Telegram dev/operator id used as the recipient of internal alerts
   * (errors, suspicious-activity pings). Numeric. Optional — when unset
   * dev pings fall through to the bot logger.
   */
  BOT_DEV_ID: z.coerce.number().int().positive().optional(),
  /**
   * Webhook secret token. Telegram returns this string on every webhook
   * delivery so the receiver can authenticate the call. Only used when
   * BOT_SETUP_WEBHOOK is true.
   */
  BOT_SECRET_TOKEN: optionalString,
  /**
   * Telegram bot username (with or without a leading `@`) used to build
   * deep links back to the bot/Mini App when redirecting customers from
   * a payment provider. Accepts either `RezeisBot` or `@RezeisBot`; the
   * leading `@` is stripped so callers always work with the bare handle.
   */
  BOT_USERNAME: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@+/, ''))
    .refine(
      (value) => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value),
      'BOT_USERNAME must be a valid Telegram username (5-32 chars, letters/digits/underscores, must start with a letter)',
    )
    .optional(),

  /**
   * Canonical public host of the reiwa web/Mini App. Format: bare host
   * (`reiwa.example.com`) or full URL (`https://reiwa.example.com`).
   * Used by the bot to build webApp/url buttons, referral links and
   * payment-return URLs, and by the API for CORS / CSRF allow-list.
   */
  REIWA_DOMAIN: optionalUrl,
  /**
   * @deprecated Use `REIWA_DOMAIN`. Kept as a fallback so existing
   * deployments don't break during the rename.
   */
  REIWA_PUBLIC_WEB_URL: optionalUrl,
  REIWA_COOKIE_SECRET: z.string().trim().min(1).optional(),
  REIWA_COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  REIWA_CORS_ORIGIN: z.string().trim().optional(),
});

export type ReiwaConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReiwaConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues
      .map((issue) => issue.path.join('.') || 'environment')
      .join(', ');
    throw new Error(`Invalid Reiwa environment configuration: ${names}`);
  }
  return parsed.data;
}
