import { describe, expect, it, vi } from "vitest";

import { executeSubscriptionDeleteWithAmbiguousRetry } from "../../web/src/features/dashboard/subscription-delete-policy.js";

describe("subscription delete ambiguity policy", () => {
  it("returns the first explicit success without retrying", async () => {
    const operation = vi.fn().mockResolvedValue({ deleted: true });

    await expect(
      executeSubscriptionDeleteWithAmbiguousRetry(
        operation,
        () => false,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries one transport-ambiguous failure", async () => {
    const ambiguous = new Error("response lost");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({ deleted: true });

    await expect(
      executeSubscriptionDeleteWithAmbiguousRetry(
        operation,
        (error) => error === ambiguous,
      ),
    ).resolves.toEqual({ deleted: true });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry an explicit server failure", async () => {
    const explicit = new Error("403");
    const operation = vi.fn().mockRejectedValue(explicit);

    await expect(
      executeSubscriptionDeleteWithAmbiguousRetry(
        operation,
        () => false,
      ),
    ).rejects.toBe(explicit);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
