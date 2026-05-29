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

export const getReferralSummary = () =>
  apiClient.get<ReferralSummary>("/referrals/summary").then((r) => r.data);

export const getInviteCapacity = () =>
  apiClient.get<InviteCapacity>("/referrals/invite-capacity").then((r) => r.data);

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

export const exchangePoints = (
  type: string,
  points: number,
  subscriptionId?: number,
) =>
  apiClient
    .post("/referrals/exchange", { type, points, subscriptionId })
    .then((r) => r.data);
