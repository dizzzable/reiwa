/**
 * Referrals namespace — invites, summary, rewards, points exchange.
 */
import { apiClient } from "./transport.js";
import type {
  ReferralInvite,
  ReferralRewardsResponse,
  ReferralSummary,
} from "@/types/api";

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

export interface InviteCapacity {
  totalSlots: number | null;
  usedSlots: number;
  remainingSlots: number | null;
  canCreateInvite: boolean;
}

export interface InvitedUser {
  id: string;
  label: string;
  qualified: boolean;
  invitedAt: string;
}

export interface InvitedUsersResponse {
  items: InvitedUser[];
  total: number;
  page: number;
  limit: number;
}

export const getReferralSummary = () =>
  apiClient.get<ReferralSummary>("/referrals/summary").then((r) => r.data);

export const getInviteCapacity = () =>
  apiClient.get<InviteCapacity>("/referrals/invite-capacity").then((r) => r.data);

export const getInvitedUsers = (page = 1, limit = 20) =>
  apiClient
    .get<InvitedUsersResponse>("/referrals/invited", { params: { page, limit } })
    .then((r) => r.data);

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

export const getPointsExchangeOptions = () =>
  apiClient
    .get<PointsExchangeOptions>("/referrals/exchange/options")
    .then((r) => r.data);

/**
 * Every way a points balance can move. Mirrored from the panel's ledger
 * enum — a value outside this union means the panel is NEWER than this
 * build, so renderers must fall back rather than assume.
 */
export type PointsLedgerSource =
  | "CASHBACK"
  | "CASHBACK_REVERSED"
  | "REFERRAL_REWARD"
  | "REFERRAL_REWARD_REVOKED"
  | "QUEST_REWARD"
  | "EXCHANGE"
  | "MANUAL_ADJUSTMENT"
  | "ACCOUNT_MERGE"
  | "IMPORT"
  | "OPENING_BALANCE";

export interface PointsLedgerEntry {
  id: string;
  /** Signed: positive credits, negative debits. */
  delta: number;
  balanceAfter: number;
  source: PointsLedgerSource;
  referenceKey: string | null;
  /**
   * Free-form per-source payload. Deliberately `unknown`: the shapes differ
   * by source, older panels omit fields, and MANUAL_ADJUSTMENT carries
   * operator-only keys (`note`, `adminId`) that must never reach the
   * subscriber. Read it defensively at the render site.
   */
  details: unknown;
  createdAt: string;
}

export interface PointsLedgerPage {
  items: PointsLedgerEntry[];
  /** Opaque keyset cursor; `null` on the last page. */
  nextCursor: string | null;
}

export const getPointsLedger = (cursor?: string | null, limit = 20) =>
  apiClient
    .get<PointsLedgerPage>("/referrals/points/ledger", {
      params: { cursor: cursor ?? undefined, limit },
    })
    .then((r) => r.data);

export interface ExchangePointsResult {
  readonly success: boolean;
  readonly message?: string;
  readonly value?: number;
  /** Single-use promo code minted by a GIFT_SUBSCRIPTION exchange. */
  readonly code?: string;
  /** Reward is committed locally and its Remnawave sync job is pending. */
  readonly syncPending?: boolean;
  readonly error?: string;
}

export const exchangePoints = (
  type: string,
  points: number,
  subscriptionId?: string,
  idempotencyKey?: string,
) =>
  apiClient
    .post<ExchangePointsResult>("/referrals/exchange", {
      type,
      points,
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
    .then((r) => r.data);
