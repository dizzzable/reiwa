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
    subscriptionQueryKeys.actionPolicyRoot,
  ],
  "subscription.deleted": [
    ["trial", "eligibility"],
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    subscriptionQueryKeys.actionPolicyRoot,
    ["devices"],
  ],
  "subscription.renewed": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    subscriptionQueryKeys.actionPolicyRoot,
  ],
  "subscription.expired": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    subscriptionQueryKeys.actionPolicyRoot,
    ["activity", "notifications"],
  ],
  "subscription.upgraded": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    subscriptionQueryKeys.actionPolicyRoot,
  ],
  // `all` is the list the dashboard carousel actually reads, so without it a
  // trial granted outside the cabinet (bot, admin, quest reward) never showed up
  // until a reload. Eligibility is cached for a minute and flips on a grant.
  "subscription.trial_granted": [
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    subscriptionQueryKeys.actionPolicyRoot,
    ["trial", "eligibility"],
    ["session"],
  ],
  "payment.completed": [
    ["activity", "transactions"],
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.all,
    subscriptionQueryKeys.actionPolicyRoot,
    ["session"],
  ],
  "payment.failed": [["activity", "transactions"]],
  "promocode.activated": [
    ["activity", "transactions"],
    subscriptionQueryKeys.detail,
  ],
  "referral.qualified": [["referrals"]],
  "referral.reward_issued": [["referrals"], ["session"]],
  // A DEVICE UNBOUND SERVER-SIDE, and the reason it is here rather than only in
  // the copy file: this map is not just a list of what to refetch, it is the
  // list of event names `useUserRealtime` registers an SSE listener for. The
  // panel has been sending `user_hwid_revoked` all along; the browser dispatches
  // a named event only on a matching listener and never on the generic
  // `message` handler, so every one of those frames was dropped on the floor.
  //
  // What that cost: unbinding a device from the panel produced no toast and no
  // device-list refresh in the cabinet, and the neutral sentence the panel
  // added for this event — plus both translations of it — were dead code that
  // nothing could reach.
  "user_hwid_revoked": [
    ["devices"],
    subscriptionQueryKeys.detail,
    subscriptionQueryKeys.actionPolicyRoot,
  ],
};
