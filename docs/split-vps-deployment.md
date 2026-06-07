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
                                       # → reiwa picks https://, ignores port)
REZEIS_TOKEN=<api token issued in the panel>
REZEIS_WEBHOOK_SECRET=<64-hex>         # MUST match admin's WEBHOOK_SECRET_HEADER
REZEIS_INTERNAL_SHARED_SECRET=<32+>    # internal-only: signs reiwa→admin REST/SSE
                                       # and the reiwa-api→reiwa-bot relay (same VPS).
                                       # Does NOT need to match anything on admin.
```

Everything else (Redis, cookies, etc.) is the same as same-VPS.

### VPS-B: admin `.env`

```dotenv
REZEIS_DOMAIN=panel.example.com        # public, what operators open
REIWA_URL=https://app.example.com      # where to deliver webhooks
WEBHOOK_SECRET_HEADER=<64-hex>         # MUST match REZEIS_WEBHOOK_SECRET above
```

The two secrets are **different** by design:

| variable | role | scope |
|---|---|---|
| `WEBHOOK_SECRET_HEADER` ↔ `REZEIS_WEBHOOK_SECRET` | sign/verify admin → reiwa webhooks | crosses the public internet |
| `REZEIS_INTERNAL_SHARED_SECRET` | sign internal reiwa-api → reiwa-bot relay + reiwa→admin REST/SSE | reiwa-only |
| `REZEIS_TOKEN` | Bearer auth for reiwa → admin API pulls (issued in the panel) | reiwa-only |

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
