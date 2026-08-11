import { describe, expect, it } from "vitest";

import { OlcrtcNamespace } from "../../../src/infrastructure/admin-client/namespaces/olcrtc.js";

function namespaceWith(request: (method: string, path: string) => Promise<unknown>) {
  const calls: Array<{ method: string; path: string }> = [];
  const transport = {
    request: async (method: string, path: string) => {
      calls.push({ method, path });
      return request(method, path);
    },
  };
  return { namespace: new OlcrtcNamespace(transport as never), calls };
}

describe("OlcrtcNamespace", () => {
  it("loads the current user's subscription by reiwa_id", async () => {
    const { namespace, calls } = namespaceWith(async () => ({ status: "READY" }));

    await namespace.getSubscription({ userId: "user-7", telegramId: "123" });

    expect(calls[0]).toEqual({
      method: "GET",
      path: "/api/internal/olcrtc/subscription?userId=user-7",
    });
  });

  it("provisions using telegramId when no reiwa_id is available", async () => {
    const { namespace, calls } = namespaceWith(async () => ({ status: "UNAVAILABLE" }));

    await namespace.provisionSubscription({ telegramId: "123" });

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/internal/olcrtc/subscription/provision?telegramId=123",
    });
  });
});
