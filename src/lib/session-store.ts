import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";

import type { LoggerPort } from "../application/ports/logger.port.js";

export interface ReiwaSession {
  telegramId: string;
  userId: number;
  name: string;
  username?: string;
  role: string;
  createdAt: number;
}

export interface SessionStoreOptions {
  /**
   * Optional structured logger. When omitted (legacy callers, tests),
   * Redis errors fall back to `console.error` so the operator still
   * sees the failure on stderr.
   */
  readonly logger?: LoggerPort;
}

export class SessionStore {
  private redis: Redis;
  private prefix = "reiwa:session:";
  private ttl = 7 * 24 * 60 * 60; // 7 days in seconds
  private logger: LoggerPort | undefined;

  constructor(redisUrl: string, options: SessionStoreOptions = {}) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
    this.logger = options.logger;
    this.redis.on("error", (err: Error) => {
      if (this.logger) {
        this.logger.warn({ err, component: "SessionStore" }, "Redis error");
      } else {
        // eslint-disable-next-line no-console
        console.error("[SessionStore] Redis error:", err.message);
      }
    });
  }

  /**
   * Establish the Redis connection. Rejects on failure so the caller can
   * decide whether to fail-closed (production) or boot in degraded mode
   * (`REIWA_ALLOW_DEGRADED` / non-production). Transient post-connect
   * errors are surfaced separately via the `error` event handler above.
   */
  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }

  async create(data: Omit<ReiwaSession, "createdAt">): Promise<string> {
    const sessionId = uuidv4();
    const session: ReiwaSession = { ...data, createdAt: Date.now() };
    await this.redis.set(
      `${this.prefix}${sessionId}`,
      JSON.stringify(session),
      "EX",
      this.ttl,
    );
    return sessionId;
  }

  async get(sessionId: string): Promise<ReiwaSession | null> {
    const raw = await this.redis.get(`${this.prefix}${sessionId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReiwaSession;
    } catch {
      return null;
    }
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${sessionId}`);
  }

  async refresh(sessionId: string): Promise<void> {
    await this.redis.expire(`${this.prefix}${sessionId}`, this.ttl);
  }
}
