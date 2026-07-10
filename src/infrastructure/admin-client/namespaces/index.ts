/**
 * Namespace barrel.
 *
 * 14 namespaces grouped by upstream domain. Each one wraps a slice of
 * the rezeis-admin internal API; the `AdminClient` facade composes them
 * and exposes legacy method names as thin delegations until Wave 3-5
 * migrate the call sites.
 */
export { ActivityNamespace } from './activity.js';
export { AddOnsNamespace } from './add-ons.js';
export type { AddOn, AddOnPrice } from './add-ons.js';
export { AdvertisingNamespace } from './advertising.js';
export type {
  RecordAdClickInput,
  CreatePartnerAdRequestInput,
  PartnerAdPlacementStat,
} from './advertising.js';
export { BrandingNamespace } from './branding.js';
export type { BrandingPayload, PublicConfigPayload } from './branding.js';
export { CatalogNamespace } from './catalog.js';
export { ExtAuthNamespace } from './ext-auth.js';
export type {
  ExternalAuthProvider,
  ExternalAuthResolution,
  PublicExternalProvider,
} from './ext-auth.js';
export { DevicesNamespace } from './devices.js';
export { EventsNamespace } from './events.js';
export type { EventCategory, EventInput, EventSeverity } from './events.js';
export { FaqNamespace } from './faq.js';
export type { FaqItem } from './faq.js';
export { LandingNamespace } from './landing.js';
export { LinkingNamespace } from './linking.js';
export type {
  LinkEmailInitiateResult,
  LinkEmailVerifyResult,
  LinkTelegramConsumeResult,
  LinkTelegramGenerateResult,
} from './linking.js';
export { PartnerNamespace } from './partner.js';
export type { CreateWithdrawalInput } from './partner.js';
export { PaymentsNamespace } from './payments.js';
export type { CreateCheckoutOptions } from './payments.js';
export { PromocodesNamespace } from './promocodes.js';
export { PushNamespace } from './push.js';
export type { WebPushSubscriptionPayload } from './push.js';
export { QuestsNamespace } from './quests.js';
export { ReferralsNamespace } from './referrals.js';
export type { ExchangePointsInput, PointsExchangeType } from './referrals.js';
export { SubscriptionNamespace } from './subscription.js';
export type { UserIdentity } from './subscription.js';
export { SupportNamespace } from './support.js';
export type { CreateTicketInput } from './support.js';
export { SystemNamespace } from './system.js';
export { TrialNamespace } from './trial.js';
export { UserNamespace } from './user.js';
export type { BootstrapUserInput } from './user.js';
export { WebAuthNamespace } from './web-auth.js';
export type {
  WebAuthBotSigninConsumeResult,
  WebAuthBotSigninIssueResult,
  WebAuthLoginResult,
  WebAuthRecoverResult,
  WebAuthRegisterOptions,
  WebAuthRegisterResult,
} from './web-auth.js';
