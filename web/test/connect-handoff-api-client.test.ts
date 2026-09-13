import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyConnectHandoff } from "@/lib/api-client/connect-page";
import { apiClient } from "@/lib/api-client/transport";

/**
 * THE SIGNATURE CHECK SENDS TWO FIELDS, WHATEVER IT IS HANDED.
 *
 * `/connect/open` holds the subscription url and the deep link in its fragment
 * and must never put either in a request (`connect-trampoline.ts`). The page
 * builds the call from a digest and a signature today; this pins the transport
 * half, so that a caller which one day passes the whole payload still sends
 * nothing but those two.
 */

const DIGEST = "PM4RB4PB63xvWfDaxJ3mCa1LmXcS-9zQZ9ztaQOuMiU";
const SIGNATURE = "0q0EVtTmeAZtN1hAS6FIHMEp9upFASpBB7mUNL77xBY";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyConnectHandoff", () => {
  it("posts the digest and the signature to the verify route, and not one field more", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { valid: true } });
    // Everything a careless caller could pass along.
    const handed = {
      digest: DIGEST,
      signature: SIGNATURE,
      subscriptionUrl: "https://sub.example.test/s/AbC123",
      link: "happ://add/https://sub.example.test/s/AbC123",
    };

    await expect(verifyConnectHandoff(handed)).resolves.toEqual({ valid: true });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual(["/connect/handoff/verify", { digest: DIGEST, signature: SIGNATURE }]);
  });
});
