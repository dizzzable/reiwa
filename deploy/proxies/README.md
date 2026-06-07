# Reverse proxies for the reiwa user app

These stacks put a TLS-terminating reverse proxy in front of the reiwa
user-facing surface (the Web / Telegram Mini App SPA), following the same
patterns the Remnawave panel uses
(<https://docs.rw/docs/install/reverse-proxies/>).

## 443-only, bring-your-own certificate

All HTTPS stacks here bind **only `:443`** — no port 80, no automatic
ACME. You supply the TLS certificate yourself. This keeps the public
surface to a single port and works on boxes where 80 is taken or blocked.

Generate a self-signed cert (10-year, RSA-4096) with the helper:

```bash
cd deploy/proxies
./gen-self-signed-cert.sh app.example.com <stack-dir-or-certs-dir>
```

Where the cert files go per stack (always `fullchain.pem` + `privkey.key`):

| Stack    | Cert location           |
| -------- | ----------------------- |
| caddy    | `caddy/certs/`          |
| nginx    | `nginx/`                |
| angie    | `angie/`                |
| traefik  | `traefik/certs/`        |

You can also drop in a **real** certificate instead of self-signed — a
Cloudflare Origin cert, or one you issued out-of-band. Just name the files
`fullchain.pem` + `privkey.key` in the same place.

> Self-signed certs trip the browser's "not trusted" warning. For a clean
> padlock (and a working Telegram Mini App, which requires a trusted cert)
> either (a) put the domain behind Cloudflare proxy with SSL mode **Full**
> and use a Cloudflare Origin cert here, or (b) install a real cert issued
> elsewhere.

## Topology

```
                 :443 (TLS, your cert)
  Internet ───▶  reverse proxy ───▶  reiwa:5000 ──▶ /        SPA (static)
                 (this folder)                     └▶ /api/* BFF
                                     on remnawave-network
```

- The single `reiwa` container serves BOTH the SPA and the `/api/*` BFF on
  `:5000` (unified image — no separate nginx/web container). It is published
  only on loopback in `docker-compose.yml`; the edge proxy is the single
  public surface.
- All proxy stacks join the **external** `remnawave-network`, resolving
  `reiwa` by its compose service name.

> The reiwa app is the **user** surface. The rezeis admin **panel** has
> its own proxy stacks under `rezeis/deploy/proxies/` (upstream
> `rezeis:8000`). Run them on different hostnames (e.g.
> `app.example.com` for reiwa, `panel.example.com` for rezeis); a single
> proxy instance can serve both with two `server` / router blocks.

## Telegram Mini App note

The Mini App must be embeddable in Telegram's webview, so the reiwa API sets
a relaxed CSP `frame-ancestors` (Telegram origins) instead of a blanket
`X-Frame-Options: DENY`. The Mini App also requires a **publicly trusted**
TLS cert — self-signed works for plain browser testing but Telegram will
reject it, so use a real /
Cloudflare Origin cert for Mini App use.

## Prerequisites

1. A registered domain pointing (A/AAAA) at the server IP. The SPA does
   not support a sub-path mount — use a host or sub-domain.
2. The shared docker network exists:

   ```bash
   docker network create remnawave-network 2>/dev/null || true
   ```

3. Generate/drop in the cert, edit the config (replace
   `REPLACE_WITH_YOUR_DOMAIN`), then bring the proxy up before/with the
   reiwa stack:

   ```bash
   cd deploy/proxies/<chosen>      # caddy | nginx | traefik | angie
   docker compose up -d && docker compose logs -f
   ```

## Which one?

| Proxy            | Notes                                                     |
| ---------------- | --------------------------------------------------------- |
| **caddy**        | simplest; serves your mounted cert, redirects disabled    |
| **nginx**        | full control, Mozilla-Intermediate TLS profile            |
| **angie**        | nginx-syntax, same TLS profile                            |
| **traefik**      | file-driven; BYO cert via dynamic `tls` provider          |
| **try-cloudflare** | dev/demo only — outbound Quick Tunnel, **never prod**   |

All HTTPS stacks ship a stealth default server (TLS reject / `204` on a
non-matching SNI).

## After the proxy is up

```bash
cd ../../..              # back to reiwa/
docker compose up -d
```

Open `https://<your-domain>` — you should see the reiwa sign-in / cabinet.

## Notes

- **SSE:** the cabinet uses a realtime SSE stream (`/api/v1/realtime/stream`).
  All configs disable proxy buffering and raise read timeouts so the
  stream stays open.
- Do not use `try-cloudflare` in production.

## Inbound webhook from rezeis-admin (split-VPS only)

When `rezeis-admin` runs on a different VPS than reiwa, the panel delivers
its operator events (bot-config invalidation, per-user notifications,
broadcasts) to **the same public domain** the cabinet uses, on path
`POST /api/v1/webhooks/rezeis`. reiwa-api verifies the signed envelope
(`X-Rezeis-Signature: t=<sec>,v1=<hmac>`, secret = admin's
`WEBHOOK_SECRET_HEADER` ↔ reiwa's `REZEIS_WEBHOOK_SECRET`) and relays the
action to reiwa-bot internally. The bot itself is **never** exposed.

The webhook path lives under `/api/*`, so the existing reverse-proxy
config already forwards it to `reiwa:5000` — **no per-proxy changes are
required**. A few operational notes regardless of which stack you picked:

- Allow `POST` (every config here already does) and a body of at least
  16 KiB (well within the default `client_max_body_size` of all four
  stacks; the largest event is a notification of ≤16 KiB).
- Do **not** rewrite the request path. The HMAC is signed over the body
  only, but the receiver matches on the literal path
  `/api/v1/webhooks/rezeis`.
- Forward `X-Rezeis-Signature` and `X-Rezeis-Event` unchanged. Caddy's
  `reverse_proxy`, nginx/angie's `proxy_pass`, and Traefik's services
  pass arbitrary headers through by default — no special directive needed.
- Optional hardening: rate-limit `POST /api/v1/webhooks/rezeis` (e.g.
  10 req/s per source IP) and IP-allowlist the admin VPS at the proxy.
  reiwa-api itself excludes this path from its global limiter because
  webhook delivery is server-to-server (signature-authed) and a 429
  here would drop operator events.

On the admin side, set `REIWA_URL=https://<reiwa-public-domain>` (the
same domain users open) and `WEBHOOK_SECRET_HEADER=<64-char hex>`. On
the reiwa side, set `REZEIS_WEBHOOK_SECRET` to the same value. No
separate bot subdomain or public bot port is needed.
