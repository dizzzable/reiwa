import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { invalidatePaymentReturnSuccessQueries } from "../src/features/payment/payment-return-page";
import { subscriptionQueryKeys } from "../src/lib/subscription-query-keys";

describe("payment return query invalidation", () => {
  it("invalidates a cached trial policy after upgrade succeeds", async () => {
    const queryClient = new QueryClient();
    const trialPolicyKey = subscriptionQueryKeys.actionPolicy("trial-subscription");
    queryClient.setQueryData(trialPolicyKey, { canRenew: false });

    expect(queryClient.getQueryState(trialPolicyKey)?.isInvalidated).toBe(false);

    await invalidatePaymentReturnSuccessQueries(queryClient);

    expect(queryClient.getQueryState(trialPolicyKey)?.isInvalidated).toBe(true);
  });
});
