import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";

import type { ChatMemberApi } from "../src/bot/lib/channel-gate.js";
import { createContestsRouter } from "../src/api/routes/contests.js";
import { ContestsNamespace } from "../src/infrastructure/admin-client/namespaces/contests.js";

/**
 * Entering a contest that needs a channel (29.10.2026).
 *
 * The panel has no bot token: it refuses the first entry with the chat to ask
 * about and the person's Telegram id, this route asks Telegram once, and
 * enters again with the answer. What reaches the browser is the reason and
 * the link to join — never the chat id or the Telegram id.
 */

const USER = "cabinetuser0000000000001";
const ASK = { chatId: "@contest_news", joinUrl: "https://t.me/contest_news", telegramId: "123456789" };

interface EnterCall {
  readonly contestId: string;
  readonly channelMember: boolean | null | undefined;
}

function fakeAdmin(needsChannel = true) {
  const calls: EnterCall[] = [];
  const contests = {
    list: async () => [],
    enter: async (_identity: unknown, contestId: string, channelMember?: boolean | null) => {
      calls.push({ contestId, channelMember });
      if (needsChannel && channelMember === undefined) {
        return { entered: false, reason: "CHANNEL_REQUIRED", channel: ASK };
      }
      if (channelMember === false) return { entered: false, reason: "CHANNEL_REQUIRED", channel: ASK };
      return { entered: true, reason: null };
    },
  };
  return { adminClient: { contests } as never, calls };
}

function telegramSaying(answer: "member" | "left" | "down"): { api: ChatMemberApi; asked: Array<[string, number]> } {
  const asked: Array<[string, number]> = [];
  return {
    asked,
    api: {
      getChatMember: async (chatId: string, userId: number) => {
        asked.push([chatId, userId]);
        if (answer === "down") throw new Error("ECONNRESET");
        return { status: answer } as never;
      },
    },
  };
}

function app(adminClient: never, chatMemberApi: ChatMemberApi | null): express.Express {
  const server = express();
  server.use(express.json());
  // What the global session middleware leaves for a signed-in cabinet user.
  server.use((req, _res, next) => {
    (req as unknown as { webSession: { userId: string } }).webSession = { userId: USER };
    next();
  });
  server.use("/api/v1", createContestsRouter({ adminClient, sessionStore: null, config: {} as never, chatMemberApi }));
  return server;
}

async function post(server: express.Express, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const listener = http.createServer(server);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as { port: number };
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": 2 } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

describe("entering a contest that needs a channel", () => {
  it("asks Telegram about the panel's chat and person, and enters with a yes", async () => {
    const { adminClient, calls } = fakeAdmin();
    const telegram = telegramSaying("member");

    const res = await post(app(adminClient, telegram.api), "/api/v1/contests/c1/enter");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entered: true, reason: null });
    expect(telegram.asked).toEqual([["@contest_news", 123456789]]);
    expect(calls.map((call) => call.channelMember)).toEqual([undefined, true]);
  });

  it("passes a no on, with the link to join and nothing else", async () => {
    const { adminClient, calls } = fakeAdmin();

    const res = await post(app(adminClient, telegramSaying("left").api), "/api/v1/contests/c1/enter");

    expect(res.body).toEqual({ entered: false, reason: "CHANNEL_REQUIRED", joinUrl: ASK.joinUrl });
    expect(JSON.stringify(res.body)).not.toContain(ASK.telegramId);
    expect(JSON.stringify(res.body)).not.toContain(ASK.chatId);
    expect(calls.map((call) => call.channelMember)).toEqual([undefined, false]);
  });

  it("tells the panel Telegram could not be asked when Telegram is down", async () => {
    const { adminClient, calls } = fakeAdmin();

    const res = await post(app(adminClient, telegramSaying("down").api), "/api/v1/contests/c1/enter");

    expect(res.body).toEqual({ entered: true, reason: null });
    expect(calls.map((call) => call.channelMember)).toEqual([undefined, null]);
  });

  it("tells the panel the same without a bot token", async () => {
    const { adminClient, calls } = fakeAdmin();

    await post(app(adminClient, null), "/api/v1/contests/c1/enter");

    expect(calls.map((call) => call.channelMember)).toEqual([undefined, null]);
  });

  it("asks nothing of Telegram for a contest without a channel", async () => {
    const { adminClient, calls } = fakeAdmin(false);
    const telegram = telegramSaying("member");

    const res = await post(app(adminClient, telegram.api), "/api/v1/contests/c1/enter");

    expect(res.body).toEqual({ entered: true, reason: null });
    expect(telegram.asked).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("the contests client", () => {
  function recording() {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const transport = {
      request: async (method: string, path: string, body?: unknown) => {
        requests.push({ method, path, body });
        return [];
      },
    };
    return { namespace: new ContestsNamespace(transport as never), requests };
  }

  it("asks for everybody's results, so finished contests show their winners", async () => {
    const { namespace, requests } = recording();
    await namespace.list({ userId: USER } as never);
    expect(requests[0]?.path).toBe(`/api/internal/contests/${USER}?results=all`);
  });

  it("sends Telegram's answer only when there is one", async () => {
    const { namespace, requests } = recording();
    await namespace.enter({ userId: USER } as never, "c1");
    await namespace.enter({ userId: USER } as never, "c1", null);
    expect(requests.map((request) => request.body)).toEqual([{}, { channelMember: null }]);
  });
});
