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
  Internet ───▶  reverse proxy ───▶  reiwa-web:80 ──▶ /        SPA (static)
                 (this folder)                       └▶ /api/* reiwa:5000 (BFF)
                                     on remnawave-network
```

- `reiwa-web` (nginx serving the built SPA) and `reiwa` (the Express BFF)
  are published only on loopback in `docker-compose.yml`. The edge proxy
  is the single public surface.
- `reiwa-web` already proxies `/api/*` to `reiwa:5000` internally, so the
  edge proxy only forwards everything to `reiwa-web:80`.
- All proxy stacks join the **external** `remnawave-network`, resolving
  `reiwa-web` by its compose service name.

> The reiwa app is the **user** surface. The rezeis admin **panel** has
> its own proxy stacks under `rezeis/deploy/proxies/` (upstream
> `rezeis:8000`). Run them on different hostnames (e.g.
> `app.example.com` for reiwa, `panel.example.com` for rezeis); a single
> proxy instance can serve both with two `server` / router blocks.

## Telegram Mini App note

The Mini App must be embeddable in Telegram's webview, so these proxies
**do not** send a restrictive `frame-ancestors` / `X-Frame-Options: DENY`.
Framing stays permissive (handled by the inner `reiwa-web` nginx). The
Mini App also requires a **publicly trusted** TLS cert — self-signed works
for plain browser testing but Telegram will reject it, so use a real /
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
