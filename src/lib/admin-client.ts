/**
 * Re-export shim for the legacy `src/lib/admin-client` import path.
 *
 * Wave 2 relocated `AdminClient` to
 * `src/infrastructure/admin-client/` and split the 62-method god-class
 * into 14 namespaces (`client.user.bootstrap()`, `client.payments.*`,
 * etc.). The legacy method surface is preserved on the namespace
 * facade as thin delegations so existing callers (`bot/main.ts`,
 * `worker/main.ts`, `api/routes/*`, `event-reporter.ts`) keep
 * compiling untouched.
 *
 * Wave 3-5 migrate call sites to the namespace surface; Wave 6 removes
 * this shim.
 */
export {
  AdminClient,
  AdminTransport,
  type BootstrapUserInput,
  type BrandingPayload,
  type CreateCheckoutOptions,
  type CreateWithdrawalInput,
  type ExchangePointsInput,
  type LinkEmailInitiateResult,
  type LinkEmailVerifyResult,
  type LinkTelegramConsumeResult,
  type LinkTelegramGenerateResult,
  type PublicConfigPayload,
  type WebAuthLoginResult,
  type WebAuthRecoverResult,
  type WebAuthRegisterOptions,
  type WebAuthRegisterResult,
  type WebPushSubscriptionPayload,
} from '../infrastructure/admin-client/index.js';
