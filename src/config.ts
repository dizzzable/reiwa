import { z } from "zod";

/**
 * reiwa runtime configuration.
 *
 * The canonical names of all variables match `reiwa/.env.example`, which
 * mirrors the donor altshop → remnawave wiring:
 *   • `REZEIS_HOST` is either the docker service name (`rezeis-admin`) or
 *     a public domain.
 *   • `REZEIS_PORT` is only used when `REZEIS_HOST` resolves to a docker
 *     service — in that case the URL is built as `http://${HOST}:${PORT}`.
 *     When `REZEIS_HOST` is a domain, the URL is `https://${HOST}` and
 *     `REZEIS_PORT` is ignored.
 *   • `REZEIS_TOKEN` is the Bearer JWT issued by rezeis-admin
 *     "Settings → API tokens → Create" (see `ApiTokensService`).
 *   • `REZEIS_CADDY_TOKEN` / `REZEIS_COOKIE` are reserved for the case
 *     where rezeis-admin sits behind Caddy basic-auth — same purpose as
 *     altshop's REMNAWAVE_CADDY_TOKEN / REMNAWAVE_COOKIE.
 *
 * The schema is intentionally permissive: every `REZEIS_*` field is
 * optional so a reiwa process can boot in degraded mode (without a
 * functional AdminClient) for local dev and smoke tests.
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
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8100),
  REDIS_URL: z.string().trim().min(1).optional(),

  // ── Connection to rezeis-admin (canonical names from .env.example) ──────
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
   * Telegram bot username (with or without a leading `@`) used to build deep
   * links back to the bot/Mini App when redirecting customers from a payment
   * provider.
   *
   * The Mini App short name itself stays in BotFather — we don't need it
   * here because the `?start=...` deep link opens the bot chat, which
   * (via the configured menu button or an inline button) re-opens the
   * Mini App automatically.
   *
   * Accepts either `RezeisBot` or `@RezeisBot`; the leading `@` is stripped
   * so callers always work with the bare handle.
   */
  BOT_USERNAME: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@+/, ""))
    .refine(
      (value) => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value),
      "BOT_USERNAME must be a valid Telegram username (5–32 chars, letters/digits/underscores, must start with a letter)",
    )
    .optional(),
  REIWA_PUBLIC_WEB_URL: optionalUrl,
  REIWA_COOKIE_SECRET: z.string().trim().min(1).optional(),
  REIWA_COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  REIWA_CORS_ORIGIN: z.string().trim().optional(),
});

export type ReiwaConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReiwaConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues
      .map((issue) => issue.path.join(".") || "environment")
      .join(", ");
    throw new Error(`Invalid Reiwa environment configuration: ${names}`);
  }
  return parsed.data;
}

/**
 * Returns the fully-qualified base URL for the rezeis-admin upstream, or
 * `null` when the host is not configured (degraded mode).
 *
 * Resolution rules mirror altshop's REMNAWAVE_HOST handling:
 *  - When `REZEIS_HOST` looks like a docker service name (no dots, e.g.
 *    `rezeis-admin`, `rezeis-e2e-admin`, `admin`), the URL is built as
 *    `http://${HOST}:${PORT}`. Plain HTTP is fine because traffic stays
 *    inside the compose network.
 *  - Otherwise (host contains a dot — treated as a public domain), the
 *    URL is `https://${HOST}` and the port is ignored — domains are
 *    expected to terminate TLS at the standard 443.
 */
export function resolveRezeisAdminUrl(config: ReiwaConfig): string | null {
  const host = config.REZEIS_HOST?.trim();
  if (!host) return null;
  // Docker service names never contain a dot. This heuristic supports
  // both the canonical compose name (`rezeis-admin`) AND alternative
  // naming patterns (`rezeis-e2e-admin`, `admin`, custom topologies).
  const looksLikeDockerService = !host.includes('.');
  if (looksLikeDockerService) {
    return `http://${host}:${config.REZEIS_PORT}`;
  }
  return `https://${host}`;
}
