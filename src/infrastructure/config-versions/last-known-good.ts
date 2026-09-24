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
 * settings read fails. Every path answers `null` or does nothing, with a log
 * line.
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

export interface LastKnownGoodStorePort {
  /** The copy to serve, or `null` when there is none to trust. Never throws. */
  load<T>(group: LastKnownGoodGroup<T>): Promise<LastKnownGood<T> | null>;
  /**
   * Record a payload the panel actually served. `hash` defaults to the
   * payload's own version; pass it when the payload was stamped after the
   * panel answered (the bot's Telegram file ids). Never throws.
   */
  save<T>(group: LastKnownGoodGroup<T>, payload: T, hash?: string): Promise<void>;
}

/** For tests and Redis-free deployments. */
export const NOOP_LAST_KNOWN_GOOD: LastKnownGoodStorePort = {
  load: async () => null,
  save: async () => undefined,
};

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

type LastKnownGoodRedis = Pick<Redis, 'get' | 'set' | 'del'>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RedisLastKnownGoodStore implements LastKnownGoodStorePort {
  private readonly redis: LastKnownGoodRedis;
  private readonly logger: LoggerPort | undefined;
  private readonly now: () => number;
  /** Groups whose pre-record key this process has already looked at. */
  private readonly legacyRead = new Set<string>();
  /** Groups whose pre-record key this process has already deleted. */
  private readonly legacyDeleted = new Set<string>();

  public constructor(options: { redis: LastKnownGoodRedis; logger?: LoggerPort; now?: () => number }) {
    this.redis = options.redis;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  public async load<T>(group: LastKnownGoodGroup<T>): Promise<LastKnownGood<T> | null> {
    try {
      const raw = await this.redis.get(lastKnownGoodKey(group.name, group.shape));
      if (raw !== null && raw.length > 0) return this.readRecord(group, raw);
      return await this.migrateLegacy(group);
    } catch (err: unknown) {
      this.logger?.warn({ err, group: group.name }, 'last-known-good: load failed');
      return null;
    }
  }

  public async save<T>(group: LastKnownGoodGroup<T>, payload: T, hash?: string): Promise<void> {
    try {
      const record: LastKnownGood<T> = {
        shape: group.shape,
        savedAt: this.now(),
        hash: hash ?? configVersionOf(payload),
        payload,
      };
      const raw = JSON.stringify(record);
      if (Buffer.byteLength(raw, 'utf8') > (group.maxBytes ?? DEFAULT_MAX_BYTES)) {
        this.logger?.warn({ group: group.name }, 'last-known-good: payload too large to keep a copy of');
        return;
      }
      await this.redis.set(lastKnownGoodKey(group.name, group.shape), raw);
      // The new record now holds a copy at least as good as the old key's.
      if (group.legacyKey !== undefined && !this.legacyDeleted.has(group.name)) {
        this.legacyDeleted.add(group.name);
        await this.redis.del(group.legacyKey);
      }
    } catch (err: unknown) {
      this.logger?.warn({ err, group: group.name }, 'last-known-good: save failed');
    }
  }

  private readRecord<T>(group: LastKnownGoodGroup<T>, raw: string): LastKnownGood<T> | null {
    const parsed: unknown = JSON.parse(raw);
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

  private async migrateLegacy<T>(group: LastKnownGoodGroup<T>): Promise<LastKnownGood<T> | null> {
    if (group.legacyKey === undefined || this.legacyRead.has(group.name)) return null;
    this.legacyRead.add(group.name);
    const raw = await this.redis.get(group.legacyKey);
    if (raw === null || raw.length === 0) return null;
    const payload: unknown = JSON.parse(raw);
    if (!group.accepts(payload)) {
      this.logger?.warn({ group: group.name }, 'last-known-good: pre-record copy failed its check — ignoring it');
      return null;
    }
    const record: LastKnownGood<T> = {
      shape: group.shape,
      savedAt: null,
      hash: configVersionOf(payload),
      payload,
    };
    // NX: another process may have saved a fresher copy since the GET above.
    await this.redis.set(lastKnownGoodKey(group.name, group.shape), JSON.stringify(record), 'NX');
    this.logger?.info({ group: group.name }, 'last-known-good: moved the copy kept under the old key');
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
