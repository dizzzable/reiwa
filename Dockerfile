# ══════════════════════════════════════════════════════════════════════════════
#  reiwa — unified image (API + bot + worker + SPA)
#
#  Single image serves everything:
#    • API on REIWA_PORT (default CMD: node dist/api/main.js) — also serves
#      the built SPA from /app/web when REIWA_WEB_DIST points at it.
#    • Bot:    override CMD to ["node", "dist/bot/main.js"]
#    • Worker: override CMD to ["node", "dist/worker/main.js"]
#
#  The SPA is built in its own stage and copied to /app/web, mirroring how
#  rezeis bundles its admin SPA into one image (no separate nginx container).
# ══════════════════════════════════════════════════════════════════════════════

# ── Full deps (incl. dev) — used to compile TypeScript ──────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── Build backend — emit dist/ from src/ ────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── Build frontend SPA — emit web/dist ──────────────────────────────────────
FROM node:24-alpine AS build-web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# The browser snapshot validator is deliberately shared with the API. Keep its
# source path intact so Vite can resolve the relative import during this
# isolated web build, without bringing backend dependencies into the stage.
COPY src/application/ports/public-config-persistence.port.ts /app/src/application/ports/public-config-persistence.port.ts
RUN npm run build

# ── Production deps only — no tsx / vitest / typescript in the runtime image ─
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime — slim image: prod node_modules + compiled dist + assets + SPA ───
FROM node:24-alpine AS runtime
# ── OS packages, patched at build time ─────────────────────────────────────
#
# `node:24-alpine` is rebuilt on its own schedule, so between two of its
# rebuilds this image inherits whatever OpenSSL that snapshot happened to ship.
# Trivy found ten CVEs that way — `libssl3` 3.5.7-r0 against a fixed 3.5.8-r0 —
# and every one of them was already patched in Alpine's repository at the time.
# Nothing was wrong with the code; the image was simply older than the fix.
#
# Upgrading here closes that window without waiting for upstream. The cost is
# that the same Dockerfile no longer produces byte-identical images over time,
# and for a RUNTIME image that is the right side of the trade: the alternative
# is shipping known-vulnerable libraries on purpose so that rebuilds match.
#
# `--no-cache` keeps the package index out of the layer.
#
# ── WHY THIS LAYER MUST NOT BE A CACHE HIT ────────────────────────────────
#
# It is the first instruction of the stage, so its cache key is just the base
# image plus this literal command — and the build passes `cache-from: type=gha`.
# Left alone, the layer restored verbatim on every later build: the step added
# to patch twenty CVEs would have quietly re-shipped the exact `libssl3` it was
# written to replace, with `CACHED` in the log and Trivy re-reporting the same
# advisories after the push, failing nothing.
#
# `SECURITY_REFRESH` carries the commit sha, so the key changes whenever the
# source does and the upgrade genuinely re-runs. It costs a few seconds and it
# is the only thing making this layer mean what it says.
#
# Scope, stated plainly: this upgrades apk-managed packages within the base
# image's pinned Alpine branch — patch level only, never a new major. Node
# itself is not an apk package here, so Node's own CVEs still arrive with the
# base tag.
ARG SECURITY_REFRESH=dev
RUN echo "security refresh ${SECURITY_REFRESH}" && apk upgrade --no-cache
WORKDIR /app
# No default on purpose: an unset build-arg leaves REIWA_VERSION empty, which
# version.ts intentionally treats as "fall back to package.json". SHA/branch
# default to `unknown` since they have no code-level fallback.
ARG REIWA_VERSION
ARG REIWA_GIT_SHA=unknown
ARG REIWA_GIT_BRANCH=unknown
ENV NODE_ENV=production
ENV REIWA_VERSION=${REIWA_VERSION}
ENV REIWA_GIT_SHA=${REIWA_GIT_SHA}
ENV REIWA_GIT_BRANCH=${REIWA_GIT_BRANCH}
# Point the API at the bundled SPA so it serves the front-end too.
ENV REIWA_WEB_DIST=/app/web

# Runtime only runs Node (no package manager). Strip global npm/npx and their
# bundled dependency tree so Trivy does not report npm-shipped tar/undici CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build-web /app/web/dist ./web
COPY package*.json ./
CMD ["node", "dist/api/main.js"]
