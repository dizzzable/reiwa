/**
 * Public entry point for the Wave 2 namespace facade.
 *
 * New code should import `AdminClient` from here; the legacy
 * `src/lib/admin-client.ts` re-export shim is kept until Wave 6
 * removes it.
 */
export { AdminClient } from './admin-client.js';
export { AdminTransport } from './transport.js';
export type {
  BootstrapUserInput,
  BrandingPayload,
  CreateCheckoutOptions,
  CreateWithdrawalInput,
  ExchangePointsInput,
  LinkEmailInitiateResult,
  LinkEmailVerifyResult,
  LinkTelegramConsumeResult,
  LinkTelegramGenerateResult,
  PublicConfigPayload,
  WebAuthLoginResult,
  WebAuthRecoverResult,
  WebAuthRegisterOptions,
  WebAuthRegisterResult,
  WebPushSubscriptionPayload,
} from './namespaces/index.js';
