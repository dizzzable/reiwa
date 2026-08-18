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

## Upstream port is hard-coded

Every config in this folder dials **`reiwa:5000` as a literal**. It is not
read from `.env`, and it cannot be: the proxy stacks load no env file, and
this project keeps its settings in the panel rather than adding variables.

That is a trap, because the port *is* parameterised on the app side —
`docker-compose.yml` publishes `${REIWA_PORT:-5000}` and the app listens on
`PORT ?? REIWA_PORT`. Set `REIWA_PORT` to anything but 5000 and the two halves
disagree silently:

- the proxy keeps dialing 5000, which is now closed;
- every request dies at the edge (502, or a Cloudflare error page on the
  tunnel);
- the app logs **nothing**, because no request ever reaches it;
- `docker compose ps` reports both containers healthy.

Nothing in either log names the cause. **If you change `REIWA_PORT`, change the
port by hand in every file below.** Each one carries the same warning in a
comment next to the literal:

| File                                | Occurrences                              |
| ----------------------------------- | ---------------------------------------- |
| `caddy/Caddyfile`                   | 2 × `reverse_proxy http://reiwa:5000`     |
| `nginx/nginx.conf`                  | 2 × `set $reiwa_upstream reiwa:5000;`     |
| `angie/angie.conf`                  | 2 × `set $reiwa_upstream reiwa:5000;`     |
| `traefik/config/reiwa.yml`          | 2 × `url: "http://reiwa:5000"`            |
| `try-cloudflare/docker-compose.yml` | 1 × `--url http://reiwa:5000`             |

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

### Security headers

All four stacks send `Strict-Transport-Security: max-age=31536000;
includeSubDomains` (one year). `preload` is deliberately **not** set — it is a
one-way submission to browser vendors and should be a separate, conscious
decision.

> `includeSubDomains` is a commitment. It pins HTTPS for every name under this
> host's apex. If the cabinet and the rezeis panel share an apex (e.g.
> `app.example.com` and `panel.example.com` under `example.com`), the header
> from either one applies to the whole tree — including subdomains that have
> no certificate yet, which become unreachable in browsers that saw the
> header, for a year. Drop `includeSubDomains` if your DNS layout makes that
> risky; the max-age alone still protects this host.

On Nginx and Angie the directive uses `always` so it also covers error
responses. Note that `add_header` is **not** inherited into a `location` that
declares its own `add_header` — if you add one, repeat the HSTS line there or
it silently disappears for that path.

### Request-body limits

Nginx and Angie cap request bodies at **16 MB**, matching the path-scoped
`express.json({ limit: "16mb" })` on `/api/v1/support/guest/attachments`
(base64 JSON, so ~16 MB of transport ≈ ~12 MB of real file; the decoded bytes
are re-validated on the rezeis side against `SUPPORT_ATTACHMENT_MAX_MB`,
default 10 MB). Every other route is bounded by the app's global 1 MB parser.
Caddy and Traefik impose no ceiling of their own.

### Timeouts, and the one streaming route

The cabinet has exactly **one** long-lived route: `GET
/api/v1/realtime/stream` (`text/event-stream`, held open for hours). There are
**no WebSockets anywhere in the app** — nothing in it ever answers a 101.

That single route used to set the terms for every other request. Nginx and
Angie carried `proxy_buffering off` + `proxy_read_timeout 3600s` on
`location /`, and Caddy carried `flush_interval -1` on `reverse_proxy *`:
streaming settings applied to **all** traffic.

The cost was not the buffering, it was the wait. An app that stops answering
produced no error at all: Nginx and Angie sat on the request for a full hour
before the 504, while Caddy and Traefik had no response deadline configured at
all and would have waited indefinitely. Either way the browser tab spins, the
operator says "the cabinet is down", and the proxy logs nothing — from its
side nothing has gone wrong yet.

Every stack now separates the two:

| Stack          | Streaming route                                                                            | Everything else                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| nginx / angie  | `location = /api/v1/realtime/stream` — `proxy_buffering off`, `proxy_read_timeout 3600s`   | `proxy_connect_timeout 5s`, `proxy_send_timeout 60s`, `proxy_read_timeout 60s`      |
| caddy          | `handle /api/v1/realtime/stream` — `flush_interval -1`                                     | `transport http { response_header_timeout 60s }` (`dial_timeout` defaults to 3s)    |
| traefik        | router `reiwa-stream` → `serversTransport: reiwa-stream`, `responseHeaderTimeout: 0s`       | static `serversTransport.forwardingTimeouts`: `dialTimeout 5s`, `responseHeaderTimeout 60s` |
| try-cloudflare | nothing to do — the defect never existed here (below)                                       | nothing to do                                                                       |

This matters most in the **split-VPS** layout: the SPA document calls the panel
on another host before its first byte, so a panel outage turns every page load
into a slow request. The edge has to cut those off fast, and must not cut off
the stream.

Two traps are worth naming, because each is the obvious next edit and each one
kills the stream:

- **Caddy** has no `read_timeout` / `write_timeout` in `transport http` — it
  refuses to start on an unknown sub-directive. The client-side write deadline
  is the global `servers { timeouts { write } }`, which is server-wide with no
  per-route override: set it and it cuts every SSE subscriber off at exactly
  that age.
- **Traefik**'s `entryPoints.https.transport.respondingTimeouts.writeTimeout`
  is the same hazard — it bounds the entire response *write*, it is
  entrypoint-wide, and it has no per-router override. Traefik ships it at `0`
  (no limit); `traefik.yml` deliberately leaves it there and says so.

**try-cloudflare never had the defect.** `cloudflared` bounds its own origin
connect (`connectTimeout`, 30s by default); Cloudflare's edge enforces an
origin-response deadline on top of that (error 524, 125s by default) which no
local config can disable; and the tunnel streams instead of buffering when the
origin sends `Content-Type: text/event-stream`, which the realtime route does.

### Real client IP behind a CDN

These stacks assume the VPS terminates TLS **directly**, which is the
supported topology: the peer address is the real client and `X-Forwarded-For`
is correct.

If you ever put Cloudflare (or any CDN) in front, you must tell the proxy whom
to trust. Otherwise the cabinet sees a CDN edge address as the client, and its
coordinated-brute-force detector bans that edge for **24 hours** — locking out
every legitimate user routed through the same Cloudflare datacentre, for a
day. Every config in this folder carries a commented, ready-to-enable block;
ranges must be fetched from <https://www.cloudflare.com/ips/> (they change).

> Note the app sets `trust proxy 1` — it trusts exactly **one** hop. A
> Cloudflare → nginx → app chain is two hops, so `req.ip` resolves to the
> Cloudflare edge rather than the client. Enabling `real_ip_header
> CF-Connecting-IP` on the proxy fixes this properly, because it rewrites the
> peer address before `X-Forwarded-For` is built.

> Traefik is the worst of the four here. Nginx, Angie and Caddy forward a
> wrong-but-present client address when untrusted. Traefik **strips every
> `X-Forwarded-*` header** from an untrusted peer instead of shifting them, so
> the client address is destroyed outright rather than merely wrong. Traefik
> also has no equivalent of `real_ip_header CF-Connecting-IP` — it understands
> only `X-Forwarded-For`.

### Stealth default

All HTTPS stacks ship a stealth default server: connections that hit the IP
without the right SNI get a TLS reject (Nginx/Angie), a self-signed handshake
and empty `204` (Caddy), or Traefik's own generated self-signed certificate —
so the app hostname isn't trivially discoverable by scanning the IP.

> Traefik's `config/tls.yml` previously set the real `fullchain.pem` as
> `stores.default.defaultCertificate`, which had the opposite of the intended
> effect: an SNI-less IP scan completed a handshake and was handed a
> certificate **naming the operator's domain**. The store block has been
> removed so Traefik falls back to its generated self-signed default, which
> names nothing. Only clients sending no SNI or a wrong SNI are affected, and
> every TLS 1.3 client sends SNI.

## After the proxy is up

```bash
cd ../../..              # back to reiwa/
docker compose up -d
```

Open `https://<your-domain>` — you should see the reiwa sign-in / cabinet.

## Notes

- **SSE:** the cabinet uses a realtime SSE stream (`/api/v1/realtime/stream`),
  and it is the only streaming route — there are no WebSockets. Each config
  gives it its own location/handler/router with buffering off, and holds every
  *other* path to a finite deadline. See
  [Timeouts, and the one streaming route](#timeouts-and-the-one-streaming-route).
- Do not use `try-cloudflare` in production.

## Split-VPS: the panel's certificate must be publicly trusted

The traffic described below is *inbound* (panel → cabinet). Traffic also flows
the other way: the cabinet calls the panel's HTTPS API for subscriptions,
plans and payments, using Node's default trust store. It sets no custom CA, no
`NODE_EXTRA_CA_CERTS`, and never disables verification.

**If the panel is served with a self-signed certificate, every cabinet → panel
call fails at the TLS handshake.**

> **Diagnostic note — this failure points at the wrong machine.** If
> cabinet → panel calls fail at TLS, check the panel's certificate trust
> *before* assuming the panel is down. The cabinet keeps serving pages from
> its Redis branding snapshot, so it looks alive and merely "empty", and the
> panel itself is healthy and responding — it is the trust chain between them
> that is broken. Operators routinely lose an hour on the panel box before
> checking the certificate.
>
> Quick check from the reiwa host: an OpenSSL verify against the default trust
> store, e.g. `openssl s_client -connect <panel-domain>:443 -servername
> <panel-domain> -brief`. A `self-signed certificate` or `unable to verify the
> first certificate` result is the bug.

Self-signed is fine for the **cabinet** in browser-only testing (you click
through the warning yourself; Telegram Mini App use still needs a trusted
cert). It is never acceptable for the **panel** in a split deployment. See the
matching warning in `rezeis/deploy/proxies/README.md`.

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
  16 KiB. The largest event is a notification of ≤16 KiB, comfortably
  inside the 16 MB `client_max_body_size` set by the Nginx and Angie
  templates, and Caddy and Traefik set no ceiling at all.
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
