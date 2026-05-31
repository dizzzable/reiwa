/**
 * api-client barrel.
 *
 * Wave 5 split the SPA's HTTP layer into per-domain modules under
 * `lib/api-client/`. Components keep importing from `@/lib/api-client`
 * (which now points at this barrel via the legacy `api-client.ts`
 * shim) — every legacy free-function name is re-exported below.
 *
 * New code should prefer the namespace imports:
 *
 *   import * as auth from "@/lib/api-client/auth";
 *   await auth.login(...);
 *
 * over the flat re-exports, but both shapes work and stay green
 * through Wave 6.
 */
export { apiClient } from "./transport.js";

// Auth
export {
  bootstrapTelegram,
  botSignin,
  changePasswordAuth,
  checkUsername,
  getAuthStatus,
  login,
  recoverPassword,
  registerUser,
  signOut,
  type AuthStatusResponse,
  type BotSigninResponse,
  type LoginRequest,
  type LoginResponse,
  type RecoverResponse,
  type RegisterResponse,
} from "./auth.js";

// Session + platform
export { acceptRules, getPlatformPolicy, getSession } from "./session.js";

// Plans
export { getPlans } from "./plans.js";

// Subscription
export {
  activateTrial,
  getActionPolicy,
  getAllSubscriptions,
  getQuote,
  getSubscription,
  getTrialEligibility,
  getUpgradeOptions,
} from "./subscription.js";

// Payments + gateways
export {
  createCheckout,
  createRenewCheckout,
  createUpgradeCheckout,
  getEnabledGateways,
  getPaymentStatus,
  type GatewayOption,
} from "./payments.js";

// Activity
export {
  getNotifications,
  getTransactions,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "./activity.js";

// Promocodes
export {
  activatePromocode,
  getEligibleSubscriptions,
  getPromoActivations,
} from "./promocodes.js";

// Referrals
export {
  createReferralInvite,
  exchangePoints,
  getInviteCapacity,
  getInvitedUsers,
  getPointsExchangeOptions,
  getReferralInvites,
  getReferralRewards,
  getReferralSummary,
  revokeReferralInvite,
  type InviteCapacity,
  type InvitedUser,
  type InvitedUsersResponse,
  type PointsExchangeOptions,
} from "./referrals.js";

// Devices
export { deleteUserDevice, getUserDevices } from "./devices.js";

// Partner
export {
  createWithdrawal,
  getPartnerEarnings,
  getPartnerInfo,
  getPartnerStatus,
  getPartnerWithdrawals,
  type PartnerStatus,
} from "./partner.js";

// Profile
export {
  changePassword,
  completeEmailVerification,
  requestEmailVerification,
  updateLanguage,
  updateProfile,
} from "./profile.js";

// Branding
export {
  getBranding,
  getPublicConfig,
  getReiwaPublicConfig,
} from "./branding.js";

// Support
export {
  createTicket,
  getTicket,
  getTickets,
  replyToTicket,
  type SupportTicket,
  type SupportTicketMessage,
} from "./support.js";

// Web push
export {
  getPushPublicKey,
  pushSubscribe,
  pushUnsubscribe,
  type PushPublicKeyResponse,
  type PushSubscribePayload,
  type PushUnsubscribePayload,
} from "./push.js";

// Linking (Telegram + Email)
export {
  initiateEmailLink,
  initiateTelegramLink,
  verifyEmailLink,
  type EmailLinkInitiateResponse,
  type EmailLinkVerifyResponse,
  type TelegramLinkInitiateResponse,
} from "./linking.js";

// Content (FAQ + add-ons)
export {
  getFaq,
  getPlanAddOns,
  purchaseAddOn,
  type AddOn,
  type AddOnCheckoutResult,
  type AddOnPrice,
  type FaqItem,
} from "./content.js";
