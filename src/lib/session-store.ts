import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";

export interface ReiwaSession {
  telegramId: string;
  userId: number;
  name: string;
  username?: string;
  role: string;
  createdAt: number;
}

export class SessionStore {
  private redis: Redis;
  private prefix = "reiwa:session:";
  private ttl = 7 * 24 * 60 * 60; // 7 days in seconds

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
    this.redis.on("error", (err: Error) => {
      console.error("[SessionStore] Redis error:", err.message);
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect().catch((err: Error) => {
      console.error("[SessionStore] Redis connection failed:", err.message);
      console.error(
        "[SessionStore] Sessions will not work until Redis is available",
      );
    });
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
