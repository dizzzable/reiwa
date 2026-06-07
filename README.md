# Reiwa

Reiwa is the user-facing edge service for Rezeis. It replaces the legacy
Python `ruid` layer and owns the Telegram bot, the public user API, and the
React/Vite PWA (the "cabinet"). All business truth lives in `rezeis-admin`;
reiwa is a BFF/edge layer that talks to it over a private network.

## Architecture

Reiwa is a single TypeScript codebase that builds three runtime entrypoints
plus a front-end:

- **API** (`src/api`) — Express BFF. Sessions, auth, rate limiting,
  CSRF/Origin protection, request-id tracing, and the `/api/v1/*` surface the
  cabinet consumes. In single-image mode it also serves the built SPA.
- **Bot** (`src/bot`) — grammy Telegram bot. Single-screen contract
  (edit-in-place), locale detection, operator-managed config cache, banners.
- **Worker** (`src/worker`) — background runtime for future scheduled work.
- **Web** (`web/`) — React 19 + Vite PWA. TanStack Query data layer, service
  worker, route-level lazy loading.

Supporting layers:

- `src/infrastructure/admin-client` — `AdminTransport` (persistent undici
  pool, bearer + optional HMAC signing, request-id forwarding) and a
  namespace facade over the rezeis-admin internal API. Non-2xx responses
  throw a typed [`UpstreamError`](src/core/errors/upstream-error.ts) carrying
  `status` / `body`, so route handlers classify failures by status code
  rather than string-matching messages.
- `src/infrastructure/redis` — Redis-backed web sessions.
- `src/infrastructure/i18n` — translator + locale packs (ru/en).
- `src/core` — config (zod-validated), errors, enums, version.

## Runtime scripts

- `npm run dev:api` / `dev:bot` / `dev:worker` — tsx watch entrypoints.
- `npm run start:api` / `start:bot` / `start:worker` — run the built `dist/*`.
- `npm run build` — `tsc` build to `dist/`.
- `npm run check` — TypeScript no-emit validation.
- `npm test` — vitest unit suite.
- `npm run test:pbt` — property-based tests (node:test + fast-check).

Front-end (`cd web`): `npm run dev`, `npm run build`, `npm run typecheck`.

## Configuration

All config is environment-driven and validated once at startup by
[`app.config.ts`](src/core/config/app.config.ts) (zod). Copy `.env.example`
to `.env` and fill the `change_me` values. Notable contracts:

- `REDIS_URL` is derived from the discrete `REDIS_HOST/PORT/PASSWORD/NAME`
  when not set explicitly. Redis backs sessions, rate limiting and
  brute-force detection.
- In production the API **fails closed** when Redis is unreachable or when
  secure session cookies can't be guaranteed. Override only with intent via
  `REIWA_ALLOW_DEGRADED=true` / `REIWA_ALLOW_INSECURE_COOKIES=true`.
- `REIWA_DOMAIN` drives CORS/CSRF allow-list and the bot's public links.

## Safety rules

- Never expose raw Remnawave UUIDs, provider URLs, tokens, profile links,
  device identifiers, Telegram delivery identifiers, or payment provider
  diagnostics to the browser. Use stable safe labels and opaque public ids.
- Provider/admin calls stay server-side. Route handlers return generic
  messages; upstream error bodies are logged, never forwarded to clients.
- Admin/operator truth remains in `rezeis-admin`.

## Deployment

Multi-stage Dockerfiles build both the API (which serves the SPA in
single-image mode) and a standalone `web` nginx image. `deploy/proxies/`
ships Remnawave-style edge reverse-proxy stacks (caddy / nginx / angie /
traefik) that front the cabinet over 443 with a bring-your-own certificate.
See `deploy/proxies/README.md` for the TLS / framing posture.

## Donor sources

The architecture is informed by a live-code audit of `altshop-1.5.0`
(Rezeis business logic), `backend-main` (production patterns / Remnawave
integration discipline) and `remnawave-STEALTHNET-Bot-4.0.0` (user-facing
bot/API/SPA). Reiwa is **not** a copy of Remnawave Panel — it is a
Rezeis-owned user-facing service with Remnawave integration behind
admin-owned seams.
