/**
 * An in-process stand-in for what the channel-gate store reads and issues:
 * `status`, `connect()`, `EXISTS`, `SET … PX <ms> [NX]` and `DEL` — plus `on`, so a
 * spec can prove the store never adds a listener to a client it does not own.
 *
 * Expiry follows `Date.now()`, so a spec moves it with `vi.setSystemTime`. Two
 * store instances handed the same `FakeRedis` behave like two processes sharing
 * one server — which is the property the alert throttle and the passes of
 * «Перепроверять подписку» OFF exist for.
 */
import type { Redis } from 'ioredis';

export interface FakeRedisCall {
  readonly command: string;
  readonly args: readonly unknown[];
}

export class FakeRedis {
  public readonly calls: FakeRedisCall[] = [];
  /** What ioredis reports; the store sends nothing unless it is `ready`. */
  public status: string = 'ready';
  /** While set, every command rejects with this error. */
  public failWith: Error | null = null;
  /** While set, every command waits for this before answering. */
  public gate: Promise<void> | null = null;
  public connectCalls = 0;
  public listenersAdded = 0;
  private readonly values = new Map<string, { value: string; expiresAt: number }>();

  public async connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = 'ready';
  }

  public async exists(key: string): Promise<number> {
    await this.record('exists', [key]);
    return this.live(key) === undefined ? 0 : 1;
  }

  public async set(key: string, value: string, ...options: unknown[]): Promise<'OK' | null> {
    await this.record('set', [key, value, ...options]);
    const pxAt = options.indexOf('PX');
    const ttlMs = pxAt === -1 ? Number.POSITIVE_INFINITY : Number(options[pxAt + 1]);
    if (options.includes('NX') && this.live(key) !== undefined) return null;
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  public async del(key: string): Promise<number> {
    await this.record('del', [key]);
    return this.values.delete(key) ? 1 : 0;
  }

  public on(): this {
    this.listenersAdded += 1;
    return this;
  }

  /** Remaining time to live of a key, `undefined` when absent or expired. */
  public ttlOf(key: string): number | undefined {
    const entry = this.values.get(key);
    return entry === undefined || Date.now() >= entry.expiresAt ? undefined : entry.expiresAt - Date.now();
  }

  public keys(): string[] {
    return [...this.values.keys()].filter((key) => this.live(key) !== undefined);
  }

  /** Commands issued, by name. */
  public count(command: string): number {
    return this.calls.filter((call) => call.command === command).length;
  }

  /** The seam a store takes; the fake answers only what the store uses. */
  public asRedis(): Redis {
    return this as unknown as Redis;
  }

  private async record(command: string, args: readonly unknown[]): Promise<void> {
    this.calls.push({ command, args });
    if (this.gate !== null) await this.gate;
    if (this.failWith !== null) throw this.failWith;
  }

  private live(key: string): string | undefined {
    const entry = this.values.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }
}
