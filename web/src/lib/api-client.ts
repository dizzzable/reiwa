import axios from "axios";

export const apiClient = axios.create({
  baseURL: "/api/v1",
  withCredentials: true, // send reiwa_session cookie automatically
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});

// ── Response interceptor — handle session expiry ──────────────────────────
apiClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      // Clear any local state and redirect to bootstrap
      window.location.replace("/bootstrap");
    }
    return Promise.reject(error);
  },
);

// ── API functions ─────────────────────────────────────────────────────────

import type {
  ReiwaSession,
  Plan,
  Subscription,
  ActionPolicy,
  SubscriptionQuote,
  CheckoutResult,
  PaymentStatus,
  TransactionsResponse,
  NotificationsResponse,
  ReferralSummary,
  ReferralInvite,
  PlatformPolicy,
  DevicesResponse,
  AllSubscriptionsResponse,
  PromoActivationsResponse,
  ReferralRewardsResponse,
  PublicConfig,
} from "@/types/api";

export interface GatewayOption {
  type: string;
  displayName: string;
  currency: string;
  isActive: boolean;
}

// Auth — Web password change
export const changePasswordAuth = (data: { currentPasswordHash: string; newPasswordHash: string }) =>
  apiClient.post('/auth/change-password', data).then((r) => r.data);

// Auth
export const bootstrapTelegram = (initData: string) =>
  apiClient
    .post<{
      ok: boolean;
      user: ReiwaSession;
    }>("/auth/telegram/bootstrap", undefined, {
      headers: { Authorization: `tma ${initData}` },
    })
    .then((r) => r.data);

export interface LoginRequest {
  username: string;
  passwordHash: string;
}

export interface LoginResponse {
  success: boolean;
  redirectUrl: string;
  requiresPasswordChange: boolean;
  suppressErrors?: boolean;
  suppressPasswordChangeRedirect?: boolean;
}

export const login = (data: LoginRequest) =>
  apiClient.post<LoginResponse>("/auth/login", data).then((r) => r.data);

export const signOut = () =>
  apiClient.post("/auth/sign-out").then((r) => r.data);

// Auth Status & Registration
export interface AuthStatusResponse {
  isRegistrationEnabled: boolean;
  isAuthenticated: boolean;
  context: "tma" | "web";
}

export interface RegisterResponse {
  success: boolean;
  redirectUrl: string;
}

export const getAuthStatus = () =>
  apiClient.get<AuthStatusResponse>("/auth/status").then((r) => r.data);

export const registerUser = (username: string, passwordHash: string, checkOnly?: boolean) =>
  apiClient
    .post<RegisterResponse>("/auth/register", { username, passwordHash, ...(checkOnly ? { checkOnly: true } : {}) })
    .then((r) => r.data);

export interface RecoverResponse {
  method: "telegram" | "email" | "none";
  message: string;
}

export const recoverPassword = (username: string) =>
  apiClient
    .post<RecoverResponse>("/auth/recover", { username })
    .then((r) => r.data);

// Session
export const getSession = () =>
  apiClient.get<ReiwaSession>("/session").then((r) => r.data);

export const acceptRules = () =>
  apiClient.patch("/session/rules-acceptance").then((r) => r.data);

// Platform
export const getPlatformPolicy = () =>
  apiClient.get<PlatformPolicy>("/platform-policy").then((r) => r.data);

// Plans
export const getPlans = () =>
  apiClient.get<Plan[]>("/plans").then((r) => r.data);

// Subscription
export const getSubscription = () =>
  apiClient.get<Subscription | null>("/subscription").then((r) => r.data);

export const getActionPolicy = (planId?: number) =>
  apiClient
    .post<ActionPolicy>("/subscription/action-policy", { planId })
    .then((r) => r.data);

export const getQuote = (
  planId: number,
  durationDays: number,
  gatewayType: string,
) =>
  apiClient
    .post<SubscriptionQuote>("/subscription/quote", {
      planId,
      durationDays,
      gatewayType,
    })
    .then((r) => r.data);

// Gateways
export const getEnabledGateways = () =>
  apiClient.get<GatewayOption[]>("/gateways").then((r) => r.data);

// Payments
export const createCheckout = (
  planId: number,
  durationDays: number,
  gatewayType: string,
  deviceType?: string,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      deviceType,
    })
    .then((r) => r.data);

export const getPaymentStatus = (paymentId: string) =>
  apiClient.get<PaymentStatus>(`/payments/${paymentId}`).then((r) => r.data);

// Activity
export const getTransactions = (page = 1, limit = 20) =>
  apiClient
    .get<TransactionsResponse>("/activity/transactions", {
      params: { page, limit },
    })
    .then((r) => r.data);

export const getNotifications = (page = 1, limit = 20) =>
  apiClient
    .get<NotificationsResponse>("/activity/notifications", {
      params: { page, limit },
    })
    .then((r) => r.data);

export const getUnreadCount = () =>
  apiClient
    .get<{ count: number }>("/activity/notifications/unread-count")
    .then((r) => r.data);

export const markNotificationRead = (id: string) =>
  apiClient.post(`/activity/notifications/${id}/read`).then((r) => r.data);

export const markAllNotificationsRead = () =>
  apiClient.post("/activity/notifications/read-all").then((r) => r.data);

// Promocodes
export const activatePromocode = (code: string, subscriptionId?: number) =>
  apiClient
    .post("/promocode/activate", { code, subscriptionId })
    .then((r) => r.data);

// Referrals
export const getReferralSummary = () =>
  apiClient.get<ReferralSummary>("/referrals/summary").then((r) => r.data);

export const createReferralInvite = () =>
  apiClient.post<ReferralInvite>("/referrals/invites").then((r) => r.data);

export const getReferralInvites = () =>
  apiClient.get("/referrals/invites").then((r) => r.data);

export const revokeReferralInvite = (id: string) =>
  apiClient.post(`/referrals/invites/${id}/revoke`).then((r) => r.data);

export const getReferralRewards = (page = 1, limit = 20) =>
  apiClient
    .get<ReferralRewardsResponse>("/referrals/rewards", {
      params: { page, limit },
    })
    .then((r) => r.data);

// Devices
export const getUserDevices = () =>
  apiClient.get("/devices").then((r) => r.data);

export const deleteUserDevice = (hwid: string) =>
  apiClient.delete(`/devices/${hwid}`).then((r) => r.data);

// Partner
export const getPartnerInfo = () =>
  apiClient.get("/partner/info").then((r) => r.data);

export interface PartnerStatus {
  isActive: boolean;
}

/**
 * Lightweight partner-status flag used by the bottom-nav to swap the third
 * tab between Referral and Partner. The endpoint returns instantly for users
 * without partner activation.
 */
export const getPartnerStatus = () =>
  apiClient.get<PartnerStatus>("/partner/status").then((r) => r.data);

export const getPartnerEarnings = () =>
  apiClient.get("/partner/earnings").then((r) => r.data);

export const getPartnerWithdrawals = () =>
  apiClient.get("/partner/withdrawals").then((r) => r.data);

export const createWithdrawal = (data: { amount: number; method: string; requisites: string }) =>
  apiClient.post("/partner/withdraw", data).then((r) => r.data);

// Trial
export const getTrialEligibility = () =>
  apiClient.get("/subscription/trial/eligibility").then((r) => r.data);

export const activateTrial = () =>
  apiClient.post("/subscription/trial").then((r) => r.data);

// All subscriptions
export const getAllSubscriptions = () =>
  apiClient
    .get<AllSubscriptionsResponse>("/subscriptions/all")
    .then((r) => r.data);

// Profile extended
export const updateProfile = (data: { name?: string }) =>
  apiClient.patch("/me/profile", data).then((r) => r.data);

export const updateLanguage = (language: string) =>
  apiClient.patch("/me/language", { language }).then((r) => r.data);

export const changePassword = (newPasswordHash: string) =>
  apiClient.patch("/me/password", { newPasswordHash }).then((r) => r.data);

export const requestEmailVerification = (email: string) =>
  apiClient.post("/me/email/challenge", { email }).then((r) => r.data);

export const completeEmailVerification = (code: string) =>
  apiClient.patch("/me/email/verify", { code }).then((r) => r.data);

// Promo extended
export const getPromoActivations = (page = 1, limit = 20) =>
  apiClient
    .get<PromoActivationsResponse>("/promocode/activations", {
      params: { page, limit },
    })
    .then((r) => r.data);

export const getEligibleSubscriptions = () =>
  apiClient
    .get<Subscription[]>("/promocode/eligible-subscriptions")
    .then((r) => r.data);

// Config
export const getPublicConfig = () =>
  apiClient.get<PublicConfig>("/config").then((r) => r.data);

// Branding & Public Bootstrap
import type { Branding, PublicConfig as ReiwaPublicConfig } from "@/types/branding";

/**
 * Fetches the branding-only payload. Useful for surfaces that do not need
 * locale settings (e.g. payment-return splash before the full SPA mounts).
 */
export const getBranding = () =>
  apiClient.get<Branding>("/branding").then((r) => r.data);

/**
 * Fetches the full public bootstrap payload (branding + locales + defaultLocale).
 * Reiwa SPA hits this once on first mount via React Query.
 */
export const getReiwaPublicConfig = () =>
  apiClient.get<ReiwaPublicConfig>("/public-config").then((r) => r.data);


// ── Support Tickets ──────────────────────────────────────────────────────────

export interface SupportTicket {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages: SupportTicketMessage[];
}

export interface SupportTicketMessage {
  id: string;
  authorType: string;
  authorId: string | null;
  content: string;
  createdAt: string;
}

export const getTickets = () =>
  apiClient.get<SupportTicket[]>("/support/tickets").then((r) => r.data);

export const getTicket = (ticketId: string) =>
  apiClient.get<SupportTicket>(`/support/tickets/${ticketId}`).then((r) => r.data);

export const createTicket = (subject: string, message: string) =>
  apiClient.post<SupportTicket>("/support/tickets", { subject, message }).then((r) => r.data);

export const replyToTicket = (ticketId: string, content: string) =>
  apiClient.post<SupportTicketMessage>(`/support/tickets/${ticketId}/reply`, { content }).then((r) => r.data);

// ── Points Exchange ──────────────────────────────────────────────────────────

export interface PointsExchangeOptions {
  exchangeEnabled: boolean;
  pointsBalance: number;
  types: Array<{
    type: string;
    enabled: boolean;
    available: boolean;
    pointsCost: number;
    minPoints: number;
    maxPoints: number;
    computedValue: number;
  }>;
}

export const getPointsExchangeOptions = () =>
  apiClient.get<PointsExchangeOptions>("/referrals/exchange/options").then((r) => r.data);

export const exchangePoints = (type: string, points: number, subscriptionId?: number) =>
  apiClient.post("/referrals/exchange", { type, points, subscriptionId }).then((r) => r.data);

// ── Upgrade Options ──────────────────────────────────────────────────────────

export const getUpgradeOptions = (subscriptionId: number) =>
  apiClient.get(`/subscription/${subscriptionId}/upgrade-options`).then((r) => r.data);

// ── Renew checkout ───────────────────────────────────────────────────────────

export const createRenewCheckout = (
  planId: number,
  durationDays: number,
  gatewayType: string,
  subscriptionId: number,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType: "RENEW",
      renewSubscriptionId: subscriptionId,
    })
    .then((r) => r.data);

export const createUpgradeCheckout = (
  planId: number,
  durationDays: number,
  gatewayType: string,
  subscriptionId: number,
) =>
  apiClient
    .post<CheckoutResult>("/payments/checkout", {
      planId,
      durationDays,
      gatewayType,
      purchaseType: "UPGRADE",
      renewSubscriptionId: subscriptionId,
    })
    .then((r) => r.data);
