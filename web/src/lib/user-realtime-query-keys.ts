import { subscriptionQueryKeys } from "./subscription-query-keys.js";

export type UserRealtimeQueryKey = readonly string[];

/**
 * User realtime events mapped to the caches whose server state may have
 * changed. Kept separate from the React hook so the contract stays pure and
 * can be covered without a DOM environment.
 */
export const userRealtimeQueryKeysByType: Readonly<
  Record<string, readonly UserRealtimeQueryKey[]>
> = {
  "subscription.created": [
    ["session"],
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
  ],
  "subscription.deleted": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    ["action-policy"],
    ["devices"],
  ],
  "subscription.renewed": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
  ],
  "subscription.expired": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    ["activity", "notifications"],
  ],
  "subscription.upgraded": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
  ],
  "subscription.trial_granted": [subscriptionQueryKeys.detail, ["session"]],
  "payment.completed": [
    ["activity", "transactions"],
    subscriptionQueryKeys.detail,
    ["session"],
  ],
  "payment.failed": [["activity", "transactions"]],
  "promocode.activated": [
    ["activity", "transactions"],
    subscriptionQueryKeys.detail,
  ],
  "referral.qualified": [["referrals"]],
  "referral.reward_issued": [["referrals"], ["session"]],
};
