/**
 * Durable AI-chat conversation memory.
 *
 * Persists per-conversation history in Redis with a sliding TTL, so the
 * assistant remembers a user's conversation across process restarts and is
 * consistent between the api and worker processes (both share one Redis).
 *
 * When Redis is unavailable (dev / degraded), it falls back to an in-process
 * Map with lazy TTL eviction so the feature still works — just not durably.
 *
 * The store is keyed by an OWNER-BOUND scope (`<ownerKey>::<conversationId>`),
 * so one user can never read or append to another user's memory.
 */
import type { Redis } from "ioredis";

import { aiChatMemoryKey, aiChatUserMemoryKey, TTL } from "../../infrastructure/redis/keys.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface StoredConversation {
  messages: ChatTurn[];
  updatedAt: number;
}

export interface ConversationMemoryOptions {
  /** Sliding TTL for a conversation, in seconds. */
  readonly ttlSeconds?: number;
  /** Keep at most this many most-recent messages per conversation. */
  readonly maxMessages?: number;
  /** Cap on in-memory fallback entries (evict oldest beyond this). */
  readonly maxFallbackConversations?: number;
}

export class ConversationMemory {
  private readonly ttlSeconds: number;
  private readonly maxMessages: number;
  private readonly maxFallback: number;
  private readonly fallback = new Map<string, StoredConversation>();

  public constructor(
    private readonly redis: Redis | null,
    options: ConversationMemoryOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? TTL.AI_CHAT_MEMORY;
    this.maxMessages = options.maxMessages ?? 20;
    this.maxFallback = options.maxFallbackConversations ?? 5_000;
  }

  /** Load the stored history for a scope (empty when none / expired). */
  public async get(scope: string): Promise<ChatTurn[]> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(aiChatMemoryKey(scope));
        if (!raw) return [];
        const parsed = JSON.parse(raw) as StoredConversation;
        return Array.isArray(parsed.messages) ? parsed.messages : [];
      } catch {
        // Fall through to the in-memory fallback on any Redis/JSON error.
      }
    }
    return this.getFallback(scope);
  }

  /** Append turns, trim to the most-recent `maxMessages`, refresh the TTL. */
  public async append(scope: string, turns: ChatTurn[]): Promise<void> {
    const existing = await this.get(scope);
    const merged = [...existing, ...turns];
    const trimmed = merged.slice(-this.maxMessages);
    const record: StoredConversation = { messages: trimmed, updatedAt: Date.now() };

    if (this.redis) {
      try {
        await this.redis.set(
          aiChatMemoryKey(scope),
          JSON.stringify(record),
          "EX",
          this.ttlSeconds,
        );
        return;
      } catch {
        // Fall through to the in-memory fallback.
      }
    }
    this.setFallback(scope, record);
  }

  // ── In-memory fallback (lazy TTL eviction) ─────────────────────────────────
  private getFallback(scope: string): ChatTurn[] {
    this.pruneFallback();
    return this.fallback.get(scope)?.messages ?? [];
  }

  private setFallback(scope: string, record: StoredConversation): void {
    this.pruneFallback();
    if (!this.fallback.has(scope) && this.fallback.size >= this.maxFallback) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, c] of this.fallback) {
        if (c.updatedAt < oldestAt) {
          oldestAt = c.updatedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.fallback.delete(oldestKey);
    }
    this.fallback.set(scope, record);
  }

  private pruneFallback(): void {
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    for (const [k, c] of this.fallback) {
      if (c.updatedAt < cutoff) this.fallback.delete(k);
    }
  }
}

/**
 * Long-term per-user memory: a compact, operator-safe summary of durable facts
 * about a user (app/platform used, plan, open questions, resolved issues) that
 * the assistant injects as context on future conversations. Owner-bound and
 * secret/PII-free by construction (the summariser prompt forbids sensitive
 * data). Persisted in Redis with a long sliding TTL; in-memory fallback.
 */
export interface UserMemoryRecord {
  /** The compact memory note (may be empty when nothing worth storing). */
  summary: string;
  /** Turns accumulated since the summary was last refreshed (throttle counter). */
  turnsSinceUpdate: number;
  updatedAt: number;
}

const EMPTY_USER_MEMORY: UserMemoryRecord = { summary: "", turnsSinceUpdate: 0, updatedAt: 0 };

export class UserMemory {
  private readonly ttlSeconds: number;
  private readonly maxSummaryChars: number;
  private readonly fallback = new Map<string, UserMemoryRecord>();

  public constructor(
    private readonly redis: Redis | null,
    options: { ttlSeconds?: number; maxSummaryChars?: number } = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? TTL.AI_CHAT_USER_MEMORY;
    this.maxSummaryChars = options.maxSummaryChars ?? 1_200;
  }

  public async get(ownerKey: string): Promise<UserMemoryRecord> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(aiChatUserMemoryKey(ownerKey));
        if (!raw) return { ...EMPTY_USER_MEMORY };
        const parsed = JSON.parse(raw) as UserMemoryRecord;
        return {
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          turnsSinceUpdate:
            typeof parsed.turnsSinceUpdate === "number" ? parsed.turnsSinceUpdate : 0,
          updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
        };
      } catch {
        // Fall through to fallback.
      }
    }
    return this.fallback.get(ownerKey) ?? { ...EMPTY_USER_MEMORY };
  }

  public async save(ownerKey: string, record: UserMemoryRecord): Promise<void> {
    const bounded: UserMemoryRecord = {
      summary: record.summary.slice(0, this.maxSummaryChars),
      turnsSinceUpdate: record.turnsSinceUpdate,
      updatedAt: Date.now(),
    };
    if (this.redis) {
      try {
        await this.redis.set(
          aiChatUserMemoryKey(ownerKey),
          JSON.stringify(bounded),
          "EX",
          this.ttlSeconds,
        );
        return;
      } catch {
        // Fall through to fallback.
      }
    }
    this.fallback.set(ownerKey, bounded);
  }
}
