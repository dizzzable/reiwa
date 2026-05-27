/**
 * Re-export shim for the legacy `@/lib/api-client` import path.
 *
 * Wave 5 relocated the SPA HTTP layer into `lib/api-client/` (one file
 * per upstream domain — `auth.ts`, `payments.ts`, `referrals.ts`, ...)
 * and added a request-id interceptor on the shared axios instance so
 * SPA → reiwa-api → rezeis-admin share a single trace key.
 *
 * Every legacy free-function name (`login`, `getSession`,
 * `createCheckout`, ...) is preserved on the new barrel so existing
 * `features/*` and `hooks/*` modules keep compiling untouched. Wave 6
 * removes this shim once features migrate to namespace imports.
 */
export * from "./api-client/index.js";
