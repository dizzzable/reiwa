import { describe, it, expect } from "vitest";

import {
  ConversationMemory,
  UserMemory,
  type ChatTurn,
} from "../../src/core/ai/conversation-memory.js";

const turn = (role: "user" | "assistant", content: string): ChatTurn => ({ role, content });

describe("ConversationMemory (in-memory fallback, redis=null)", () => {
  it("append then get round-trips the history", async () => {
    const mem = new ConversationMemory(null);
    await mem.append("u1::c1", [turn("user", "hi"), turn("assistant", "hello")]);
    expect(await mem.get("u1::c1")).toEqual([turn("user", "hi"), turn("assistant", "hello")]);
  });

  it("keeps only the most-recent maxMessages", async () => {
    const mem = new ConversationMemory(null, { maxMessages: 4 });
    for (let i = 0; i < 5; i++) {
      await mem.append("u1::c1", [turn("user", `q${i}`), turn("assistant", `a${i}`)]);
    }
    const history = await mem.get("u1::c1");
    expect(history).toHaveLength(4);
    expect(history[0]).toEqual(turn("user", "q3"));
    expect(history[3]).toEqual(turn("assistant", "a4"));
  });

  it("isolates conversations by owner-bound scope", async () => {
    const mem = new ConversationMemory(null);
    await mem.append("owner-a::c1", [turn("user", "secret A")]);
    await mem.append("owner-b::c1", [turn("user", "secret B")]);
    expect(await mem.get("owner-a::c1")).toEqual([turn("user", "secret A")]);
    expect(await mem.get("owner-b::c1")).toEqual([turn("user", "secret B")]);
  });

  it("returns empty history for an unknown scope", async () => {
    const mem = new ConversationMemory(null);
    expect(await mem.get("nobody::none")).toEqual([]);
  });
});

describe("ConversationMemory (Redis path, mocked)", () => {
  function mockRedis() {
    const store = new Map<string, string>();
    const calls: Array<{ op: string; key: string; ttl?: number }> = [];
    return {
      store,
      calls,
      redis: {
        get: async (key: string) => {
          calls.push({ op: "get", key });
          return store.get(key) ?? null;
        },
        set: async (key: string, value: string, _mode: string, ttl: number) => {
          calls.push({ op: "set", key, ttl });
          store.set(key, value);
          return "OK";
        },
      },
    };
  }

  it("persists to Redis with a TTL and reads it back", async () => {
    const m = mockRedis();
    const mem = new ConversationMemory(m.redis as never, { ttlSeconds: 123 });
    await mem.append("u1::c1", [turn("user", "hi"), turn("assistant", "yo")]);

    // Stored under the owner-bound key with the configured TTL.
    const setCall = m.calls.find((c) => c.op === "set");
    expect(setCall?.key).toBe("ai_chat:conv:u1::c1");
    expect(setCall?.ttl).toBe(123);

    expect(await mem.get("u1::c1")).toEqual([turn("user", "hi"), turn("assistant", "yo")]);
  });

  it("falls back to empty (not a throw) when Redis get returns malformed JSON", async () => {
    const m = mockRedis();
    m.store.set("ai_chat:conv:u1::c1", "{not-json");
    const mem = new ConversationMemory(m.redis as never);
    // Malformed → caught → in-memory fallback (empty), never throws to the caller.
    expect(await mem.get("u1::c1")).toEqual([]);
  });
});

describe("UserMemory (long-term per-user summary)", () => {
  it("returns empty record for an unknown user (fallback)", async () => {
    const mem = new UserMemory(null);
    expect(await mem.get("owner-x")).toEqual({ summary: "", turnsSinceUpdate: 0, updatedAt: 0 });
  });

  it("saves and reads back a summary (fallback)", async () => {
    const mem = new UserMemory(null);
    await mem.save("owner-x", { summary: "uses iOS app", turnsSinceUpdate: 0, updatedAt: 0 });
    const rec = await mem.get("owner-x");
    expect(rec.summary).toBe("uses iOS app");
    expect(rec.turnsSinceUpdate).toBe(0);
  });

  it("bounds the summary length on save", async () => {
    const mem = new UserMemory(null, { maxSummaryChars: 10 });
    await mem.save("owner-x", { summary: "x".repeat(50), turnsSinceUpdate: 1, updatedAt: 0 });
    expect((await mem.get("owner-x")).summary).toHaveLength(10);
  });

  it("isolates memory by owner (no cross-user leak)", async () => {
    const mem = new UserMemory(null);
    await mem.save("owner-a", { summary: "A facts", turnsSinceUpdate: 0, updatedAt: 0 });
    await mem.save("owner-b", { summary: "B facts", turnsSinceUpdate: 0, updatedAt: 0 });
    expect((await mem.get("owner-a")).summary).toBe("A facts");
    expect((await mem.get("owner-b")).summary).toBe("B facts");
  });

  it("persists to Redis under the owner key with a TTL", async () => {
    const store = new Map<string, string>();
    const calls: Array<{ op: string; key: string; ttl?: number }> = [];
    const redis = {
      get: async (key: string) => {
        calls.push({ op: "get", key });
        return store.get(key) ?? null;
      },
      set: async (key: string, value: string, _mode: string, ttl: number) => {
        calls.push({ op: "set", key, ttl });
        store.set(key, value);
        return "OK";
      },
    };
    const mem = new UserMemory(redis as never, { ttlSeconds: 999 });
    await mem.save("owner-a", { summary: "note", turnsSinceUpdate: 2, updatedAt: 0 });
    const setCall = calls.find((c) => c.op === "set");
    expect(setCall?.key).toBe("ai_chat:memory:owner-a");
    expect(setCall?.ttl).toBe(999);
    expect((await mem.get("owner-a")).summary).toBe("note");
  });
});
