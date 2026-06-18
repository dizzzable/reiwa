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
  /**
   * Interface the API binds to. Defaults to `0.0.0.0` (all interfaces),
   * which is correct inside Docker. Set to `127.0.0.1` to bind loopback
   * only when running the API directly on a host behind a local proxy.
   */
  REIWA_HOST: z.string().trim().min(1).default('0.0.0.0'),
  /**
   * Full Redis connection string. Optional — when unset it is derived
   * from the discrete `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` /
   * `REDIS_NAME` vars below (the names used in `.env.example` and the
   * compose/.env file). Set `REDIS_URL` explicitly to override.
   */
  REDIS_URL: z.string().trim().min(1).optional(),
  REDIS_HOST: z.string().trim().min(1).optional(),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: optionalString,
  /** Redis logical DB index (numeric). Defaults to 0. */
  REDIS_NAME: z.coerce.number().int().min(0).default(0),

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
   * Base URL of the Telegram Bot API the bot talks to. Default is the cloud
   * API (`https://api.telegram.org`, 50 MB upload cap). Point this at a
   * self-hosted Local Bot API Server (e.g. `http://telegram-bot-api:8081`)
   * to raise `sendDocument` uploads to 2 GB — required for delivering large
   * database backups to Telegram. The trailing slash is trimmed on read.
   */
  TELEGRAM_BOT_API_ROOT: z
    .string()
    .trim()
    .url()
    .optional()
    .transform((value) => (value && value.length > 0 ? value.replace(/\/+$/, '') : null)),
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
   * Cloudflare Turnstile keys for the anonymous support widget. When the
   * secret is set, the public guest-support create endpoint requires a valid
   * Turnstile token; when unset, the endpoint falls back to rate limiting
   * alone. The site key is served to the widget for the client-side challenge.
   */
  SUPPORT_TURNSTILE_SECRET: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  SUPPORT_TURNSTILE_SITE_KEY: z
    .string()
    .trim()
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
   * TCP port for the bot's built-in cache-invalidate HTTP listener.
   * Bound to `0.0.0.0` inside the docker network so rezeis-admin can
   * push a synchronous cache-bust when an operator saves bot config.
   * Not published outside the container; protected by the same shared
   * secret as outgoing admin calls (REZEIS_INTERNAL_SHARED_SECRET).
   * When unset, defaults to 5100. The listener is silently skipped
   * entirely when REZEIS_INTERNAL_SHARED_SECRET is unset.
   */
  BOT_INVALIDATE_PORT: z.coerce.number().int().min(1024).max(65535).optional(),
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
  /**
   * Escape hatch for production deployments that intentionally terminate
   * without TLS in front of reiwa (e.g. a trusted internal-only network
   * or a sidecar that adds TLS out-of-band). When `false` (default) and
   * `REIWA_COOKIE_SECURE` is also unset, the web-session middleware
   * refuses to start in production rather than silently issuing
   * non-`Secure` session cookies. Set to `true` only when you have
   * verified the transport is otherwise protected.
   */
  REIWA_ALLOW_INSECURE_COOKIES: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /**
   * Escape hatch to boot the API without a working Redis connection.
   * Redis backs web sessions, the rate limiter and brute-force
   * detection, so without it those protections silently no-op. In
   * production the API fails closed (refuses to start) when Redis is
   * unreachable unless this flag is `true`. Non-production always allows
   * degraded boot for local dev / smoke tests.
   */
  REIWA_ALLOW_DEGRADED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  REIWA_CORS_ORIGIN: z.string().trim().optional(),

  /**
   * Shared secret used to verify inbound webhooks FROM rezeis-admin
   * (operator events: bot-config changed, per-user notifications,
   * broadcasts). Must equal the admin's `WEBHOOK_SECRET_HEADER`
   * (the same role Remnawave→remnashop calls `REMNAWAVE_WEBHOOK_SECRET`).
   * Signature scheme: `X-Rezeis-Signature: t=<sec>,v1=<hmac>` over
   * `<t>.<rawBody>`. When unset, the webhook receiver rejects everything.
   */
  REZEIS_WEBHOOK_SECRET: optionalString,
  /**
   * Internal address of reiwa-bot's listener, used by reiwa-api to relay
   * received webhooks (cache-bust / notify) to the bot process. Always a
   * private same-VPS docker hop — never public. Defaults to the docker
   * service name; override only for non-standard local topologies.
   */
  REIWA_BOT_INTERNAL_URL: z
    .string()
    .trim()
    .min(1)
    .default('http://reiwa-bot:5100'),
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

  const cfg = parsed.data;

  // Derive REDIS_URL from the discrete REDIS_* parts when an explicit URL
  // wasn't supplied. The deploy `.env` ships REDIS_HOST/PORT/PASSWORD/NAME
  // (not a single URL), and the whole edge layer — sessions + rate limiter +
  // brute-force tracking — keys off `REDIS_URL`. Without this the API boots
  // with no Redis and every credentialed route (register/login/recover) 503s.
  if (!cfg.REDIS_URL && cfg.REDIS_HOST) {
    const auth = cfg.REDIS_PASSWORD
      ? `:${encodeURIComponent(cfg.REDIS_PASSWORD)}@`
      : '';
    return {
      ...cfg,
      REDIS_URL: `redis://${auth}${cfg.REDIS_HOST}:${cfg.REDIS_PORT}/${cfg.REDIS_NAME}`,
    };
  }

  return cfg;
}
