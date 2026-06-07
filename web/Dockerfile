FROM node:24-alpine AS builder
WORKDIR /app

# Copy package files FIRST for layer caching
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Serve with nginx ──────────────────────────────────────────────────────
FROM nginx:alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
