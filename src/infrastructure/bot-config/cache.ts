/**
 * In-memory bot-config cache with translator hydration side-effect.
 *
 * Wave 3 extracted this from the bot god-file. The bot polls
 * `AdminClient.getBotConfig()` (Wave 6 will replace the polling with
 * an SSE pull) and caches the result for `ttlMs` so every command
 * doesn't trigger a fresh HTTP round-trip.
 *
 * Translator hydration is intentionally done here, not in the
 * caller: every refresh hands the operator-managed `translations`
 * map to the injected `LocalePackHydrator` so `t()` calls downstream
 * see fresh labels without an extra reload step.
 *
 * Constructor injects:
 *   - a `getBotConfig` callback (the bound AdminClient method)
 *   - a `LocalePackHydrator` (the Translator singleton or a stub in
 *     tests)
 *   - the default config used as a fallback when admin is unreachable
 *     and the cache is empty
 *   - optional ttlMs override and LoggerPort
 */
import type { LocalePackHydrator } from '../../application/ports/translator.port.js';
import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { ConfigPersistencePort } from '../../application/ports/config-persistence.port.js';

import type { BotConfig } from './types.js';

/**
 * Subset of `BotConfig` we look up — typed loosely so the cache stays
 * agnostic to upstream contract drift. The cache forwards whatever
 * shape it receives to the consumer; only the `translations` field is
 * intercepted (and even that is treated as best-effort).
 */
type RawBotConfig = BotConfig & { readonly translations?: Record<string, string> };

export interface BotConfigCacheOptions {
  /** Bound `AdminClient.getBotConfig.bind(adminClient)` or a stub. */
  readonly fetcher: () => Promise<unknown>;
  readonly hydrator: LocalePackHydrator;
  readonly fallback: BotConfig;
  readonly ttlMs?: number;
  readonly logger?: LoggerPort;
  /**
   * Optional durable last-known-good store (Workstream 4). When present:
   *   - every successful fetch is persisted (fire-and-forget)
   *   - a cold-start fetch failure seeds the returned config from the
   *     store instead of the hardcoded `fallback`
   * Omitted (tests / no Redis) → behaves exactly as before.
   */
  readonly persistence?: ConfigPersistencePort;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * How long after a failed fetch reads serve what a failed read serves — the
 * held entry, the saved copy, or the fallback — instead of asking the panel
 * again. A panel that refuses connections fails a fetch at once, so without it
 * every update that read the config paid a network attempt against a panel
 * that was down, and wrote a warning: the rate followed the traffic. With it,
 * one fetch and one warning per window. `reset()` and `forceInvalidate()` end
 * it, so an operator's save is still read at once.
 */
const FAILURE_HOLD_OFF_MS = 10_000;

interface CacheEntry {
  readonly data: BotConfig;
  readonly fetchedAt: number;
}

/**
 * A fetch's outcome: the config it serves, and whether the panel answered. A
 * read that failed still serves a config — the held entry, the saved copy, or
 * the fallback — and only `answered` tells the two apart (`forceInvalidate`).
 */
interface Fetched {
  readonly config: BotConfig;
  readonly answered: boolean;
}

/** The fetch in flight, and the generation it was begun in. */
interface InFlightFetch {
  readonly generation: number;
  readonly promise: Promise<Fetched>;
}

export class BotConfigCache {
  private readonly fetcher: () => Promise<unknown>;
  private readonly hydrator: LocalePackHydrator;
  private readonly fallback: BotConfig;
  private readonly ttlMs: number;
  private readonly logger: LoggerPort | undefined;
  private readonly persistence: ConfigPersistencePort | undefined;
  private entry: CacheEntry | null = null;
  /**
   * Bumped by `reset()` and `forceInvalidate()`. A fetch begun before the bump
   * may have read the config from before the operator's save, so when it lands
   * it may not write anything: not the entry, not the translator overrides, not
   * the durable snapshot. Otherwise the bot runs on the old config for another
   * TTL with the invalidate already spent; `generation` in
   * `api/routes/connect-page.ts` spells out the race.
   */
  private generation = 0;
  /**
   * One fetch at a time per generation (`fetchOnce`): a read that comes while
   * one is in flight joins it. Every page's read and the welcome screen's two
   * used to send one each against the same stale entry.
   */
  private inFlight: InFlightFetch | null = null;
  /**
   * After a failed fetch: until when reads of its generation do not fetch
   * (FAILURE_HOLD_OFF_MS). Keyed by the generation, so `reset()` and
   * `forceInvalidate()` — which bump it — end the hold-off, and only a fetch
   * of the current generation starts one: a pre-save fetch failing late may
   * not replace the hold-off of the save's read.
   */
  private holdOff: { readonly generation: number; readonly until: number } | null = null;

  constructor(options: BotConfigCacheOptions) {
    this.fetcher = options.fetcher;
    this.hydrator = options.hydrator;
    this.fallback = options.fallback;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = options.logger;
    this.persistence = options.persistence;
  }

  /**
   * Returns a fresh-or-cached config. Refreshes when the cache is
   * empty or older than `ttlMs`. Refresh failures fall back to:
   *   - the previously cached entry (degraded mode), or
   *   - the constructor `fallback` if nothing has ever been cached.
   *
   * Translator overrides are pushed via `hydrator.setOverrides()` on
   * every successful refresh, so admin edits propagate within `ttlMs`
   * without an explicit cache-bust.
   *
   * A read that comes while a refresh is in flight joins it (`fetchOnce`). A
   * read that comes within FAILURE_HOLD_OFF_MS of a failed one does not fetch.
   */
  async get(): Promise<BotConfig> {
    if (this.entry !== null && Date.now() - this.entry.fetchedAt < this.ttlMs) {
      return this.entry.data;
    }
    if (this.holdingOff()) return this.servedOnFailure(this.generation);
    return (await this.fetchOnce()).config;
  }

  private holdingOff(): boolean {
    const holdOff = this.holdOff;
    return holdOff !== null && holdOff.generation === this.generation && Date.now() < holdOff.until;
  }

  /**
   * Read the panel now, whatever the entry's age: the warm-up tick
   * (`bot/lib/config-warmup.ts`), which keeps an idle bot's entry from going
   * stale. Joins a fetch of the current generation already in flight. Not held
   * off by a failed fetch: a tick every four minutes is no traffic.
   */
  refresh(): Promise<BotConfig> {
    return this.fetchOnce().then((fetched) => fetched.config);
  }

  /**
   * The config this cache holds, whatever its age: the last fetch's, or the
   * saved copy a cold start served while the panel did not answer — `null`
   * when it holds neither. Never asks the panel: for a caller that must not
   * wait for it (`bot/lib/config-within.ts`), where a stale config still
   * renders the operator's emoji and nothing renders none of them.
   */
  peek(): BotConfig | null {
    return this.entry?.data ?? null;
  }

  /**
   * The fetch in flight when it belongs to the current generation, else a new
   * one. Not across an invalidate: a fetch begun before `reset()` or
   * `forceInvalidate()` may have read the config from before the operator's
   * save (see `generation`), so a read that comes after it starts its own. The
   * slot is freed only by the fetch that holds it — the older one landing
   * later must not free the newer one's, or the next read would go upstream
   * beside it instead of joining it.
   */
  private fetchOnce(): Promise<Fetched> {
    const inFlight = this.inFlight;
    if (inFlight !== null && inFlight.generation === this.generation) return inFlight.promise;
    const slot: InFlightFetch = {
      generation: this.generation,
      promise: this.fetchFresh(this.generation).finally(() => {
        if (this.inFlight === slot) this.inFlight = null;
      }),
    };
    this.inFlight = slot;
    return slot.promise;
  }

  private async fetchFresh(startedAt: number): Promise<Fetched> {
    try {
      const raw = (await this.fetcher()) as RawBotConfig;
      // Superseded while in flight: the caller still gets what it read, but
      // the cache, translator and snapshot belong to the newer fetch.
      if (startedAt !== this.generation) return { config: raw, answered: true };
      this.entry = { data: raw, fetchedAt: Date.now() };
      // Hydrate translator overrides from the operator-managed
      // `translations` map. Best-effort — a malformed payload
      // shouldn't block the cache.
      try {
        this.hydrator.setOverrides(raw.translations);
      } catch (err: unknown) {
        this.logger?.warn(
          { err },
          'BotConfigCache: hydrator.setOverrides threw',
        );
      }
      // Persist the fresh snapshot as last-known-good (fire-and-forget).
      // A store outage must not slow down or fail the hot path.
      void this.persistence?.save(raw).catch((err: unknown) => {
        this.logger?.warn({ err }, 'BotConfigCache: persistence.save threw');
      });
      return { config: this.entry.data, answered: true };
    } catch (err: unknown) {
      this.logger?.warn(
        { err },
        'BotConfigCache: refresh failed; serving stale or fallback',
      );
      // Reads within FAILURE_HOLD_OFF_MS serve what this one serves, without
      // a fetch — not after a fetch an invalidate overtook (see `generation`).
      if (startedAt === this.generation) {
        this.holdOff = { generation: startedAt, until: Date.now() + FAILURE_HOLD_OFF_MS };
      }
      return { config: await this.servedOnFailure(startedAt), answered: false };
    }
  }

  /** What a read gets when the panel did not answer. */
  private async servedOnFailure(startedAt: number): Promise<BotConfig> {
    if (this.entry !== null) return this.entry.data;
    // Cold start with a failed upstream fetch: prefer the persisted
    // last-known-good config (correct branding + banner) over the
    // hardcoded default. Kept as a STALE entry: the cache keeps retrying
    // the fetcher until upstream recovers, and `peek()` holds the copy the
    // bot runs on — the replies that cannot wait for the panel render from
    // it. Not by a fetch an invalidate overtook (see `generation`).
    const persisted = await this.loadPersisted(startedAt);
    if (persisted !== null) {
      if (startedAt === this.generation && this.entry === null) {
        this.entry = { data: persisted, fetchedAt: Number.NEGATIVE_INFINITY };
      }
      return persisted;
    }
    return this.fallback;
  }

  /**
   * Best-effort read of the durable last-known-good snapshot, hydrating
   * the translator from it so localized copy survives a cold start too.
   * Returns `null` when no store is configured, the store is empty, or
   * the load fails.
   */
  private async loadPersisted(startedAt: number): Promise<BotConfig | null> {
    if (this.persistence === undefined) return null;
    try {
      const persisted = await this.persistence.load();
      if (persisted === null) return null;
      try {
        // Not over the overrides of a fetch begun after an invalidate.
        if (startedAt === this.generation) {
          this.hydrator.setOverrides(
            (persisted as RawBotConfig).translations,
          );
        }
      } catch {
        // ignore hydrator failure — the config itself is still usable
      }
      this.logger?.info(
        {},
        'BotConfigCache: seeded from persisted last-known-good config',
      );
      return persisted;
    } catch (err: unknown) {
      this.logger?.warn({ err }, 'BotConfigCache: persistence.load threw');
      return null;
    }
  }

  /**
   * Test seam — drop the cached entry so the next `get()` re-fetches. A full
   * reset: `peek()` holds nothing after it. Nothing in the bot calls it; an
   * operator's save goes through `forceInvalidate()`, which keeps the entry.
   */
  reset(): void {
    this.entry = null;
    this.generation += 1;
  }

  /**
   * Stamp a Telegram-resolved banner `file_id` into the live config
   * snapshot and re-persist it, so a custom banner survives a reboot and
   * can be re-sent via `file_id` without re-downloading from rezeis
   * (Workstream 4). Best-effort and a no-op unless the current snapshot's
   * `bannerUrl` matches the supplied `bannerUrl` (guards against stamping
   * a stale id after the operator swaps the banner). Mutates a shallow
   * copy so the cached reference identity changes for downstream readers.
   */
  stampBannerFileId(bannerUrl: string, fileId: string): void {
    const current = this.entry?.data;
    if (current === undefined) return;
    if (current.visual.bannerUrl !== bannerUrl) return;
    if (current.visual.bannerFileId === fileId) return;
    const next: BotConfig = {
      ...current,
      visual: { ...current.visual, bannerFileId: fileId },
    };
    this.entry = { data: next, fetchedAt: this.entry?.fetchedAt ?? Date.now() };
    void this.persistence?.save(next).catch((err: unknown) => {
      this.logger?.warn(
        { err },
        'BotConfigCache: persistence.save (banner stamp) threw',
      );
    });
  }

  /**
   * Stamp a Telegram-resolved `file_id` onto a specific dynamic screen's
   * `mediaFileId` in the live snapshot and re-persist it — so a per-screen
   * banner survives a reboot and can be re-sent via `file_id` without
   * re-downloading from rezeis (mirrors `stampBannerFileId` for the global
   * banner). Best-effort; a no-op unless the snapshot still has a screen with
   * this `shortId` whose `mediaUrl` matches (guards against stamping a stale id
   * after the operator swaps the screen's banner) and it doesn't already carry
   * this `file_id`. Mutates shallow copies so downstream reference identity
   * changes.
   */
  stampScreenBannerFileId(shortId: string, mediaUrl: string, fileId: string): void {
    const current = this.entry?.data;
    if (current === undefined) return;
    const screens = current.screens;
    if (!Array.isArray(screens)) return;
    const idx = screens.findIndex((s) => s.shortId === shortId);
    if (idx < 0) return;
    const screen = screens[idx];
    if (screen === undefined) return;
    // Only stamp when the screen still points at the same photo URL and
    // doesn't already carry this id — otherwise a mid-flight banner swap would
    // pin a stale file_id.
    if (screen.mediaUrl !== mediaUrl) return;
    if (screen.mediaFileId === fileId) return;
    const nextScreens = screens.slice();
    nextScreens[idx] = { ...screen, mediaFileId: fileId };
    const next: BotConfig = { ...current, screens: nextScreens };
    this.entry = { data: next, fetchedAt: this.entry?.fetchedAt ?? Date.now() };
    void this.persistence?.save(next).catch((err: unknown) => {
      this.logger?.warn(
        { err },
        'BotConfigCache: persistence.save (screen banner stamp) threw',
      );
    });
  }

  /**
   * Operator-driven cache bust. Same wire as `reset()` but with an
   * explicit log line so an operator inspecting bot logs can correlate
   * the invalidate event with their save action in the admin SPA.
   *
   * Returns the fresh config (so the caller can ack with the latest
   * payload) or `null` when the upstream refresh fails — the cache
   * keeps serving stale data in that case rather than going dark. A failed
   * read used to hand back what a failed read serves: the config the bot
   * held, the saved copy, or DEFAULT on a cold start with no saved copy — and
   * the caller pushed that to Telegram, the operator's profile, commands and
   * menu button overwritten with the defaults in the last case.
   *
   * Also `null` when a newer invalidate landed while this one was fetching.
   * The caller pushes what this returns on to Telegram (bot profile, menu
   * button, commands), and two saves in a row used to finish in either order:
   * the older read could land last and be pushed over the newer one, leaving
   * the bot's Telegram profile on the first save. The newer invalidate owns
   * that push.
   */
  async forceInvalidate(reason: string): Promise<BotConfig | null> {
    this.logger?.info(
      { reason, hadCachedEntry: this.entry !== null },
      'BotConfigCache: forced invalidate',
    );
    // Stale, not dropped. The next `get()` reads the save all the same, while
    // `peek()` keeps answering with the config the bot holds: dropped, it held
    // nothing for as long as the save took to read, and every reply that could
    // not wait for the panel went out with the operator's emoji tokens raw.
    if (this.entry !== null) {
      this.entry = { data: this.entry.data, fetchedAt: Number.NEGATIVE_INFINITY };
    }
    // The bump also ends a hold-off (see `holdOff`): the save is read at once,
    // whatever failed a moment ago.
    this.generation += 1;
    const generation = this.generation;
    try {
      // A fetch of the new generation — what `get()` would start, the entry
      // being stale and the hold-off over — whose outcome is needed here.
      const fetched = await this.fetchOnce();
      return this.generation === generation && fetched.answered ? fetched.config : null;
    } catch {
      return null;
    }
  }
}

/**
 * Default reiwa bot config, mirrored from the rezeis-admin
 * `BotConfigModule.OnApplicationBootstrap` seed (Wave 7). Used as a
 * fallback when the admin API is unreachable AND the cache is empty.
 *
 * Keep this in sync with `DEFAULT_BUTTONS` on the admin side; the bot
 * keyboard renders correctly even before the operator runs the seed.
 */
export const DEFAULT_BOT_CONFIG: BotConfig = {
  buttons: [
    { id: 'cabinet', emoji: '', label: 'Мой кабинет', visible: true, order: 0, style: 'primary', onePerRow: true },
    { id: 'invite', emoji: '', label: 'Пригласить', visible: true, order: 1, style: 'default', onePerRow: true },
    { id: 'rules', emoji: '', label: 'Правила', visible: true, order: 2, style: 'default', onePerRow: false },
    { id: 'help', emoji: '', label: 'Помощь', visible: true, order: 3, style: 'default', onePerRow: false },
  ],
  visual: {
    // No service name: "Rezeis" is the panel's, not the operator's brand, and
    // this greeting is what customers get while the panel cannot be read. Same
    // text as the panel's default (`internal-bot-config.service.ts`).
    welcomeMessage: 'Привет, {{firstName}}! 👋\n\nДобро пожаловать!',
    welcomeMessageEn: null,
    supportUsername: '',
    subscriptionInfoFormat: 'full',
    bannerUrl: null,
  },
  features: {
    referralsEnabled: true,
    promoCodesEnabled: true,
    trialEnabled: false,
    miniAppEnabled: true,
    activityFeedEnabled: true,
    partnersEnabled: false,
  },
  botEmojis: {},
  menuTextCustomEmojiIds: {},
};
