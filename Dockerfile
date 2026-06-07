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
RUN npm run build

# ── Production deps only — no tsx / vitest / typescript in the runtime image ─
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime — slim image: prod node_modules + compiled dist + assets + SPA ───
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Point the API at the bundled SPA so it serves the front-end too.
ENV REIWA_WEB_DIST=/app/web
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY --from=build-web /app/web/dist ./web
COPY package*.json ./
CMD ["node", "dist/api/main.js"]
