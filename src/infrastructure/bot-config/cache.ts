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
import { configVersionOf } from '../config-versions/config-version.js';
import { firstAnswer } from '../config-versions/within-budget.js';

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
   *   - a read with nothing held serves the store's copy as soon as the store
   *     answers, and a cold-start fetch failure does too, instead of the
   *     hardcoded `fallback`
   * Omitted (tests / no Redis) → no copy: the fallback after the budget.
   */
  readonly persistence?: ConfigPersistencePort;
  /**
   * Hears every config the panel ANSWERED with — a read that landed in its own
   * generation — and nothing else: not a failed read's held entry, saved copy
   * or fallback, not a read an invalidate overtook. `forceInvalidate`'s own
   * read is not announced: it hands its config to its caller instead, which
   * pushes it on (`handleInvalidate` → `onConfigApplied`). The bot keeps what
   * Telegram holds in step with these (`bot/lib/telegram-settings-sync.ts`).
   */
  readonly onAnswered?: (config: BotConfig) => void;
  /**
   * How long a read with nothing held — no entry, no saved copy — waits for the
   * panel before it serves the fallback. `bot/main.ts` passes the budget of a
   * message's words (`MESSAGE_CONFIG_BUDGET_MS`, `bot/lib/config-within.ts`).
   */
  readonly firstLoadBudgetMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * The default `firstLoadBudgetMs`: a second, the same as a message's words wait
 * in `bot/lib/config-within.ts`. The only read that waits at all.
 */
export const FIRST_LOAD_BUDGET_MS = 1_000;

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
  /**
   * The version of the panel's answer this entry came from (`config-version.ts`),
   * kept across the Telegram file-id stamps, which change the entry but not
   * what the panel served. The version poll compares it with the panel's.
   */
  readonly version: string;
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
  private readonly onAnswered: ((config: BotConfig) => void) | undefined;
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
  private readonly firstLoadBudgetMs: number;
  /**
   * The saved copy's read, one per generation: a cold start asks Redis once,
   * whether the first read found the copy or the failed fetch went looking for
   * it. Keyed by the generation for the reason `generation` gives.
   */
  private saved: { readonly generation: number; readonly copy: Promise<BotConfig | null> } | null = null;
  /**
   * The generation whose cold read already waited out its budget. The reads
   * after it, while the same fetch is still out, answer the fallback at once
   * instead of each waiting a budget of their own on the same hung panel.
   */
  private budgetSpent: number | null = null;

  constructor(options: BotConfigCacheOptions) {
    this.fetcher = options.fetcher;
    this.hydrator = options.hydrator;
    this.fallback = options.fallback;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = options.logger;
    this.persistence = options.persistence;
    this.onAnswered = options.onAnswered;
    this.firstLoadBudgetMs = options.firstLoadBudgetMs ?? FIRST_LOAD_BUDGET_MS;
  }

  /**
   * The config for an update, and never a wait on the panel once the bot holds
   * one (W8 report D1).
   *
   * Updates are handled one at a time, so a read that waits on the panel holds
   * every chat queued behind it. This used to wait whenever the entry was past
   * its TTL, and a panel that HANGS — its VPS down, packets dropped rather than
   * refused — costs the transport's ten seconds a read: with the hold-off
   * between failures the whole bot froze about half the time.
   *
   *  - An entry of any age is answered at once. Past the TTL, or kept stale by
   *    `forceInvalidate()`, a refresh starts behind it (stale-while-revalidate);
   *    reads meanwhile join that one refresh (`fetchOnce`), and within
   *    FAILURE_HOLD_OFF_MS of a failed one none starts at all.
   *  - Nothing held: the saved copy in Redis, as soon as Redis answers.
   *  - Nothing held and nothing saved — a first boot with the panel away — is
   *    the one read that waits, and only `firstLoadBudgetMs`: then the
   *    fallback, while the read goes on and lands in the entry when it does.
   *
   * Translator overrides are pushed via `hydrator.setOverrides()` on
   * every successful refresh, so admin edits propagate within `ttlMs`
   * without an explicit cache-bust.
   */
  async get(): Promise<BotConfig> {
    const entry = this.entry;
    if (entry !== null) {
      if (Date.now() - entry.fetchedAt >= this.ttlMs && !this.holdingOff()) void this.fetchOnce();
      return entry.data;
    }
    if (this.holdingOff()) return this.servedOnFailure(this.generation);
    return this.firstLoad();
  }

  /** Nothing held: the saved copy, else the panel within the budget, else the fallback. */
  private async firstLoad(): Promise<BotConfig> {
    const startedAt = this.generation;
    const fetched = this.fetchOnce().then((outcome) => outcome.config);
    if (this.budgetSpent === startedAt) return this.fallback;
    const first = await firstAnswer({
      fetched,
      saved: this.savedCopy(startedAt),
      budgetMs: this.firstLoadBudgetMs,
    });
    if (first !== null) return first;
    if (startedAt === this.generation) this.budgetSpent = startedAt;
    return this.entry?.data ?? this.fallback;
  }

  /**
   * The version of the config this cache holds — `null` while it holds none —
   * for the version poll (`infrastructure/config-versions/poller.ts`).
   */
  heldVersion(): string | null {
    return this.entry?.version ?? null;
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
  private fetchOnce(announce = true): Promise<Fetched> {
    const inFlight = this.inFlight;
    if (inFlight !== null && inFlight.generation === this.generation) return inFlight.promise;
    const slot: InFlightFetch = {
      generation: this.generation,
      promise: this.fetchFresh(this.generation, announce).finally(() => {
        if (this.inFlight === slot) this.inFlight = null;
      }),
    };
    this.inFlight = slot;
    return slot.promise;
  }

  /** `announce`: tell `onAnswered` when the panel answers — every read but `forceInvalidate`'s own. */
  private async fetchFresh(startedAt: number, announce: boolean): Promise<Fetched> {
    try {
      const raw = (await this.fetcher()) as RawBotConfig;
      // Superseded while in flight: the caller still gets what it read, but
      // the cache, translator and snapshot belong to the newer fetch.
      if (startedAt !== this.generation) return { config: raw, answered: true };
      this.entry = { data: raw, fetchedAt: Date.now(), version: configVersionOf(raw) };
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
      // After the translator took this config's texts: a listener that works
      // out what to push reads them (`bot/lib/telegram-settings-sync.ts`).
      if (announce && this.onAnswered !== undefined) {
        try {
          this.onAnswered(this.entry.data);
        } catch (err: unknown) {
          this.logger?.warn({ err }, 'BotConfigCache: onAnswered threw');
        }
      }
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
    // hardcoded default (`loadPersisted` seeds it as the entry).
    return (await this.savedCopy(startedAt)) ?? this.fallback;
  }

  /** The saved copy for a read begun in `startedAt`, read from the store once per generation. */
  private savedCopy(startedAt: number): Promise<BotConfig | null> {
    const saved = this.saved;
    if (saved !== null && saved.generation === startedAt) return saved.copy;
    const copy = this.loadPersisted(startedAt);
    this.saved = { generation: startedAt, copy };
    return copy;
  }

  /**
   * Best-effort read of the durable last-known-good snapshot. Kept as a STALE
   * entry, with the translator hydrated from it so localized copy survives a
   * cold start too: the cache keeps retrying the fetcher until upstream
   * recovers, and `peek()` holds the copy the bot runs on — the replies that
   * cannot wait for the panel render from it. Only while nothing else is held,
   * and not by a read an invalidate overtook (see `generation`): that caller
   * still gets the copy, the cache does not.
   *
   * Returns `null` when no store is configured, the store is empty, or the
   * load fails.
   */
  private async loadPersisted(startedAt: number): Promise<BotConfig | null> {
    if (this.persistence === undefined) return null;
    try {
      const persisted = await this.persistence.load();
      if (persisted === null) return null;
      if (startedAt === this.generation && this.entry === null) {
        this.entry = {
          data: persisted,
          fetchedAt: Number.NEGATIVE_INFINITY,
          version: configVersionOf(persisted),
        };
        try {
          this.hydrator.setOverrides((persisted as RawBotConfig).translations);
        } catch {
          // ignore hydrator failure — the config itself is still usable
        }
        this.logger?.info(
          {},
          'BotConfigCache: seeded from persisted last-known-good config',
        );
      }
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
    const held = this.entry;
    if (held === null) return;
    const current = held.data;
    if (current.visual.bannerUrl !== bannerUrl) return;
    if (current.visual.bannerFileId === fileId) return;
    const next: BotConfig = {
      ...current,
      visual: { ...current.visual, bannerFileId: fileId },
    };
    this.entry = { data: next, fetchedAt: held.fetchedAt, version: held.version };
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
    const held = this.entry;
    if (held === null) return;
    const current = held.data;
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
    this.entry = { data: next, fetchedAt: held.fetchedAt, version: held.version };
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
    // Stale, not dropped: `get()` and `peek()` keep answering with the config
    // the bot holds while the save is read. Dropped, it held nothing for as
    // long as the save took to read — every reply that could not wait for the
    // panel went out with the operator's emoji tokens raw, and every one that
    // could waited on the panel.
    if (this.entry !== null) {
      this.entry = { ...this.entry, fetchedAt: Number.NEGATIVE_INFINITY };
    }
    // The bump also ends a hold-off (see `holdOff`): the save is read at once,
    // whatever failed a moment ago.
    this.generation += 1;
    const generation = this.generation;
    try {
      // A fetch of the new generation — what `get()` would start, the entry
      // being stale and the hold-off over — whose outcome is needed here. Not
      // announced to `onAnswered`: the config goes back to the caller, which
      // pushes it on itself — announced as well, one save would push twice.
      const fetched = await this.fetchOnce(false);
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
