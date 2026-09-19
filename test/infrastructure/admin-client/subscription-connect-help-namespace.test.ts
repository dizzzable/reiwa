import { describe, expect, it, vi } from "vitest";

import { SubscriptionNamespace } from "../../../src/infrastructure/admin-client/namespaces/subscription.js";

/**
 * The call behind × on «Не получилось подключиться?».
 *
 * The path is half of a contract whose other half lives in the panel
 * (`POST /internal/user/:userRef/subscriptions/:subscriptionId/connect-help/
 * dismiss`, under the panel's `/api` prefix), and a typo in either half is
 * silent: the BFF reads the panel's 404 as "a panel older than the banner" and
 * answers the browser `{ dismissed: false }`, so the banner is hidden on this
 * screen and comes back on every other device, for ever, with nothing in any
 * log. The literal is pinned here for that reason.
 */

function fakeTransport() {
  const request = vi.fn(async () => ({ ok: true }));
  return { request } as unknown as { request: ReturnType<typeof vi.fn> };
}

describe("SubscriptionNamespace.dismissConnectHelp", () => {
  it("POSTs to the panel's path for that user and subscription, with no body", async () => {
    const transport = fakeTransport();

    await new SubscriptionNamespace(transport as never).dismissConnectHelp(
      { userId: "cmuser0001" },
      "cmsub0001",
    );

    expect(transport.request).toHaveBeenCalledTimes(1);
    const call = transport.request.mock.calls[0] as unknown[];
    expect(call[0]).toBe("POST");
    expect(call[1]).toBe("/api/internal/user/cmuser0001/subscriptions/cmsub0001/connect-help/dismiss");
    // A body an older panel's DTO has not learned is a 400, not an ignored field.
    expect(call[2]).toBeUndefined();
    expect(call[3]).toBeUndefined();
  });

  it("addresses a Telegram-only customer by telegramId", async () => {
    const transport = fakeTransport();

    await new SubscriptionNamespace(transport as never).dismissConnectHelp({ telegramId: "4242" }, "cmsub0001");

    expect((transport.request.mock.calls[0] as unknown[])[1]).toBe(
      "/api/internal/user/4242/subscriptions/cmsub0001/connect-help/dismiss",
    );
  });

  it("encodes both path segments", async () => {
    const transport = fakeTransport();

    await new SubscriptionNamespace(transport as never).dismissConnectHelp({ userId: "a/b" }, "c?d");

    expect((transport.request.mock.calls[0] as unknown[])[1]).toBe(
      "/api/internal/user/a%2Fb/subscriptions/c%3Fd/connect-help/dismiss",
    );
  });

  it("refuses to call anybody without an identity", () => {
    const transport = fakeTransport();

    expect(() => new SubscriptionNamespace(transport as never).dismissConnectHelp({}, "cmsub0001")).toThrow();
    expect(transport.request).not.toHaveBeenCalled();
  });
});
