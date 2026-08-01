import { afterEach, describe, expect, it, vi } from "vitest";

import { getActionPolicy } from "../../web/src/lib/api-client/subscription.js";
import { apiClient } from "../../web/src/lib/api-client/transport.js";

describe("subscription action-policy API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the selected subscriptionId instead of the obsolete planId", async () => {
    const policy = {
      canBuy: true,
      canRenew: false,
      canUpgrade: true,
      canTrial: false,
    };
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: policy });

    await expect(getActionPolicy("subscription-2")).resolves.toEqual(policy);
    expect(post).toHaveBeenCalledWith("/subscription/action-policy", {
      subscriptionId: "subscription-2",
    });
  });

  it("uses an empty payload for the portfolio capacity policy", async () => {
    const policy = {
      canBuy: true,
      canRenew: false,
      canUpgrade: false,
      canTrial: true,
    };
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: policy });

    await expect(getActionPolicy()).resolves.toEqual(policy);
    expect(post).toHaveBeenCalledWith("/subscription/action-policy", {});
  });
});
