/**
 * The last copy of each panel settings group that the panel actually served,
 * kept in reiwa's own Redis.
 *
 * Every settings cache in reiwa lives in process memory, so a restart during a
 * panel outage used to come back with nothing — and "nothing" is not neutral:
 * the landing read as switched off (`/` → sign-in), the access rules as open to
 * everybody, the guest chat as captcha-less. One store for all of them, so each
 * group gets the same guarantees instead of each being hand-wired its own way
 * (three already were, three different ways — W8 report D11).
 *
 * ── The record ───────────────────────────────────────────────────────────────
 *
 *   key   `reiwa:lkg:<group>:v<shape>`            (`redis/keys.ts`)
 *   value `{ shape, savedAt, hash, payload }`
 *
 *  - `payload` is the panel's RAW answer, never an object reiwa mapped: what a
 *    cache here stores is a wire format, and a mapped object silently changes
 *    shape across a release (memory note `cached-objects-are-a-wire-format`).
 *  - `shape` is in the key AND the value. Change what a group stores, bump it:
 *    the new release then never reads the old record, and a rollback never reads
 *    the new one.
 *  - `hash` is the payload's version (`config-version.ts`), the one the panel's
 *    version poll compares against.
 *  - `savedAt` says how old the copy is; `null` on a copy migrated from a key
 *    that predates the record, whose age nobody wrote down.
 *
 * No TTL. The copy is replaced by every good answer, and the owner's rule is
 * that settings survive a panel outage of any length — an expiry would turn a
 * long outage back into the defaults.
 *
 * ── Keys from before the record ──────────────────────────────────────────────
 *
 * Three groups had a copy already, under unversioned keys. Each is read ONCE
 * per process, and only when the new key is missing: a copy found there is
 * written under the new key (`SET … NX`, so it never overwrites a newer copy
 * another process saved meanwhile) and served. The first good answer saved
 * under the new key deletes the old one.
 *
 * Best-effort in both directions: a Redis problem is never the reason a
 * settings read fails. Nothing here throws; a failure is a log line and an
 * answer that says what happened.
 *
 * ── "No copy" is not "could not read" ────────────────────────────────────────
 *
 * `load` answers `null` only when Redis said there is no copy to trust. When
 * Redis could not be read at all — a command timeout, a refused connection, a
 * client that is not ready yet after a host reboot (Docker's restart policy does
 * not wait for `depends_on`) — it answers {@link LAST_KNOWN_GOOD_UNREADABLE}.
 * The two used to be one `null`, and every cache that reads its copy once per
 * process remembered it: a restart that met Redis a second too early served the
 * defaults — the access rules open to everybody, the stock buttons, no guest
 * captcha — for the whole panel outage, with the operator's copy sitting in
 * Redis (review R2a-01). A caller serves what it would serve without a copy for
 * now, keeps nothing of it, and asks again at its next use; the store paces
 * those asks ({@link LAST_KNOWN_GOOD_RETRY_MS}).
 */
import { Redis } from 'ioredis';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import { REDIS_CLIENT_OPTIONS } from '../../lib/redis-client-options.js';
import { lastKnownGoodKey } from '../redis/keys.js';
import { CONFIG_VERSION_KEYS, configVersionOf, legalDocumentsVersionKey } from './config-version.js';

/** What the store keeps for one group. */
export interface LastKnownGood<T> {
  readonly shape: number;
  /** Epoch ms of the save; `null` for a copy migrated from a pre-record key. */
  readonly savedAt: number | null;
  /** The payload's version, as the panel's version poll computes it. */
  readonly hash: string;
  readonly payload: T;
}

/** One group of settings the store keeps a copy of. */
export interface LastKnownGoodGroup<T> {
  /** The group's name in the key: `reiwa:lkg:<name>:v<shape>`. */
  readonly name: string;
  /** Bump when what the group stores changes shape. */
  readonly shape: number;
  /** The unversioned key this group used before the record, read once as a fallback. */
  readonly legacyKey?: string;
  /**
   * Whether a stored payload may be served. Checked on every load: "written by
   * us" stops being true the moment a shape changes across a release.
   */
  readonly accepts: (payload: unknown) => payload is T;
  /** Anything bigger is not a settings payload; it is not written. Default 4 MB. */
  readonly maxBytes?: number;
}

/**
 * What `load` answers when Redis could not be read. NOT "no copy": the caller
 * serves what it would serve without one, remembers nothing of it, and asks
 * again at its next use (see the header).
 */
export const LAST_KNOWN_GOOD_UNREADABLE: unique symbol = Symbol('last-known-good: unreadable');
export type LastKnownGoodUnreadable = typeof LAST_KNOWN_GOOD_UNREADABLE;

/**
 * How long after a failed read of a group `load` answers
 * {@link LAST_KNOWN_GOOD_UNREADABLE} at once, without asking Redis again: a
 * Redis outage costs one GET per group per pause, not one per read. Short — the
 * copy is wanted as soon as Redis is back — and about one command timeout
 * (`REDIS_COMMAND_TIMEOUT_MS`), which each failed GET may already have spent.
 */
export const LAST_KNOWN_GOOD_RETRY_MS = 2_000;

/**
 * How long a cache trusts a "none" from `load` before a read that has nothing
 * else to serve asks again. "None" is true when it is said, not for the life of
 * a process: the API and the bot keep their copies in the same Redis, and a
 * container is replaced while the old one still runs — the process that read
 * "none" at boot answered from it until the panel answered it itself, with a
 * copy saved beside it a moment later. Half a minute: one GET per group per
 * interval while there is none, never one per read.
 */
export const LAST_KNOWN_GOOD_NONE_RECHECK_MS = 30_000;

/**
 * What `save` did:
 *  - `saved` — the copy is in Redis now;
 *  - `too-large` — the payload is over the group's `maxBytes` and was not
 *    written: the copy in Redis, if any, is an OLDER one;
 *  - `not-saved` — Redis refused it, or there is no store: nothing written.
 */
export type LastKnownGoodSaveOutcome = 'saved' | 'too-large' | 'not-saved';

/** A payload `save` did not write because it is over the group's cap. */
export interface LastKnownGoodTooLarge {
  readonly group: string;
  /** The version of the payload that was not written. */
  readonly hash: string;
  readonly bytes: number;
  readonly maxBytes: number;
}

export interface LastKnownGoodStorePort {
  /**
   * The copy to serve; `null` when Redis says there is none to trust (none
   * saved, or one that fails its check); {@link LAST_KNOWN_GOOD_UNREADABLE}
   * when Redis could not be read — not "none", ask again later. Never throws.
   */
  load<T>(group: LastKnownGoodGroup<T>): Promise<LastKnownGood<T> | null | LastKnownGoodUnreadable>;
  /**
   * Record a payload the panel actually served. `hash` defaults to the
   * payload's own version; pass it when the payload was stamped after the
   * panel answered (the bot's Telegram file ids). Answers what it did; never
   * throws.
   */
  save<T>(group: LastKnownGoodGroup<T>, payload: T, hash?: string): Promise<LastKnownGoodSaveOutcome>;
}

/** For tests and Redis-free deployments. */
export const NOOP_LAST_KNOWN_GOOD: LastKnownGoodStorePort = {
  load: async () => null,
  save: async () => 'not-saved',
};

/** The cap of a group that names none (`LastKnownGoodGroup.maxBytes`). */
export const LAST_KNOWN_GOOD_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

type LastKnownGoodRedis = Pick<Redis, 'get' | 'set' | 'del'>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `bytes` for a log line an operator reads: `5.3 MB`, `812 KB`. */
export function formatCopySize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export class RedisLastKnownGoodStore implements LastKnownGoodStorePort {
  private readonly redis: LastKnownGoodRedis;
  private readonly logger: LoggerPort | undefined;
  private readonly now: () => number;
  private readonly onTooLarge: ((skipped: LastKnownGoodTooLarge) => void) | undefined;
  /** Groups whose pre-record key this process has read — successfully — or moved. */
  private readonly legacyRead = new Set<string>();
  /** Groups whose pre-record key this process has already deleted. */
  private readonly legacyDeleted = new Set<string>();
  /**
   * Per group, after a read Redis failed: until when `load` answers
   * "unreadable" without asking again. The entry stays past that moment until
   * a read succeeds — it marks the streak, so only its first failure warns.
   */
  private readonly unreadableUntil = new Map<string, number>();
  /** Per group, the version whose too-large save was last reported: once per version, not once per save. */
  private readonly tooLargeReported = new Map<string, string>();

  public constructor(options: {
    redis: LastKnownGoodRedis;
    logger?: LoggerPort;
    now?: () => number;
    /**
     * Told once per group and version when a payload is over the cap and was
     * not written — the copy a restart serves is then an older one. For the
     * operator-facing report (`redis-public-config-persistence.ts`).
     */
    onTooLarge?: (skipped: LastKnownGoodTooLarge) => void;
  }) {
    this.redis = options.redis;
    this.logger = options.logger;
    // Late-bound: the same clock as the caches that read through the store.
    this.now = options.now ?? (() => Date.now());
    this.onTooLarge = options.onTooLarge;
  }

  public async load<T>(group: LastKnownGoodGroup<T>): Promise<LastKnownGood<T> | null | LastKnownGoodUnreadable> {
    const pausedUntil = this.unreadableUntil.get(group.name);
    if (pausedUntil !== undefined && this.now() < pausedUntil) return LAST_KNOWN_GOOD_UNREADABLE;
    let raw: string | null;
    try {
      raw = await this.redis.get(lastKnownGoodKey(group.name, group.shape));
    } catch (err: unknown) {
      return this.unreadable(group, err);
    }
    this.unreadableUntil.delete(group.name);
    if (raw !== null && raw.length > 0) return this.readRecord(group, raw);
    return this.migrateLegacy(group);
  }

  public async save<T>(group: LastKnownGoodGroup<T>, payload: T, hash?: string): Promise<LastKnownGoodSaveOutcome> {
    let raw: string;
    let version: string;
    try {
      version = hash ?? configVersionOf(payload);
      const record: LastKnownGood<T> = { shape: group.shape, savedAt: this.now(), hash: version, payload };
      raw = JSON.stringify(record);
    } catch (err: unknown) {
      this.logger?.warn({ err, group: group.name }, 'last-known-good: payload could not be written down');
      return 'not-saved';
    }
    const bytes = Buffer.byteLength(raw, 'utf8');
    const maxBytes = group.maxBytes ?? LAST_KNOWN_GOOD_DEFAULT_MAX_BYTES;
    if (bytes > maxBytes) {
      this.reportTooLarge({ group: group.name, hash: version, bytes, maxBytes });
      return 'too-large';
    }
    try {
      await this.redis.set(lastKnownGoodKey(group.name, group.shape), raw);
    } catch (err: unknown) {
      this.logger?.warn({ err, group: group.name }, 'last-known-good: save failed');
      return 'not-saved';
    }
    // The new record now holds a copy at least as good as the old key's. Its
    // delete failing does not undo the save; the next save tries it again.
    if (group.legacyKey !== undefined && !this.legacyDeleted.has(group.name)) {
      try {
        await this.redis.del(group.legacyKey);
        this.legacyDeleted.add(group.name);
      } catch (err: unknown) {
        this.logger?.warn({ err, group: group.name }, 'last-known-good: the pre-record copy could not be deleted');
      }
    }
    return 'saved';
  }

  /** A failed read: "unreadable", and no second GET of this group for a pause. */
  private unreadable(group: LastKnownGoodGroup<unknown>, err: unknown): LastKnownGoodUnreadable {
    const streak = this.unreadableUntil.has(group.name);
    this.unreadableUntil.set(group.name, this.now() + LAST_KNOWN_GOOD_RETRY_MS);
    const context = { err, group: group.name, retryInMs: LAST_KNOWN_GOOD_RETRY_MS };
    const message = 'last-known-good: Redis could not be read — not taken for "no copy"; asked again shortly';
    if (streak) this.logger?.debug(context, message);
    else this.logger?.warn(context, message);
    return LAST_KNOWN_GOOD_UNREADABLE;
  }

  /**
   * Loud, and once per version: this used to be a warning on every save — one
   * a minute for the public config, which reads the panel every TTL — and
   * nothing an operator sees, while a restart during an outage served an older
   * copy (review R2a-07).
   */
  private reportTooLarge(skipped: LastKnownGoodTooLarge): void {
    if (this.tooLargeReported.get(skipped.group) === skipped.hash) return;
    this.tooLargeReported.set(skipped.group, skipped.hash);
    this.logger?.warn(
      { ...skipped },
      `last-known-good: "${skipped.group}" is ${formatCopySize(skipped.bytes)}, over the ${formatCopySize(skipped.maxBytes)} cap — its copy was NOT saved; a restart during a panel outage serves the older copy, if any`,
    );
    try {
      this.onTooLarge?.(skipped);
    } catch (err: unknown) {
      this.logger?.warn({ err, group: skipped.group }, 'last-known-good: onTooLarge threw');
    }
  }

  private readRecord<T>(group: LastKnownGoodGroup<T>, raw: string): LastKnownGood<T> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Redis answered: there is no copy to trust. The next save overwrites it.
      this.logger?.warn({ group: group.name }, 'last-known-good: stored copy is not JSON — ignoring it');
      return null;
    }
    if (
      !isObject(parsed) ||
      parsed['shape'] !== group.shape ||
      typeof parsed['hash'] !== 'string' ||
      !(typeof parsed['savedAt'] === 'number' || parsed['savedAt'] === null) ||
      !group.accepts(parsed['payload'])
    ) {
      this.logger?.warn({ group: group.name }, 'last-known-good: stored copy failed its check — ignoring it');
      return null;
    }
    return {
      shape: group.shape,
      savedAt: parsed['savedAt'] as number | null,
      hash: parsed['hash'],
      payload: parsed['payload'] as T,
    };
  }

  /**
   * The copy under the key from before the record. Marked as read only once
   * Redis answered for it — a failed GET marked first would read as "no copy"
   * for the rest of the process — and, when there was one, once it is moved.
   */
  private async migrateLegacy<T>(
    group: LastKnownGoodGroup<T>,
  ): Promise<LastKnownGood<T> | null | LastKnownGoodUnreadable> {
    if (group.legacyKey === undefined || this.legacyRead.has(group.name)) return null;
    let raw: string | null;
    try {
      raw = await this.redis.get(group.legacyKey);
    } catch (err: unknown) {
      return this.unreadable(group, err);
    }
    let payload: unknown;
    try {
      payload = raw === null || raw.length === 0 ? undefined : JSON.parse(raw);
    } catch {
      payload = undefined;
    }
    if (payload === undefined || !group.accepts(payload)) {
      this.legacyRead.add(group.name);
      if (raw !== null && raw.length > 0) {
        this.logger?.warn({ group: group.name }, 'last-known-good: pre-record copy failed its check — ignoring it');
      }
      return null;
    }
    const record: LastKnownGood<T> = {
      shape: group.shape,
      savedAt: null,
      hash: configVersionOf(payload),
      payload,
    };
    try {
      // NX: another process may have saved a fresher copy since the GET above.
      await this.redis.set(lastKnownGoodKey(group.name, group.shape), JSON.stringify(record), 'NX');
      this.legacyRead.add(group.name);
      this.logger?.info({ group: group.name }, 'last-known-good: moved the copy kept under the old key');
    } catch (err: unknown) {
      // Served all the same; the next load finds the old key again and retries.
      this.logger?.warn({ err, group: group.name }, 'last-known-good: the copy under the old key could not be moved');
    }
    return record;
  }
}

/**
 * A client of its own, for a process that has no shared Redis connection to
 * lend (the bot). Lazy, so building it costs nothing until the first read, and
 * with an `error` listener, so a Redis outage is a log line and not a crash.
 */
export function createLastKnownGoodRedis(redisUrl: string, logger?: LoggerPort): Redis {
  const redis = new Redis(redisUrl, { ...REDIS_CLIENT_OPTIONS, lazyConnect: true });
  redis.on('error', (err: Error) => {
    logger?.warn({ err, component: 'last-known-good' }, 'Redis error');
  });
  return redis;
}

// ── Groups whose copy has no older key ──────────────────────────────────────
// The three that had one are declared beside their adapters:
// `bot-config/redis-config-persistence.ts`,
// `public-config/redis-public-config-persistence.ts`,
// `public-config/redis-connect-page-snapshot.ts`.

/**
 * The effective landing. `{ enabled: false }` is a real answer the panel gives
 * — "nothing is published" — and is kept like any other.
 */
export const LANDING_LKG: LastKnownGoodGroup<Record<string, unknown>> = {
  name: 'landing',
  shape: 1,
  accepts: (payload: unknown): payload is Record<string, unknown> =>
    isObject(payload) && typeof payload['enabled'] === 'boolean',
};

/** The platform policy: access mode, channel gate, rules gate. */
export const PLATFORM_POLICY_LKG: LastKnownGoodGroup<Record<string, unknown>> = {
  name: 'platform-policy',
  shape: 1,
  accepts: (payload: unknown): payload is Record<string, unknown> =>
    isObject(payload) && typeof payload['accessMode'] === 'string',
};

/** The cabinet feed's custom emoji packs. */
export const CUSTOM_EMOJI_PACKS_LKG: LastKnownGoodGroup<unknown[]> = {
  name: 'custom-emoji-packs',
  shape: 1,
  accepts: (payload: unknown): payload is unknown[] => Array.isArray(payload),
};

/**
 * The guest chat's runtime config. It carries the Turnstile SECRET as well as
 * the site key: without the secret a captcha shown in the form cannot be
 * checked, and the copy exists precisely so the captcha does not vanish. It is
 * reiwa's own password-protected Redis, which already holds the sessions.
 */
export const GUEST_SUPPORT_LKG: LastKnownGoodGroup<Record<string, unknown>> = {
  name: 'guest-support',
  shape: 1,
  accepts: (payload: unknown): payload is Record<string, unknown> =>
    isObject(payload) &&
    typeof payload['enabled'] === 'boolean' &&
    typeof payload['turnstileSiteKey'] === 'string',
};

/**
 * The operator's active legal documents in one language, as the bot's rules
 * screen reads them (`admin-client/legal-documents-cache.ts`): whether there
 * are any decides between the cabinet's `/legal` page and the legacy rules
 * link. An empty list is a real answer — "none switched on" — and is kept like
 * any other.
 */
function legalDocumentsGroup(language: 'ru' | 'en'): LastKnownGoodGroup<unknown[]> {
  return {
    name: `legal-documents.${language}`,
    shape: 1,
    accepts: (payload: unknown): payload is unknown[] =>
      Array.isArray(payload) &&
      payload.every(
        (document: unknown) =>
          isObject(document) &&
          typeof document['key'] === 'string' &&
          typeof document['title'] === 'string' &&
          typeof document['body'] === 'string',
      ),
  };
}

const LEGAL_DOCUMENTS_RU_LKG = legalDocumentsGroup('ru');
const LEGAL_DOCUMENTS_EN_LKG = legalDocumentsGroup('en');

/**
 * The legal documents' group for a locale, by the panel's own rule
 * (`legalDocumentsVersionKey`): an explicit `en` is English, anything else the
 * primary language — one copy per answer the panel gives.
 */
export function legalDocumentsLastKnownGood(locale: string): LastKnownGoodGroup<unknown[]> {
  return legalDocumentsVersionKey(locale) === CONFIG_VERSION_KEYS.legalDocumentsEn
    ? LEGAL_DOCUMENTS_EN_LKG
    : LEGAL_DOCUMENTS_RU_LKG;
}
