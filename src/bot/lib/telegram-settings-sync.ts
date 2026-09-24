/**
 * Keeps what Telegram holds of the operator's settings — the bot's name and
 * descriptions, the `/` command list, the menu button — in step with the config
 * the panel answers with.
 *
 * Telegram keeps its own copy of these (`apply-bot-settings.ts`,
 * `slash-commands.ts`): reading a new config changes what the bot READS and
 * nothing Telegram shows. They were pushed at boot and after an operator's save
 * (`/invalidate`) — and when that save's read failed, the panel slow or down at
 * that moment, the push was rightly skipped (a failed read hands nothing to
 * push, `BotConfigCache.forceInvalidate`) and nothing pushed it later: the old
 * name, commands and menu button stayed until the next save or a restart. Now
 * every config the panel ANSWERS with is offered here — the four-minute
 * warm-up's, any later read's (`BotConfigCache` `onAnswered`) — and what
 * differs from what last went out, goes out.
 *
 *   • Keyed by fingerprint. Each part — the commands, the name, the
 *     description, the short description, the menu button — has a string that
 *     is equal when nothing Telegram shows would change
 *     (`SlashCommandLists.signature`, `botSettingsFingerprints`). A part goes
 *     out only when its string differs from the one that last went out whole,
 *     so an idle bot's warm-up calls Telegram for nothing.
 *   • Only what the panel answered. Offers come from answered reads alone —
 *     never a failed read's held entry, saved copy or DEFAULT. A save's own
 *     read is offered by the invalidate (`onConfigApplied`), not twice.
 *   • Telegram's limits. One push at a time; a config offered meanwhile waits,
 *     and only the newest of those goes. A part Telegram answered with 429 is
 *     not tried again before its `retry_after` is over — that part alone: each
 *     profile field is a Bot API method of its own, rate-limited on its own, so
 *     a rename Telegram put off holds the name and nothing else, and a new
 *     short description saved meanwhile goes out at once, as it did before
 *     parts were held at all. A part that failed otherwise is tried at the
 *     next answered read — at most every four minutes on an idle bot, never in
 *     a loop. Inside a part, the profile and the menu button are read before
 *     they are written.
 *
 * `force` — a save, a boot — re-reads the profile and the menu button from
 * Telegram and writes what differs, whatever the fingerprint: a save is how an
 * operator puts back a name changed by hand in @BotFather, as it always was.
 * The command list goes out only when its text changed, forced or not, as
 * before.
 */
import type { Bot } from 'grammy';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import type { BotContext, PageDeps } from '../pages/types.js';
import { applyBotSettings, botSettingsFingerprints } from './apply-bot-settings.js';
import { pushSlashCommands, retryAfterMsOf, slashCommandLists } from './slash-commands.js';

/**
 * What the sync keeps in step, in the order it pushes: each part is held on
 * its own after a 429, so a part is what one rate limit covers.
 */
export const SETTINGS_PARTS = ['commands', 'name', 'description', 'shortDescription', 'menuButton'] as const;
export type SettingsPart = (typeof SETTINGS_PARTS)[number];

/** How one part's push went. */
export type PartOutcome =
  /** Through whole — or refused before any call (a value over Telegram's limit), which a repeat would not change. */
  | { readonly kind: 'done' }
  /** A call failed; `retryAfterMs` when Telegram asked for a pause. */
  | { readonly kind: 'failed'; readonly retryAfterMs: number | null };

/** A config's pushes, worked out when it is about to go out. */
export interface PreparedSettings {
  readonly fingerprints: Readonly<Record<SettingsPart, string>>;
  /** Push one part. Never rejects. */
  readonly push: (part: SettingsPart) => Promise<PartOutcome>;
}

export interface TelegramSettingsSync {
  /**
   * A config to keep Telegram in step with. Offer only what the panel answered
   * with. Resolves when it has been dealt with (or superseded by a newer one).
   */
  offer(config: BotConfig, options?: { readonly force?: boolean }): Promise<void>;
  /**
   * Start pushing, with how a config's pushes are worked out. Offers made
   * before — the boot read's — wait for this.
   */
  start(prepare: (config: BotConfig) => PreparedSettings): Promise<void>;
  /** Resolves once nothing is being pushed or waiting to be. */
  idle(): Promise<void>;
}

export function createTelegramSettingsSync(options: {
  readonly logger?: Pick<LoggerPort, 'info' | 'warn'>;
  readonly now?: () => number;
} = {}): TelegramSettingsSync {
  const now = options.now ?? Date.now;
  let prepare: ((config: BotConfig) => PreparedSettings) | null = null;
  /** Each part's fingerprint as it last went out whole. */
  const sent = new Map<SettingsPart, string>();
  /** Until when a part Telegram answered 429 for is not tried. */
  const heldUntil = new Map<SettingsPart, number>();
  /** The newest config offered and not yet pushed; `force` if any of the ones it replaced was. */
  let waiting: { readonly config: BotConfig; readonly force: boolean } | null = null;
  let running: Promise<void> | null = null;

  async function pushOne(prepared: PreparedSettings, force: boolean): Promise<void> {
    for (const part of SETTINGS_PARTS) {
      const fingerprint = prepared.fingerprints[part];
      // A save or a boot re-reads the profile fields and the menu button; the
      // command list is sent only when its text changed (see the header).
      const due = (force && part !== 'commands') || sent.get(part) !== fingerprint;
      if (!due) continue;
      const held = heldUntil.get(part);
      if (held !== undefined && now() < held) continue;
      const outcome = await prepared.push(part);
      if (outcome.kind === 'done') {
        sent.set(part, fingerprint);
        heldUntil.delete(part);
      } else if (outcome.retryAfterMs !== null) {
        heldUntil.set(part, now() + outcome.retryAfterMs);
        options.logger?.warn(
          { part, retryAfterMs: outcome.retryAfterMs },
          'bot/settings: Telegram asked to wait — this part goes again after that, at an answered read',
        );
      }
    }
  }

  async function drain(): Promise<void> {
    while (waiting !== null && prepare !== null) {
      const next = waiting;
      waiting = null;
      try {
        await pushOne(prepare(next.config), next.force);
      } catch (err: unknown) {
        // A push never rejects; working the pushes out might. The next
        // answered read offers again.
        options.logger?.warn({ err }, 'bot/settings: push failed');
      }
    }
  }

  function kick(): void {
    if (running !== null || prepare === null || waiting === null) return;
    const current = drain();
    running = current;
    // Freed only by itself, and an offer that came as the loop ended is not
    // left waiting.
    void current.finally(() => {
      if (running === current) running = null;
      kick();
    });
  }

  async function idle(): Promise<void> {
    while (running !== null || (waiting !== null && prepare !== null)) {
      kick();
      await (running ?? Promise.resolve());
    }
  }

  return {
    offer(config, offerOptions = {}) {
      waiting = { config, force: (offerOptions.force ?? false) || (waiting?.force ?? false) };
      kick();
      return idle();
    },
    start(prepareSettings) {
      prepare = prepareSettings;
      kick();
      return idle();
    },
    idle,
  };
}

/**
 * How the bot works out a config's pushes: the command lists, each profile
 * field and the menu button of that config, with their fingerprints. Called
 * right before the push, so the translator holds the texts of the config being
 * pushed — the newest the panel answered with.
 */
export function telegramSettingsOf(deps: {
  readonly bot: Bot<BotContext>;
  readonly translator: PageDeps['translator'];
  readonly logger?: PageDeps['logger'];
  /** Mini App URL, for the `web_app` menu button. `null` when unconfigured. */
  readonly miniAppUrl: string | null;
}): (config: BotConfig) => PreparedSettings {
  return (config) => {
    const lists = slashCommandLists(deps.translator, config);
    return {
      fingerprints: {
        commands: lists.signature,
        ...botSettingsFingerprints({ config, translator: deps.translator, miniAppUrl: deps.miniAppUrl }),
      },
      push: async (part) => {
        if (part === 'commands') return pushSlashCommands(deps.bot.api, lists, deps.logger);
        let failed = false;
        let retryAfterMs: number | null = null;
        await applyBotSettings({
          bot: deps.bot,
          config,
          logger: deps.logger,
          translator: deps.translator,
          miniAppUrl: deps.miniAppUrl,
          only: part,
          onCallFailed: (err) => {
            failed = true;
            const wait = retryAfterMsOf(err);
            if (wait !== null) retryAfterMs = Math.max(retryAfterMs ?? 0, wait);
          },
        });
        return failed ? { kind: 'failed', retryAfterMs } : { kind: 'done' };
      },
    };
  };
}
