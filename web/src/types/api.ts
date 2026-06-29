// ─── Session ─────────────────────────────────────────────────────────────────
export interface ReiwaWebAccount {
  id: string;
  login: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  requiresPasswordChange: boolean;
}

export interface ReiwaSession {
  /** Canonical reiwa_id (CUID) — stable across login channels. */
  id?: string;
  telegramId: string | null;
  userId: number;
  name: string;
  username?: string;
  role: string;
  /** Optional recovery email migrated onto the User row. */
  email?: string | null;
  /** Web-account sub-object — present once the user owns login credentials. */
  webAccount?: ReiwaWebAccount | null;
  /** Server-persisted onboarding-tour state. `false` → the tour auto-starts. */
  onboardingCompleted?: boolean;
  /** Permanent personal discount (%) — drives the violet promo-icon glow. */
  personalDiscount?: number;
  /** One-time next-purchase discount (%) — drives the amber promo-icon glow. */
  purchaseDiscount?: number;
}

// ─── Plans ───────────────────────────────────────────────────────────────────
// Mirrors the rezeis public catalog payload (`/api/v1/plans` →
// `PlanCatalogPlanInterface`). The catalog already filters to active,
// non-archived, context-available plans, so there are no `isActive` /
// `isArchived` flags on the wire.
export interface PlanPrice {
  /** Payment gateway this price is offered through (e.g. "STRIPE"). */
  gatewayType?: string;
  currency: string;
  /** Price before any discount, as a decimal string from the backend. */
  originalPrice?: string;
  /** Effective price. Number in legacy shape, decimal string in catalog. */
  price: number | string;
  discountPercent?: number;
  discountSource?: string;
  supportedPaymentAssets?: string[];
}

export interface PlanDuration {
  id: string | number;
  days: number;
  prices: PlanPrice[];
}

export interface Plan {
  id: string | number;
  name: string;
  description: string | null;
  tag: string | null;
  /** Optional lucide icon key for the plan card (falls back to type-derived icon). */
  icon?: string | null;
  type: "TRAFFIC" | "DEVICES" | "BOTH" | "UNLIMITED";
  availability: string;
  trafficLimit: number | null; // GB
  deviceLimit: number | null;
  trafficLimitStrategy: string;
  internalSquads?: string[];
  externalSquad?: string | null;
  orderIndex: number;
  /** True when this is a trial-availability plan (always creates a trial sub). */
  isTrial?: boolean;
  /** For trial plans: whether it is free (claimed) or paid (purchased). */
  trialFree?: boolean;
  durations: PlanDuration[];
  /**
   * Gateway-independent, operator-configured prices for catalog display only
   * ("от X / N дн" on the tariff card). Present even when no payment gateway is
   * active, unlike `durations[].prices`. Checkout still uses `durations`.
   */
  displayPrices?: { currency: string; price: number | string; days: number }[];
}

// ─── Subscription ────────────────────────────────────────────────────────────
export type SubscriptionStatus =
  | "ACTIVE"
  | "DISABLED"
  | "LIMITED"
  | "EXPIRED"
  | "DELETED";

export interface Subscription {
  id: string;
  userTelegramId?: string;
  userRemnaId: string | null;
  /** Human-readable Remnawave profile name (e.g. `rz_login_sub`) shown on the card. */
  profileName?: string | null;
  status: SubscriptionStatus;
  isTrial: boolean;
  trafficLimit: number | null; // GB
  /** Traffic consumed so far (GB). null when usage data is unavailable. */
  trafficUsed?: number | null;
  deviceLimit: number | null;
  expireAt?: string; // Legacy alias
  expiresAt: string | null; // ISO date (canonical)
  url: string | null;
  configUrl?: string | null;
  plan: { id: string | null; name: string | null; type: string | null } | null;
  createdAt: string;
  startedAt?: string | null;
  updatedAt?: string;
}

// ─── Action policy ───────────────────────────────────────────────────────────
export interface ActionPolicy {
  canBuy: boolean;
  canRenew: boolean;
  canUpgrade: boolean;
  canTrial: boolean;
  requiresNewSubscription?: boolean;
}

// ─── Quote ───────────────────────────────────────────────────────────────────
export interface SubscriptionQuote {
  planId: string | number;
  planName: string;
  durationDays: number;
  currency: string;
  basePrice: number;
  discountPercent: number;
  finalPrice: number;
  gatewayType: string;
  /** Present only when the upstream couldn't price the selection. */
  warning?: string;
}

// ─── Renewal (combined multi-subscription) ───────────────────────────────────
export interface RenewalOptionItem {
  subscriptionId: string;
  planId: string | null;
  planName: string | null;
  durationDays: number | null;
  /** Durations the target plan offers, so the UI can re-pick the renewal term.
   *  Empty when the item isn't renewable. */
  availableDurations: { id: string; days: number }[];
  currency: string | null;
  amount: string | null;
  discountPercent: number;
  renewable: boolean;
  warnings: { code: string; message: string }[];
}

export interface RenewalOptions {
  userId: string;
  items: RenewalOptionItem[];
  /** Common currency across priceable items, or null when none/mixed. */
  currency: string | null;
  /** Sum of priceable item amounts as a decimal string, or null. */
  total: string | null;
}

// ─── Checkout ────────────────────────────────────────────────────────────────
// Mirrors the backend `InternalPaymentCheckoutInterface`. The provider redirect
// URL is `checkoutUrl` (may be null for non-redirect flows like Telegram Stars).
export interface CheckoutResult {
  paymentId: string;
  checkoutUrl: string | null;
  gatewayType: string;
  currency: string;
  amount: string;
  providerMode?: string;
}

// ─── Payment status ──────────────────────────────────────────────────────────
export interface PaymentStatus {
  paymentId: string;
  status: "PENDING" | "COMPLETED" | "CANCELED" | "REFUNDED" | "FAILED";
  amount: number;
  currency: string;
  gatewayType: string;
  createdAt: string;
}

// ─── Transaction ─────────────────────────────────────────────────────────────
export interface Transaction {
  id: number;
  paymentId: string;
  status: "PENDING" | "COMPLETED" | "CANCELED" | "REFUNDED" | "FAILED";
  gatewayType: string;
  currency: string;
  pricing: { finalPrice: number; currency: string };
  plan: { id: number; name: string } | null;
  createdAt: string;
}

export interface TransactionsResponse {
  transactions: Transaction[];
  total: number;
}

// ─── Notifications ───────────────────────────────────────────────────────────
// Raw shape as returned by the rezeis edge (`/api/internal/user/notifications`):
// the server sends the event type + JSON payload + read timestamp, and the
// human-readable title/body are derived client-side (localized) via
// `presentNotification`.
export interface UserNotification {
  id: string;
  type: string;
  payload?: Record<string, unknown> | null;
  readAt?: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: UserNotification[];
  total?: number;
}

/** Localized, display-ready notification produced by `presentNotification`. */
export interface PresentedNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

// ─── Referrals ───────────────────────────────────────────────────────────────
export interface ReferralSummary {
  totalReferrals: number;
  qualifiedReferrals: number;
}

export interface ReferralInvite {
  token: string;
  expiresAt?: string;
}

// ─── Platform policy ─────────────────────────────────────────────────────
/** Canonical platform access mode mirrored from rezeis-admin Prisma enum. */
export type AccessMode =
  | 'PUBLIC'
  | 'INVITED'
  | 'PURCHASE_BLOCKED'
  | 'REG_BLOCKED'
  | 'RESTRICTED';

export interface PlatformPolicy {
  accessMode: AccessMode;
  rulesRequired: boolean;
  channelRequired: boolean;
  rulesLink: string;
  channelLink: string;
  defaultCurrency: string;
}

// ─── Devices (HWID) ───────────────────────────────────────────────────────
export interface HwidDevice {
  id: string;
  hwid: string;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface DevicesResponse {
  devices: HwidDevice[];
}

// ─── All subscriptions ───────────────────────────────────────────────────
export interface AllSubscriptionsResponse {
  subscriptions: Subscription[];
}

// ─── Promo activations ───────────────────────────────────────────────────
export interface PromoActivation {
  id: string;
  rewardType: string;
  rewardValue: number | null;
  createdAt: string;
  promocode: {
    code: string;
    rewardType: string;
  } | null;
}

export interface PromoActivationsResponse {
  activations: PromoActivation[];
  total: number;
  page: number;
  limit: number;
}

// ─── Referral Rewards ────────────────────────────────────────────────────
export interface ReferralReward {
  id: string;
  type: string;
  value: number;
  isIssued: boolean;
  createdAt: string;
}

export interface ReferralRewardsResponse {
  rewards: ReferralReward[];
  total: number;
  page: number;
  limit: number;
}

// ─── Public config ─────────────────────────────────────────────────────────
export interface PublicConfig {
  buttons: Array<{
    id: string;
    emoji: string;
    label: string;
    visible: boolean;
    order: number;
    style: string;
    onePerRow: boolean;
  }>;
  visual: {
    welcomeMessage: string;
    botDescription: string;
    supportUsername: string;
    channelUsername: string;
    subscriptionInfoFormat: "full" | "compact" | "minimal";
  };
  features: {
    referralsEnabled: boolean;
    promoCodesEnabled: boolean;
    trialEnabled: boolean;
    miniAppEnabled: boolean;
    activityFeedEnabled: boolean;
    partnersEnabled: boolean;
  };
  botEmojis: Record<string, { unicode: string; tgEmojiId: string }>;
}
