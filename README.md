# Reiwa

Reiwa is the new Rezeis user-facing runtime. It replaces the legacy Python `ruid` layer.

## Purpose

Reiwa owns the future user-facing experience for Rezeis:

- Telegram bot and Telegram Mini App entrypoints.
- Public user account/session flows.
- Subscription purchase, renewal, upgrade, device, referral, gift, contest, and support UX.
- Safe integration with the existing `rezeis-admin` operator backend.
- Safe integration with Remnawave through Rezeis-owned backend seams, not direct browser access.

## Donor sources

The initial architecture is based on the live-code audit of:

- `altshop-1.5.0` for Rezeis business logic and current operator/user expectations.
- `backend-main` for production engineering patterns and Remnawave integration discipline.
- `remnawave-STEALTHNET-Bot-4.0.0` for user-facing bot/API/SPA capabilities.

Reiwa is **not** a copy of Remnawave Panel. It is a Rezeis user-facing service with Remnawave integration.

## Runtime contract

Current scaffolded runtime entries:

- `npm run start:api` — starts the user API runtime.
- `npm run start:bot` — starts the Telegram bot runtime placeholder.
- `npm run start:worker` — starts the future background worker runtime placeholder.
- `npm run check` — TypeScript no-emit validation.

The scaffold intentionally avoids implementing business endpoints until the API contract is migrated from donor analysis into explicit Rezeis-owned use cases.

## Safety rules

- Do not expose raw Remnawave UUIDs, provider URLs, tokens, profile links, device identifiers, Telegram delivery identifiers, or payment provider diagnostics to the browser.
- User-facing flows must use stable safe labels and opaque public identifiers.
- Provider calls must stay server-side.
- Admin/operator truth remains in `rezeis-admin` until a Reiwa-owned domain seam is explicitly designed.
- No direct reuse of legacy `ruid` Python architecture.

## Next implementation phases

1. Define Reiwa API contracts for session, public config, plans, subscription, payments, referrals, support, and devices.
2. Implement typed config validation and safe runtime foundations.
3. Port donor user business flows from `remnawave-STEALTHNET-Bot-4.0.0` into Rezeis-owned modules.
4. Integrate with `rezeis-admin` internal contracts for business truth.
5. Add frontend/Mini App after backend contracts stabilize.
