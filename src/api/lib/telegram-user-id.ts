/**
 * The Telegram user behind a cabinet session.
 *
 * Needed by the one API route that asks Telegram about a PERSON rather than the
 * panel about an account: the Mini App channel gate (`routes/channel-gate.ts`).
 *
 * ── WHY A LOOKUP ──────────────────────────────────────────────────────────
 *
 * A WebSession carries the reiwa_id and nothing else (`infrastructure/redis/
 * session.ts`). The Telegram id lives on the account in rezeis and comes back in
 * the same payload `/session` and `/me` serve — `InternalUserSessionInterface.
 * telegramId`, a `BigInt#toString()`, `null` for an account registered on the
 * web that never linked Telegram. The legacy session stores it directly and
 * needs no lookup.
 *
 * ── WHY IT IS REMEMBERED, AND FOR HOW LONG ────────────────────────────────
 *
 * The Mini App asks the gate on every launch and every return to the
 * foreground, and the id it needs almost never changes. Five minutes turns that
 * into one panel read per active user per five minutes, while an operator who
 * links or unlinks a Telegram account sees it take effect within the same
 * five minutes. A read in flight is shared, so a launch that fires the GET and
 * the re-check together costs one read, and a read that FAILED is forgotten at
 * once: it is not an answer, and remembering it would switch the gate off for
 * the next five minutes on the strength of one panel hiccup.
 *
 * ── WHY IT IS BOUNDED ─────────────────────────────────────────────────────
 *
 * Same fault `bot/lib/bounded-map.ts` describes: a map that expires entries
 * only when the same key is read again grows with everyone who has EVER opened
 * the Mini App, and a restart hides it. Entries are kept in the order they were
 * written (an entry is deleted before it is written again, because a `Map`
 * keeps a re-set key where it first stood), so the oldest entry is always the
 * first one: every write drops the expired entries from the front — which keeps
 * the map as large as the active users of the last window, not larger — and, if
 * the map is still over its ceiling, the oldest live ones. Unlike the bot's
 * rate-limit maps, evicting a live entry here is harmless: it costs one panel
 * read, never a wrong answer, so a hard ceiling is the right trade.
 */

/** How long an account's Telegram id is trusted without asking the panel again. */
export const TELEGRAM_USER_ID_TTL_MS = 5 * 60 * 1000;

/** Most accounts remembered at once. */
export const TELEGRAM_USER_ID_MAX_ENTRIES = 10_000;

/**
 * A Telegram user id as a number, or `null` when `value` is not one.
 *
 * Telegram user ids are positive integers of at most 52 significant bits, so a
 * double holds them exactly — but only while they are safe integers. Anything
 * past `Number.MAX_SAFE_INTEGER` would round silently to a DIFFERENT id, and a
 * membership check would then ask Telegram about somebody else. A negative
 * number is a chat, not a user. The string form is what rezeis sends and what
 * the legacy session stores; a number is accepted only while it is still exact.
 */
export function parseTelegramUserId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export interface TelegramUserIdCache {
  /**
   * The account's Telegram user id, `null` when it has none (or rezeis sent
   * something that is not a user id). Rejects when the panel could not answer.
   */
  resolve(userId: string): Promise<number | null>;
  /** Accounts remembered right now, reads in flight included. */
  readonly size: number;
}

export function createTelegramUserIdCache(options: {
  /** Reads the account's `telegramId` field from the panel. */
  readonly lookup: (userId: string) => Promise<unknown>;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}): TelegramUserIdCache {
  const ttlMs = options.ttlMs ?? TELEGRAM_USER_ID_TTL_MS;
  const maxEntries = options.maxEntries ?? TELEGRAM_USER_ID_MAX_ENTRIES;
  // Read at call time, not captured: a clock swapped after construction (a
  // spec's fake timers) must be the clock this cache ages entries by.
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { readonly at: number; readonly id: Promise<number | null> }>();

  function evict(at: number): void {
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries && at - entry.at < ttlMs) return;
      entries.delete(key);
    }
  }

  return {
    get size(): number {
      return entries.size;
    },

    resolve(userId: string): Promise<number | null> {
      const at = now();
      const cached = entries.get(userId);
      if (cached !== undefined && at - cached.at < ttlMs) return cached.id;

      entries.delete(userId);
      // Through a microtask, so a lookup that throws synchronously rejects like
      // any other failed read instead of escaping past the cleanup below.
      const id = Promise.resolve()
        .then(() => options.lookup(userId))
        .then(parseTelegramUserId);
      const entry = { at, id };
      entries.set(userId, entry);
      id.catch(() => {
        if (entries.get(userId) === entry) entries.delete(userId);
      });
      evict(at);
      return id;
    },
  };
}
