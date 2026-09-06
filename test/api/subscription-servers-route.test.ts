import express from "express";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createSubscriptionRouter } from "../../src/api/routes/subscription.js";

/**
 * `GET /api/v1/subscription/:id/servers` — the cabinet's hop to the server list.
 *
 * WHY THIS FILE EXISTS. The panel's own spec covers the pure functions behind
 * this endpoint well, and an audit confirmed the boundary holds there. What
 * nothing covered was THIS hop, where three separate promises are made and any
 * of them could quietly stop being true:
 *
 *   1. the caller must have a session, and the identity sent upstream is the
 *      SESSION's — never anything the client supplied;
 *   2. the response is re-stated field by field here rather than forwarded, so a
 *      panel that ever widens the shape cannot reach a customer's browser
 *      through this route;
 *   3. a failure answers an empty list rather than an error, because the screen
 *      sits on top of a subscription that is working regardless.
 *
 * Each is a one-line property, and each of the three lines can be deleted
 * without any other test in either repository going red.
 */

interface ListServersSpy {
  (identity: Record<string, unknown>, subscriptionId: string): Promise<unknown>;
}

function makeApp(listServers: ListServersSpy, session: unknown = { userId: "user-cuid-1" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (session !== null) {
      req.webSession = {
        ...(session as object),
        createdAt: 0,
        ip: "127.0.0.1",
        lastActivity: 0,
      } as never;
    }
    next();
  });
  app.use(
    "/api/v1",
    createSubscriptionRouter({
      adminClient: { subscription: { listServers } } as never,
      sessionStore: null,
      config: {} as never,
    }),
  );
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path, method: "GET" },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: data.length > 0 ? JSON.parse(data) : null,
            });
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const EMPTY = { servers: [], recommendedServerId: null };

describe("GET /subscription/:id/servers", () => {
  it("refuses a caller with no session", async () => {
    const listServers = vi.fn(async () => EMPTY);
    const app = makeApp(listServers, null);
    const { status } = await get(app, "/api/v1/subscription/sub-1/servers");
    expect(status).toBe(401);
    // And it must not have asked the panel anything on the way to refusing.
    expect(listServers).not.toHaveBeenCalled();
  });

  it("sends the SESSION's identity upstream, not anything from the request", async () => {
    // The one property that makes this endpoint safe to expose. If the identity
    // ever came from a query string or a header, any signed-in customer could
    // read another's servers by editing a URL.
    const listServers = vi.fn(async () => EMPTY);
    const app = makeApp(listServers, { userId: "user-cuid-1" });
    await get(
      app,
      "/api/v1/subscription/sub-1/servers?userId=someone-else&telegramId=999",
    );
    expect(listServers).toHaveBeenCalledTimes(1);
    const [identity, subscriptionId] = listServers.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(identity.userId).toBe("user-cuid-1");
    expect(JSON.stringify(identity)).not.toContain("someone-else");
    expect(JSON.stringify(identity)).not.toContain("999");
    expect(subscriptionId).toBe("sub-1");
  });

  it("passes the subscription id from the path, verbatim", async () => {
    const listServers = vi.fn(async () => EMPTY);
    const app = makeApp(listServers);
    await get(app, "/api/v1/subscription/cmphfcr6i007v01jg0lcu653h/servers");
    expect((listServers.mock.calls[0] as unknown as unknown[])[1]).toBe(
      "cmphfcr6i007v01jg0lcu653h",
    );
  });

  it("keeps only the agreed fields when the panel sends more", async () => {
    // The failure this guards: a newer panel widening its response, and this
    // hop forwarding whatever arrives straight into a customer's browser.
    const listServers = vi.fn(async () => ({
      servers: [
        {
          id: "host-1",
          name: "Frankfurt 🇩🇪",
          flag: "🇩🇪",
          countryCode: "DE",
          status: "online",
          uptimeSeconds: 86_400,
          usersOnline: 7,
          address: "de1.internal.example",
          port: 443,
          nodeName: "de-1.hetzner",
          ips: ["203.0.113.10"],
        },
      ],
      recommendedServerId: "host-1",
    }));
    const app = makeApp(listServers);
    const { body } = await get(app, "/api/v1/subscription/sub-1/servers");

    const serialized = JSON.stringify(body);
    for (const secret of [
      "de1.internal.example",
      "de-1.hetzner",
      "203.0.113.10",
      "443",
    ]) {
      expect(serialized, `\`${secret}\` reached the browser`).not.toContain(secret);
    }
    const [row] = (body as { servers: Record<string, unknown>[] }).servers;
    expect(Object.keys(row).sort()).toEqual([
      "countryCode",
      "flag",
      "id",
      "name",
      "status",
      "uptimeSeconds",
      "usersOnline",
    ]);
    expect(row.name).toBe("Frankfurt 🇩🇪");
  });

  it("answers an empty list when the panel is unreachable", async () => {
    const listServers = vi.fn(async () => {
      throw new Error("panel down: 502 from https://panel.internal/api/...");
    });
    const app = makeApp(listServers);
    const { status, body } = await get(app, "/api/v1/subscription/sub-1/servers");
    expect(status).toBe(200);
    expect(body).toEqual(EMPTY);
    // The upstream message embeds the panel's own address and response body;
    // none of it may travel outward.
    expect(JSON.stringify(body)).not.toContain("panel.internal");
  });

  it("answers an empty list when the panel sends something unusable", async () => {
    for (const nonsense of [null, undefined, "", 42, [], { servers: "no" }]) {
      const app = makeApp(vi.fn(async () => nonsense));
      const { status, body } = await get(app, "/api/v1/subscription/sub-1/servers");
      expect(status).toBe(200);
      expect(body).toEqual(EMPTY);
    }
  });
});
