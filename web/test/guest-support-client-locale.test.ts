/**
 * The guest page's language on its way to the BFF: in the body of the request
 * that opens a conversation and of each reply. The BFF relays it to the panel
 * as a header; without it the panel writes the guest's letters in Russian.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn(async () => ({ data: {} })));

vi.mock("@/lib/api-client/transport.js", () => ({ apiClient: { post } }));
vi.mock("@/lib/device-signals", () => ({
  collectDeviceSignals: async () => ({ installId: "install-1", deviceHash: "device-1" }),
}));

import { createGuestTicket, replyGuestConversation } from "@/lib/api-client/support";

afterEach(() => post.mockClear());

describe("the guest page's language in its requests", () => {
  it("goes with the message that opens a conversation", async () => {
    await createGuestTicket({ subject: "s", message: "m", locale: "en" });
    expect(post).toHaveBeenCalledWith("/support/guest", expect.objectContaining({ subject: "s", locale: "en" }));
  });

  it("goes with each reply, and nothing is sent when there is none", async () => {
    await replyGuestConversation("hello", undefined, "ru");
    await replyGuestConversation("again");
    expect(post.mock.calls[0]).toEqual(["/support/guest/reply", { content: "hello", locale: "ru" }]);
    expect(post.mock.calls[1]).toEqual(["/support/guest/reply", { content: "again" }]);
  });
});
