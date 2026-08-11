import express from "express";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createOlcrtcRouter } from "../../src/api/routes/olcrtc.js";

function makeApp(methods: {
  getSubscription?: (identity: Record<string, unknown>) => Promise<unknown>;
  provisionSubscription?: (identity: Record<string, unknown>) => Promise<unknown>;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.webSession = { userId: "user-cuid-1", createdAt: 0, ip: "127.0.0.1", lastActivity: 0 };
    next();
  });
  app.use(
    "/api/v1",
    createOlcrtcRouter({
      adminClient: { olcrtc: methods } as never,
      sessionStore: null,
    }),
  );
  return app;
}

async function request(
  app: express.Express,
  path: string,
  method: "GET" | "POST",
): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: data ? JSON.parse(data) : null,
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

describe("olcrtc route", () => {
  it("forwards subscription lookups with the current web identity", async () => {
    const getSubscription = vi.fn(async () => ({
      enabled: true,
      eligible: true,
      status: "READY",
      subscription: { url: "olcrtc://example" },
    }));

    const response = await request(
      makeApp({ getSubscription }),
      "/api/v1/olcrtc/subscription",
      "GET",
    );

    expect(response.status).toBe(200);
    expect(getSubscription).toHaveBeenCalledWith({ userId: "user-cuid-1" });
    expect(response.body).toMatchObject({ status: "READY" });
  });

  it("forwards idempotent provisioning with the current web identity", async () => {
    const provisionSubscription = vi.fn(async () => ({
      enabled: true,
      eligible: true,
      status: "UNAVAILABLE",
      reason: "no_active_gateway",
      subscription: null,
    }));

    const response = await request(
      makeApp({ provisionSubscription }),
      "/api/v1/olcrtc/subscription/provision",
      "POST",
    );

    expect(response.status).toBe(200);
    expect(provisionSubscription).toHaveBeenCalledWith({ userId: "user-cuid-1" });
    expect(response.body).toMatchObject({ reason: "no_active_gateway" });
  });
}
);
