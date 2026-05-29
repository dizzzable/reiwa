#!/usr/bin/env sh
# Generate a self-signed TLS certificate for a reverse-proxy stack.
#
# Produces fullchain.pem + privkey.key (4096-bit RSA, 10-year, with a SAN)
# in the target directory. Drop them next to the proxy's docker-compose.yml
# (caddy/certs, nginx/, angie/, traefik/certs — see each stack's compose
# mount) and you're ready to run 443-only with no ACME / no port 80.
#
# Usage:
#   ./gen-self-signed-cert.sh <domain> [output-dir]
#
# Examples:
#   ./gen-self-signed-cert.sh app.example.com nginx
#   ./gen-self-signed-cert.sh app.example.com caddy/certs
#
# You can also bring your own real certificate (e.g. a Cloudflare Origin
# cert, or one issued by your own acme.sh via DNS-01) — just name the files
# fullchain.pem + privkey.key in the same place.
set -eu

DOMAIN="${1:?usage: gen-self-signed-cert.sh <domain> [output-dir]}"
OUT="${2:-.}"

mkdir -p "$OUT"

openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
  -keyout "$OUT/privkey.key" \
  -out "$OUT/fullchain.pem" \
  -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN"

echo "Wrote $OUT/fullchain.pem and $OUT/privkey.key (CN=$DOMAIN)"
