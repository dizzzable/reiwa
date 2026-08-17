# Split-VPS deployment

Run **rezeis-admin** and **reiwa** on separate hosts and have them talk
over the public internet. This document is the operator-facing checklist
for that topology; it does NOT describe the same-VPS / shared-docker-
network setup, which is the default.

## Topology

```
┌─────────────── VPS-B (rezeis-admin) ────────────────┐
│  rezeis-admin + db + redis + reverse proxy :443     │
│  panel.example.com  (admin UI for operators)        │
└──────────────────────────────────────────────────────┘
           │  HTTPS, signed                  ▲
           │  POST /api/v1/webhooks/rezeis   │ HTTPS, Bearer REZEIS_TOKEN
           ▼                                  │ (reiwa pulls business data)
┌─────────────── VPS-A (reiwa) ────────────────────────┐
│  reiwa + reiwa-bot + redis + reverse proxy :443     │
│  app.example.com    (cabinet for users)             │
└──────────────────────────────────────────────────────┘
```

Two cross-internet hops, both on `:443` with TLS:

1. **reiwa → admin (PULL).** reiwa-api/bot/worker fetch business data from
   the admin internal API (`/api/internal/...`).
2. **admin → reiwa (PUSH webhooks).** admin delivers operator events
   (bot-config changed, per-user notifications, broadcasts) to reiwa.
   reiwa-api verifies the signature and relays the action to reiwa-bot
   over the private docker hop. **The bot is never exposed publicly.**

## Reverse proxy

Each VPS gets its own reverse proxy stack (Caddy / nginx / Angie /
Traefik) — the operator picks one. Configs ship in:

- `reiwa/deploy/proxies/` — fronts `reiwa:5000` (cabinet + `/api/*`).
- `rezeis/rezeis-admin/deploy/proxies/` — fronts `rezeis:8000` (admin).

Both are `:443`-only, bring-your-own certificate; details and a
self-signed helper are in each stack's local README. No bot-specific
subdomain is needed.

## Environment

### VPS-A: reiwa `.env`

```dotenv
REIWA_DOMAIN=app.example.com           # public, what users open
REZEIS_HOST=panel.example.com          # admin's public host (with a dot
                                       # → reiwa picks https://, ignores port).
                                       # NOT the docker service name `rezeis` —
                                       # that resolves to nothing on this host.
REZEIS_TOKEN=<api token issued in the panel: Settings → API tokens>
REZEIS_WEBHOOK_SECRET=<64-hex>         # MUST match admin's WEBHOOK_SECRET_HEADER
REZEIS_INTERNAL_SHARED_SECRET=<32+>    # MUST match admin's value of the SAME name
```

Everything else (Redis, cookies, etc.) is the same as same-VPS. In particular
`REIWA_BOT_INTERNAL_URL` (default `http://reiwa-bot:5100`) stays a docker
service name on both topologies — reiwa-api and reiwa-bot are always on the
same host.

### VPS-B: admin `.env`

```dotenv
REZEIS_DOMAIN=panel.example.com        # public, what operators open
REIWA_URL=https://app.example.com      # where to deliver webhooks. NOT the
                                       # default http://reiwa:5000 — that is a
                                       # docker service name and dies here.
WEBHOOK_SECRET_HEADER=<64-hex>         # MUST match REZEIS_WEBHOOK_SECRET above
REZEIS_INTERNAL_SHARED_SECRET=<32+>    # MUST match reiwa's value of the SAME name
REZEIS_INTERNAL_SIGNATURE_MODE=log     # keep `log` until the log is clean; see below
```

Three shared values, and only one of them is a *pair of different names*:

| variable | role | scope |
|---|---|---|
| `WEBHOOK_SECRET_HEADER` ↔ `REZEIS_WEBHOOK_SECRET` | sign/verify admin → reiwa webhooks | **identical on both hosts**; crosses the public internet |
| `REZEIS_INTERNAL_SHARED_SECRET` | reiwa signs reiwa→admin REST/SSE with it and **admin verifies with it**; also signs the internal reiwa-api → reiwa-bot relay | **identical on both hosts**; crosses the public internet |
| `REZEIS_TOKEN` | Bearer auth for reiwa → admin API pulls | issued in the panel (Settings → API tokens), pasted into reiwa only |

> **`REZEIS_INTERNAL_SHARED_SECRET` must be the same string on both hosts.**
> Earlier revisions of this document and of `reiwa/.env.example` said the
> opposite ("reiwa-only", "does not need to match anything on admin"). That was
> wrong. `rezeis-admin` reads the variable in
> `src/common/config/auth.config.ts` and verifies reiwa's `x-request-signature`
> with it in `InternalAdminAuthGuard`.
>
> A mismatch behaves differently in each mode of the admin's
> `REZEIS_INTERNAL_SIGNATURE_MODE`:
>
> | mode | what a mismatch does |
> |---|---|
> | `off` | nothing is verified; the second factor does not run |
> | `log` (**default**) | every request is **allowed**, and admin logs `internal signature ... allowed (mode=log)` for each one. Nothing breaks, so the mismatch is invisible and can survive for months |
> | `require` | **every** reiwa → admin request is rejected with 401. Sign-in, subscriptions, payments, support and the bot all stop at once |
>
> The dangerous sequence is therefore: deploy with mismatched secrets (works
> fine, `log`), harden the panel to `require` weeks later, take the whole
> cabinet down and have no reason to suspect the change. Fix the secrets first;
> only flip the mode once the admin log has no `mode=log` signature lines left.

### Docker service names do not survive the split

Both `.env.example` files ship defaults aimed at the single-host topology,
where every service shares one docker network. On two hosts those names resolve
to nothing, and none of the affected paths fails loudly:

| variable | side | single-host default | split-VPS value |
|---|---|---|---|
| `REZEIS_HOST` | reiwa | `rezeis` | `panel.example.com` |
| `REIWA_URL` | admin | `http://reiwa:5000` | `https://app.example.com` |
| `REZEIS_SUBPAGE_URL` | admin | `http://rezeis-subpage:3010` | `https://<subpage-domain>` |
| `REIWA_BOT_INTERNAL_URL` | reiwa | `http://reiwa-bot:5100` | **unchanged** — same host either way |

Both services now print one warning at boot per unresolvable name, e.g.

```
REIWA_URL points at "reiwa", which does not resolve from this host ...
```

The check only fires when the hostname genuinely fails to resolve, so a correct
single-host install stays silent.

## Sanity checks

After bringing both stacks up:

1. **Pull works.** Open the cabinet at `https://app.example.com`, sign
   in. The session GET hits admin via the Bearer token; if `REZEIS_TOKEN`
   or `REZEIS_HOST` is wrong you'll see 401/503 in the cabinet.
2. **Push works.** In the admin panel, edit any bot button → Save. reiwa
   logs should show within a second:
   ```
   BotConfigCache: forced invalidate { reason: 'admin-pushed', … }
   ```
   If you see nothing, check admin logs for the `Bot notify …` warning;
   the most common cause is `WEBHOOK_SECRET_HEADER` ≠ `REZEIS_WEBHOOK_SECRET`,
   or `REIWA_URL` pointing at the wrong host.
3. **Telegram delivery works.** Trigger anything that produces a user
   notification (e.g. activate a promo). The user should receive a
   Telegram DM from the bot within seconds.
4. **The shared secret actually matches.** Do this even though everything
   above already works — in the default `log` mode a wrong secret changes
   nothing you can see. In the admin log, search for:
   ```
   internal signature
   ```
   Any hit means `REZEIS_INTERNAL_SHARED_SECRET` differs between the two hosts
   (or a caller is not signing at all). Fix it now: it costs nothing today and
   costs the whole cabinet the day someone sets
   `REZEIS_INTERNAL_SIGNATURE_MODE=require`.
5. **No boot warnings about docker service names.** Both stacks print a
   warning at startup if a cross-host URL still points at a name this host
   cannot resolve. Check the first seconds of `docker compose logs` on each
   VPS for `REZEIS_HOST`, `REIWA_URL` and `REZEIS_SUBPAGE_URL`.

## Hardening (optional)

- **IP-allowlist** the admin VPS source IP at the reiwa reverse proxy
  for `POST /api/v1/webhooks/rezeis`. The signature already protects
  authenticity; allowlist is a defence-in-depth.
- **Rotate** `WEBHOOK_SECRET_HEADER` periodically. Update both `.env`
  files, restart admin first, then reiwa, with a brief overlap (deliveries
  during the gap will fail and be retried by the dispatcher).
- Run reiwa and admin on **different domains/subdomains** (this guide
  uses `app.example.com` and `panel.example.com`); do not co-locate them
  on the same hostname with a path prefix.
