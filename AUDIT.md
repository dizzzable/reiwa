# Reiwa — полный аудит проекта

Дата: 2026-05-28

## 1. Executive summary

Reiwa — TypeScript/Node проект из двух частей:

- backend/API/bot/worker в корне проекта;
- React/Vite PWA в `web/`.

Общая картина: архитектура уже довольно зрелая для BFF/edge-сервиса: есть Redis-сессии, rate limiting, CSRF/Origin-защита, request-id, pino-логирование, AdminClient с HMAC-подписью, typed config, отдельные bot/API/web слои и заметный набор тестов. При этом проект сейчас нельзя считать production-ready из-за сломанного `npm test`, слабого CI, проблем в тестовом harness, умеренной npm-уязвимости `qs`, спорной модели password hashing и нескольких deployment/security gaps.

Ключевой вывод (обновлено 2026-05-29): **сборка проходит, typecheck проходит, web build проходит, property-based tests проходят, и основной unit test suite теперь зелёный (25 файлов / 221 тест)**. P0 «npm test красный» закрыт — см. раздел 5.

## 2. Проверенный scope

Проверены:

- структура проекта и документация;
- git-состояние;
- зависимости и npm audit;
- TypeScript build/typecheck;
- unit tests и property-based tests;
- backend Express app, auth/session/security middleware;
- Telegram bot pages;
- web React/Vite app, PWA/service worker;
- Docker/Docker Compose/nginx;
- GitHub Actions CI/CD;
- общие code smells: TODO/FIXME, any, console, localStorage/sessionStorage, eval/innerHTML, secret/token/password patterns.

Не проверялось:

- реальные значения `.env` и секреты — намеренно не читал, чтобы не раскрывать чувствительные данные;
- интеграция с живым `rezeis-admin`, Telegram и Redis в runtime;
- браузерный e2e-прогон UI;
- docker build в полном объёме.

## 3. Команды аудита и результаты

### Backend/root

```bash
npm ci
npm run check
npm run build
npm test
npm run test:pbt
npm audit
```

Результаты:

- `npm ci` — успешно.
- `npm run check` — успешно.
- `npm run build` — успешно.
- `npm run test:pbt` — успешно: 18/18 tests pass.
- `npm test` — падает: 2 failed test files, 2 failed tests; также есть подозрительный вывод TAP/node:test внутри Vitest.
- `npm audit` — 1 moderate vulnerability: `qs` DoS advisory `GHSA-q8mj-m7cp-5q26`.

### Web

```bash
cd web
npm ci
npm run typecheck
npm run build
npm audit
```

Результаты:

- `npm ci` — успешно.
- `npm run typecheck` — успешно.
- `npm run build` — успешно.
- `npm audit` — 1 moderate vulnerability: `qs` DoS advisory `GHSA-q8mj-m7cp-5q26`.

## 4. Project health snapshot

- Git: repository initialized, **no commits yet**.
- Tracked working tree after audit: clean.
- Source size:
  - `src/`: 123 TS files, ~9,428 lines.
  - `test/`: 37 TS files, ~6,481 lines.
  - `web/src/`: 98 TS/TSX files, ~10,750 lines.
  - Total TS/TSX scanned: ~26,659 lines.
- Installed deps size after audit:
  - root `node_modules`: ~92 MB.
  - `web/node_modules`: ~252 MB.
  - project without deps/git: ~2.7 MB.

## 5. Critical / high priority findings

### P0 — `npm test` is red — ✅ RESOLVED (2026-05-29)

`npm test` (vitest) is now green: **25 test files / 221 tests pass**, tsc clean.

Root cause (now fixed): the bot was rewritten to the STEALTHNET single-screen
contract (`editOrReply` → `ctx.editMessageText`, help pages render
`support.title`/`support.not_configured`, banners ride a photo with caption +
keyboard), but a batch of specs still asserted the pre-rewrite contract.

What was done:

- Deleted 7 orphaned bot-page specs for modules pruned in v0.5.0
  (`activity`, `buy`, `plans`, `profile`, `promo`, `referral`, `subscription`).
- Rewrote 4 stale-assertion specs against the new contract
  (`rules`, `invite`, `help-callback`, `help-command`) and extended
  `test/bot/pages/helpers.ts` `buildFakeCtx` with the edit/callback mocks.
- Fixed `start.test.ts` banner spec: production correctly calls
  `replyWithPhoto(url, { caption, reply_markup })`; the spec asserted a
  single-arg call. Now uses `objectContaining` for the options bag.
- Added the (non-optional) `rezeisAdminUrl` field to `buildDeps` urls so the
  fixture matches the `BotUrls` contract.

Original failures (for history):

1. `test/bot/pages/help-callback.test.ts` — stale text-body assertion vs the
   new inline support URL button. Spec rewritten.
2. `test/bot/pages/promo.test.ts` — `next is not a function`; the promo page
   was pruned, the orphaned spec was deleted.

### P0 — CI is incomplete — ✅ RESOLVED (2026-05-29)

`.github/workflows/ci.yml` was rewritten into two jobs:

- **backend**: `npm ci` → `npm run check` → `npm run build` → `npm test` →
  `npm run test:pbt` (lockfile-cached on `package-lock.json`).
- **web**: `npm ci` → `npm run typecheck` → `npm run build`
  (`working-directory: web`, lockfile-cached on `web/package-lock.json`).

All wired steps were verified locally green before commit (backend: 221 unit +
18 PBT; web: tsc -b + vite build).

> Note: neither reiwa backend nor web has an eslint config, so there is no lint
> step (matches the documented pre-push gate). `npm audit` / dependency scanning
> is still open (tracked under the `qs` P1 below).

Original gap (history): the single `build` job only ran
`npm ci` / `npm run check` / `npm run build` and ignored tests + the entire web
package.

### P0 → reclassified P2 — Client-side SHA-256 prehash (NOT raw storage) — ⚠️ CLARIFIED (2026-05-29)

**The original P0 framing was inaccurate.** A code trace of the full chain
shows the at-rest verifier is **not** raw SHA-256:

- web: `passwordHash = SHA-256(password)` (`web/src/lib/crypto.ts`)
- reiwa BFF forwards it to rezeis as the `password` field
  (`src/infrastructure/admin-client/namespaces/web-auth.ts`)
- rezeis `WebAuthService` runs it through `PasswordHashService` →
  **`scrypt(input, randomBytes(16) salt, keylen=64)`**, stored as
  `scrypt$salt$hash`
  (`rezeis-admin/src/modules/auth/services/password-hash.service.ts`).

So at rest the stored value is `scrypt(SHA-256(password))` **with a per-user
salt** — a DB leak does not expose raw SHA-256 and is not directly
rainbow-table-able. The original recommendation ("do not store/compare raw
SHA-256 as the final verifier") is **already satisfied**.

Residual (genuine, but P2 / defense-in-depth): the client SHA-256 digest is a
*replayable* credential in transit — an attacker who captures the TLS-decrypted
payload could replay it without knowing the plaintext. This is bounded by:

- TLS on the public hop + JWT-authenticated internal hop on a closed
  docker network;
- log redaction on both sides — reiwa now redacts `passwordHash`/
  `currentPasswordHash`/`newPasswordHash` (this session), and rezeis'
  `RequestLoggerMiddleware` logs only metadata, never bodies (verified).

Not changed (deliberately): the client prehash format is the `plainTextPassword`
input to the server scrypt KDF. Changing it (e.g. removing the prehash or
salting it) is a **breaking change for every existing stored account** and would
require a password-migration/rehash-on-next-login path. Out of scope for a
hardening pass; tracked as a future migration if the replay surface is deemed
unacceptable.

### P1 — Moderate npm vulnerability `qs` — ✅ RESOLVED (2026-05-29)

Both root and web previously reported the `qs` DoS advisory
`GHSA-q8mj-m7cp-5q26`. `qs` is transitive via `express@5` → `body-parser`.
Ran `npm audit fix` in both root and `web/`: bumped `qs` 6.15.1 → 6.15.2
(non-breaking patch). Both `npm audit` reports now show **0 vulnerabilities**.
Verified post-fix: root tsc + 221 tests + web tsc + build all green; lockfile
diffs are limited to the `qs` version bump.

### P1 — API rate limiter is global and may break SSE/realtime — ✅ RESOLVED (2026-05-29)

The global `apiLimiter` (120 req/min) now skips the SSE endpoint via a
`skip` predicate (`req.originalUrl.startsWith('/api/v1/realtime/stream')`),
so `EventSource` auto-reconnects no longer burn a user's request budget and
lock them out of their own stream. Long-lived stream timeouts are handled by
the upstream proxy + nginx `proxy_read_timeout`. See
`src/api/middleware/rate-limit.ts`.

### P1 — Production cookie security can silently degrade — ✅ RESOLVED (2026-05-29)

`resolveSecureCookieOptions` previously "retried" reading a **static** boolean
(`config.cookieSecure`) in a 3×500ms loop — dead code that could never flip —
then fell through to issuing non-`Secure` cookies in production with only a
warning.

Rewritten to a synchronous, **fail-closed** decision evaluated once at
middleware construction (`src/infrastructure/redis/session.ts`):

- non-prod → honour `cookieSecure` as-is;
- prod + `cookieSecure=true` → `Secure` cookies;
- prod + `cookieSecure=false` + `REIWA_ALLOW_INSECURE_COOKIES=true` →
  non-`Secure` cookies + loud warning (escape hatch for trusted internal nets);
- prod + `cookieSecure=false` + opt-out unset (**default**) → **throws at
  startup** instead of silently downgrading.

`app.ts` still forces `cookieSecure` on whenever `NODE_ENV=production`, so the
default deploy is always-secure; the new flag + fail-closed guard protect any
caller that constructs the middleware with `cookieSecure:false` in production.
Documented the contract in `.env.example`
(`REIWA_COOKIE_SECURE` / `REIWA_ALLOW_INSECURE_COOKIES`). Also removed a
per-request `await getCookieOptions()` (options now resolved once).

### P1 — Reverse proxy / TLS / deployment topology — ✅ RESOLVED (2026-05-30)

Added Remnawave-style edge reverse-proxy stacks under `deploy/proxies/`
(mirrors <https://docs.rw/docs/install/reverse-proxies/>): `caddy`, `nginx`,
`angie`, `traefik`, plus a dev-only `try-cloudflare`. Each ships a
`docker-compose.yml` + config and joins the external `remnawave-network`,
fronting `reiwa-web:80` (which internally proxies `/api/*` → `reiwa:5000`).

Deviations from the upstream Remnawave guides, by design:

- **443-only, no port 80, no auto-ACME.** Every HTTPS stack binds only `:443`
  and serves a **bring-your-own** certificate. `deploy/proxies/gen-self-signed-cert.sh`
  mints a self-signed RSA-4096/10-year cert in one command; operators can drop
  in a Cloudflare Origin / externally-issued cert instead (always
  `fullchain.pem` + `privkey.key`).
- Kept the stealth default server (TLS reject / `204` on non-matching SNI),
  Mozilla-Intermediate TLS profile, and gzip from the Remnawave configs.
- Added SSE pass-through tuning (`proxy_buffering off`, long read timeout,
  Caddy `flush_interval -1`) so `/api/v1/realtime/stream` survives the extra hop.
- `.gitignore` keeps all key/cert material out of git.

All configs validated: `docker compose config` (10/10), `caddy validate`,
`nginx -t`, `angie -t`. The original `web/nginx.conf` keeps `proxy_pass
http://reiwa:5000` — the internal backend port is now documented as a fixed
contract (compose still maps `${REIWA_PORT:-5000}` on loopback only). The
Telegram-Mini-App framing posture is documented in `deploy/proxies/README.md`
(permissive framing required; trusted cert required for the Mini App).

### P1 — Docker Publish only publishes backend image, not web image — ✅ RESOLVED (2026-05-29)

`.github/workflows/docker-publish.yml` now builds **both** images via a matrix:

- backend → `ghcr.io/<repo>` (context `.`, `./Dockerfile`)
- web → `ghcr.io/<repo>/web` (context `./web`, `./web/Dockerfile`)

GHA build cache is scoped per image (`scope=${{ matrix.name }}`) so the two
builds don't clobber each other's layers. Also dropped the stale hardcoded
`type=raw,value=0.1.0` tag — semver tags (`v*`) already drive versioning and the
project is at v0.6.0.

Original gap (history): the workflow built only the root `Dockerfile`, while
`docker-compose.yml` expects both `reiwa` and `reiwa-web` images.

## 6. Backend/API audit

### Strengths

- Good layered direction: config/core/infrastructure/application/api/bot separation.
- `AdminTransport` has persistent undici Pool, request-id forwarding, bearer auth, optional HMAC request signing.
- Express app has Helmet, CORS, cookie parser, JSON body limit, request-id, pino-http and central error handler.
- Redis-backed session store exists for web sessions and legacy Telegram sessions.
- Rate-limit and brute-force logic are separated and property-tested.
- CSRF origin/referer validation exists for state-changing requests.
- TMA context detection validates Telegram initData HMAC and auth freshness.

### Risks / improvements

#### Error classification by string matching — ✅ RESOLVED (2026-06-07)

`AdminTransport.request()` now throws a typed `UpstreamError` (`method`,
`path`, `status`, `body`; `isRetryable` / `isAuthFailure` helpers) instead of
a plain `Error`. The `Error.message` format is preserved
(`AdminClient: <method> <path> → <status>: <body>`) for logs and back-compat.

Route handlers (`auth`, `linking`, `push`, `support`) now classify failures
via `isUpstreamStatus(e, <code>)` / `describeUpstreamError(e)` from
`src/api/lib/upstream-error.ts`, which prefers the typed `status` and only
falls back to message-text scanning for non-typed errors. `support.ts` also
stopped forwarding upstream error bodies to the browser (returns generic
`internal` / `not_found` instead). Covered by new specs in
`test/infrastructure/admin-client/transport.test.ts` and
`test/api/lib/upstream-error.test.ts`.

Original (history): handlers classified upstream errors via
`err.message.includes("409")` etc., which is fragile — any upstream text
change can alter behavior.

Relevant examples (now refactored):

- `src/api/routes/auth.ts`
- `src/api/routes/linking.ts`

#### `REIWA_COOKIE_SECRET` is accepted but not actually used for signing

Session cookies store a UUID only, which is server-side validated in Redis, so signing is less critical. Still, config contains `cookieSecret`, but middleware does not sign cookies.

Recommendation:

- Either remove/deprecate `REIWA_COOKIE_SECRET`, or use signed cookies consistently.
- Document threat model: opaque random session id + Redis validation is acceptable if entropy is high and cookie is secure/httpOnly/sameSite.

#### CSRF protection permits no Origin/Referer

`createCsrfProtection` allows state-changing requests with neither Origin nor Referer.

This can be acceptable for non-browser clients, but Reiwa is primarily browser/TMA-facing. For cookie-authenticated endpoints, fail-open may be too permissive.

Recommendation:

- For cookie-authenticated browser endpoints, require a valid Origin/Referer or explicit CSRF token.
- If server-to-server clients are needed, separate API namespace/auth model.

#### Mixed legacy and web sessions

The app currently has:

- `reiwa_web_session` via `WebSessionStore`;
- legacy `reiwa_session` via `SessionStore`.

Realtime still uses legacy `SessionStore`:

- `src/api/routes/realtime.ts`

Most web protected routes use `req.webSession`.

Recommendation:

- Complete migration to one session model.
- Make route auth middleware explicit: `requireWebSession`, `requireTelegramSession`, etc.
- Avoid silent split-brain between web and legacy session cookies.

#### Redis connect errors are swallowed — ✅ RESOLVED (2026-06-07)

`SessionStore.connect()` and `WebSessionStore.connect()` no longer swallow
the connection error — they propagate it. `src/api/main.ts` now decides via
`connectStore()`: in production a failed Redis connection **fails closed**
(the process refuses to start) unless `REIWA_ALLOW_DEGRADED=true`;
non-production always boots in degraded mode with a loud warning. Documented
in `.env.example` (`REIWA_ALLOW_DEGRADED`).

Original (history): both `connect()` methods caught and logged Redis
connection errors, then startup continued — so a production API could boot
with sessions / rate-limit / brute-force silently disabled.

## 7. Bot audit

### Strengths

- Bot pages are modular.
- Locale detection/persistence is tested.
- Message builder and keyboard tests are substantial.
- Config cache pattern exists.
- Commands, callback pages, and menu structure are separated.

### Issues

#### Test contract drift in help callback

Implementation uses inline support button for normal Telegram usernames, while test expects text body. Decide product contract and update either implementation or test.

My recommendation: keep inline button UX and update test to assert `reply_markup`, URL, and sanitized username.

#### Promo handler assumes `next` exists

Runtime grammy middleware should provide `next`, but tests do not. Safer implementation:

```ts
if (ctx.session.step !== 'awaiting_promo_code') {
  if (next) return next();
  return;
}
```

Better test fix: fake `bot.on` should store/call `(ctx, next)` and assert `next` is called for non-promo messages.

#### Logging noise in property tests

Property tests produce many “Coordinated brute-force attack detected” logs. This makes signal hard to read.

Recommendation:

- Inject a silent logger in tests.
- Assert logging behavior where needed without printing every generated case.

## 8. Web/PWA audit

### Strengths

- Typecheck and production build pass.
- Route-level lazy loading is used.
- TanStack Query is used for data fetching/caching.
- Central axios transport with `withCredentials` and request-id propagation.
- PWA service worker builds successfully.
- UI is organized by features and shared components.

### Risks / improvements

#### Protected route list has public-looking routes outside protected shell

`/change-password`, `/payment-return`, `/onboarding` are outside `StealthLayout`.

This may be intentional, but `/change-password` likely needs authenticated behavior. Backend checks session on API call, but UI access can be confusing.

Recommendation:

- Decide route auth explicitly:
  - public routes: sign-in/register/recover/payment-return/bootstrap;
  - protected routes: dashboard/settings/change-password/onboarding.
- Consider a separate layout for “authenticated but forced password change”.

#### API responses cached by service worker — ✅ RESOLVED (2026-05-29)

`web/src/sw.ts` previously used `StaleWhileRevalidate` for **all** `/api/v1/*`
GETs, caching for up to 24h — which could serve stale subscription / device /
payment / profile data.

Now the SW caches via a strict **allow-list** of operator-managed, non-personal
config/catalog endpoints only: `/api/v1/branding`, `/public-config`, `/plans`,
`/gateways`, `/faq`, and `/add-ons/plan/*`. It also guards on `request.method
=== 'GET'`. Every account-scoped endpoint (auth, profile, subscription,
payments, activity, promo, referrals, devices, partner, support, linking, push,
realtime) now bypasses the SW cache and always hits the network.

#### `window.location.replace('/bootstrap')` global 401 redirect is blunt — ✅ RESOLVED (2026-05-30)

The axios response interceptor redirected to `/bootstrap` on **any** 401 —
including the expected 401 from the unauthenticated `GET /session` probe. Since
`/bootstrap` (ContextRouter) re-probes `/session`, this created a full-page
**reload loop** that drained the 120/min rate limiter into 429s (observed live
in the browser: `GET /session 429`).

Fixed in `web/src/lib/api-client/transport.ts`:

- Benign 401s are passed through (the caller handles them): `GET /session`
  (probe) and `/auth/*` (login/register/recover/status credential feedback).
- No redirect when the user is already on a public/auth page
  (`/`, `/sign-in`, `/login`, `/register`, `/recover`, `/bootstrap`, `/tma`,
  `/payment-return`) — this is what broke the loop.
- A `redirectingToSignIn` guard prevents repeat fires.
- The destination is now `/sign-in` (not `/bootstrap`, which re-probed and
  re-closed the cycle).

#### Discrete `REDIS_*` env vars were ignored (REDIS_URL-only) — ✅ RESOLVED (2026-05-30)

Live-testing the cabinet surfaced a config bug: the deploy `.env` ships
`REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_NAME` (no single
`REDIS_URL`), but the whole edge layer (sessions + rate limiter + brute-force
tracking) keyed only off `REDIS_URL`. With it unset the API booted with
`webSessionStore: false` and **no Redis**, so the Redis-backed rate limiter on
`register` / `login` / `recover` returned `503 Service temporarily unavailable`
for every attempt (registration looked "disabled" / broken in the UI).

Fixed in `src/core/config/app.config.ts`: added the discrete `REDIS_*` fields to
the schema and `loadConfig` now derives `REDIS_URL` from them when an explicit
URL isn't supplied (`redis://[:pw@]host:port/db`). An explicit `REDIS_URL` still
overrides. Verified live: API boots `webSessionStore: true`, and
register → 200 + cookie, login → 200 + cookie, wrong password → 401, rate
limiter enforces (register 3/h).

#### Many `any` casts in UI data mapping

Several feature pages cast API data to `any`, e.g. activity, referrals, devices, dashboard, partner, settings.

Recommendation:

- Strengthen `web/src/types/api.ts` and API client namespace return types.
- Prefer typed DTOs and adapters per endpoint.

#### Hard-coded globals for bot username/domain

Some pages read:

```ts
(window as any).__REIWA_BOT_USERNAME__
(window as any).__REIWA_DOMAIN__
```

Recommendation:

- Define these in `vite-env.d.ts` or avoid globals by fetching public config from `/api/v1/branding`/bootstrap endpoint.

## 9. Security audit

### Good controls already present

- Helmet enabled.
- `x-powered-by` disabled.
- Request body size limited to 1 MB.
- httpOnly, SameSite=Lax session cookies.
- Redis-backed session IDs.
- Origin/Referer CSRF middleware.
- Rate limiting and brute-force detection.
- Telegram initData signature validation and 1h freshness check.
- AdminClient supports HMAC request signing.
- Logger redacts common token/password/secret paths.

### Security gaps

1. Client-side SHA-256 is a **prehash**, not the at-rest verifier — rezeis
   applies server-side scrypt + per-user salt. Replay-in-transit is the only
   residual (P2), bounded by TLS + log redaction. See clarified P0→P2 item above.
2. Production secure-cookie behavior now fails closed (no silent degrade) —
   ✅ RESOLVED (2026-05-29).
3. CSRF allows no Origin/Referer for state-changing requests.
4. Logger redaction now explicitly includes `passwordHash`, `currentPasswordHash`, `newPasswordHash` (top-level, `*.`, and `req.body.*`) — ✅ RESOLVED (2026-05-29), see `src/infrastructure/logger/logger.ts`.
5. Service worker now caches only an allow-list of public config/catalog
   endpoints (branding/public-config/plans/gateways/faq/add-ons), never
   account-scoped `/api/v1/*` data — ✅ RESOLVED (2026-05-29).
6. nginx has `X-Frame-Options "ALLOWALL"`, which is non-standard/weak. For Telegram Mini App embedding this may be deliberate, but should be replaced with an explicit CSP `frame-ancestors` policy if possible.
7. No visible CSP in nginx/Helmet config beyond Helmet defaults. Need confirm whether Telegram WebApp and PWA assets require custom CSP.
8. Redis password in compose is required, but Redis is bound to `0.0.0.0` inside Docker network. Acceptable if network is private; document that external network membership is trusted.

## 10. Docker/deployment audit

### Strengths

- Multi-stage Dockerfiles.
- Root production image copies only dist/assets/package files/node_modules.
- Compose binds public ports to `127.0.0.1`, reducing exposure.
- Redis data volume is named and persistent.
- Dev compose avoids host `node_modules` shadowing with anonymous volumes.

### Issues

1. ✅ RESOLVED (2026-05-29) — Root Dockerfile now uses `npm ci` (was
   `npm install`) for reproducible builds.
2. ✅ RESOLVED (2026-05-29) — Runtime image no longer ships dev dependencies:
   a dedicated `prod-deps` stage runs `npm ci --omit=dev` and the `runtime`
   stage copies *those* `node_modules`, not the build stage's full tree.
3. Web Dockerfile correctly uses `npm ci`, but nginx config hardcodes API port.
   **Still open** — see P1 nginx item; left as-is to avoid breaking TMA embedding
   without live testing.
4. ✅ RESOLVED (2026-05-29) — Docker publish workflow now publishes both backend
   and web images (matrix). See P1 item above.
5. Compose requires external `remnawave-network`; README does not fully document
   prerequisite creation/ownership. **Still open** (docs).
6. ✅ RESOLVED (2026-05-29) — Added container healthchecks for both `reiwa`
   (node `fetch` against `/api/v1/health`) and `reiwa-web` (busybox `wget`
   against `/`); `reiwa-web` now waits on `reiwa: service_healthy`.

Remaining recommendations:

- Resolve nginx hardcoded port or document internal fixed port.
- Document external network prerequisite and reverse proxy/TLS/CSP/frame policy.
- Pin image versions for `node` and `nginx` if reproducibility matters.

## 11. CI/CD audit

Recommended target CI:

```yaml
jobs:
  backend:
    steps:
      - npm ci
      - npm run check
      - npm run build
      - npm test
      - npm run test:pbt

  web:
    defaults:
      run:
        working-directory: web
    steps:
      - npm ci
      - npm run typecheck
      - npm run build

  docker:
    steps:
      - docker build -t reiwa-api .
      - docker build -t reiwa-web ./web
```

Add dependency scanning after the `qs` fix.

## 12. Maintainability audit

### Strengths

- Domain-ish folder structure is understandable.
- `README.md` gives purpose/safety rules.
- Many files have useful contextual comments.
- Ports/interfaces exist in `src/application/ports`.
- Tests cover important logic and bot pages.

### Weaknesses

1. No root `AGENTS.md` guidance for future agents/developers.
2. ✅ RESOLVED (2026-06-07) — README refreshed to the current state
   (API/bot/worker/web architecture, typed upstream errors, fail-closed
   Redis/cookies, config contracts, deployment) instead of the stale
   "scaffold avoids business endpoints" wording.
3. No dedicated architecture doc for session models and auth flows.
4. Legacy shims (`src/config.ts`, legacy auth/bootstrap/sign-out routes) need an explicit removal plan.
5. NodeNext import style is mostly okay because typecheck passes, but there are many files without explicit `.js` imports because they may only contain types/constants or web alias imports. No current breakage.

Recommendations:

- Update README to current state.
- Add `docs/auth-session-model.md` or equivalent.
- Add `docs/deployment.md` with external network, env vars, reverse proxy, Telegram webhook/long polling modes.
- Add `AGENTS.md` with project conventions if this repo will be maintained through Zo/agents.

## 13. Prioritized remediation plan

### Phase 1 — Make the project trustworthy again

1. Fix test harness mismatch.
2. Make `npm test` green.
3. Add root/web checks to CI.
4. Commit a baseline once green.

### Phase 2 — Security hardening

1. Replace/rework client-side SHA-256 password credential model.
2. Tighten production cookie security behavior.
3. Adjust CSRF policy for cookie-auth endpoints.
4. Stop service-worker caching sensitive API endpoints.
5. Expand logger redaction for `passwordHash` fields.
6. Fix `qs` vulnerability in both lockfiles.

### Phase 3 — Deployment correctness

1. Update Dockerfile to use `npm ci` and production-only runtime deps.
2. Add healthchecks.
3. Publish/build both backend and web images.
4. Resolve nginx hardcoded port or document internal fixed port.
5. Document reverse proxy/TLS/CSP/frame policy.

### Phase 4 — Architecture cleanup

1. Unify web vs legacy session model or document boundaries.
2. Replace string-based upstream error parsing with typed errors.
3. Type frontend API DTOs and remove high-value `any` casts.
4. Refresh README and add developer docs.

## 14. Top recommended next action

Do this first:

1. Fix `vitest.config.ts` / test runner split.
2. Update the two bot tests or implementations.
3. Add web build/typecheck and tests to CI.

Until `npm test` is green and CI covers web, every other change is harder to trust.


---

## 15. Code-first review pass (2026-06-07)

An independent, source-first review (not driven by the section-5 list) of
`src/` surfaced and resolved the following. All changes verified green:
backend `tsc` + 229 unit tests + 18 PBT.

### P0 — Upstream error bodies + internal API paths leaked to the browser — ✅ RESOLVED

`UpstreamError.message` embeds the raw upstream response body and the
internal `/api/internal/...` path. ~10 route handlers forwarded
`(e as Error).message` verbatim to the client via
`res.status(...).json({ message: (e as Error).message })`, leaking provider
diagnostics and the internal API surface — directly against the project's
safety rules. (Note: wiring the typed `UpstreamError` into the transport made
this leak fully consistent across routes, so it had to be closed everywhere.)

Fix: new `src/api/lib/error-response.ts` `sendSafeError(req, res, e, status,
message, context)` — logs the full detail server-side, returns a generic
client-safe message, preserves each route's status contract. Applied to
`payments`, `subscription`, `profile` (7 handlers), `devices` (3),
`partner` (2), `referrals` (3), `plans` (2), `promo`, `content`. Pinned by
`test/api/lib/error-response.test.ts` (asserts the body / internal path /
provider text never reach the response).

### P1 — `.env.example` documented a dead `REZEIS_WEBHOOK_SECRET` — ✅ RESOLVED

The HMAC shared secret the code actually reads is
`REZEIS_INTERNAL_SHARED_SECRET` (api/bot/worker + internal listener), but
`.env.example` shipped `REZEIS_WEBHOOK_SECRET=` (read nowhere). An operator
copying the example would leave HMAC signing + the bot invalidate listener
silently disabled. `.env.example` now documents `REZEIS_INTERNAL_SHARED_SECRET`
(with the ≥32-char requirement and the "set the same value on rezeis-admin"
note).

### P1 — `adminClient`-null returned 200 + empty body on state-changing routes — ✅ RESOLVED (checkout, trial)

`payments/checkout` and `subscription/trial` used `adminClient?.…` then
`res.json(result ?? {})`, so in degraded mode (no admin client) a payment the
user could never initiate returned a success-shaped `200 {}`. Both now return
an explicit `503` when `adminClient` is null.

### P1 — `REIWA_HOST` documented but ignored — ✅ RESOLVED

`api/main.ts` hardcoded `listen(port, "0.0.0.0")`, so the documented
`REIWA_HOST` was a no-op. Added `REIWA_HOST` to the config schema (default
`0.0.0.0`) and `main.ts` now honours it. Removed the dead `REIWA_LOCALES` /
`REIWA_DEFAULT_LOCALE` from `.env.example` (reiwa hardcodes `DEFAULT_LOCALE`;
SPA locale defaults come from the rezeis-admin bootstrap, not reiwa env).

### P2 — Internal path-segment injection — ✅ RESOLVED

`namespaces/payments.ts` interpolated `paymentId` / `gatewayType` (straight
from `req.params`) into the upstream path without `encodeURIComponent`, while
every other namespace encoded its segments. Both are now encoded; a sweep of
all namespaces confirmed the rest were already safe.

### P2 — `auth/register` session creation not isolated — ✅ RESOLVED

Session creation after a successful `register` ran inside the outer try, so a
session-store failure was misclassified by the upstream-status catch (possible
spurious 409). Now isolated in its own try/catch (mirrors `auth/login`),
returning a clear "account created but session setup failed" 500.

### P2 — Telegram initData HMAC compared with `!==` — ✅ RESOLVED

`validateTelegramInitData` now uses `crypto.timingSafeEqual` (with a length
guard) instead of a timing-variable string compare on the HMAC digest.

### Still open (tracked, not yet changed)

- **Rate limiter is non-atomic (TOCTOU)** — `rate-limit.ts` does
  `get` → compute → `incr`; concurrent requests can all pass under the
  threshold. Should `INCR`-first (atomic) or use a Lua script. The function
  docstring also still says "fail-open" while the code fails closed (503 on
  Redis-down) — inconsistent with brute-force detection, which fails open.
- **Coordinated brute-force threshold = 3 distinct IPs/username/hour** —
  bans the observed IPs; NAT/CGNAT false-positive availability risk. Consider
  raising the threshold and excluding shared ranges.
- **CSRF is effectively advisory** — derives "self origin" from the `Host`
  header and allows requests with neither Origin nor Referer. Defensible as
  defense-in-depth behind SameSite=lax, but should be documented as such
  (the explicit reject branches imply stronger protection than exists).
- **`parseTelegramInitData`** (no signature verification) coexists with the
  validated parser — confirm it's only used for non-trust display.
- Session-model unification (`reiwa_web_session` vs legacy `reiwa_session`),
  frontend `any` casts and `__REIWA_*__` globals — unchanged.

### Confirmed NOT bugs (verified against source)

- `realtime-proxy.ts` only branches on `upstream === null`, but
  `transport.openStream` returns `null` for any `statusCode >= 400` (after
  draining), so 4xx/5xx upstream bodies never reach the SSE pipe.
- Realtime stream derives `userRef` from server-side identity — no cross-user
  streaming.
- Production secure-cookie logic fails closed correctly.
