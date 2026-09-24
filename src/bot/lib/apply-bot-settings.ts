/**
 * Pushes the operator's panel-owned settings to Telegram.
 *
 * Telegram keeps its own copy of a handful of things about a bot: the name, the
 * two descriptions, the button beside the message input. The panel stores what
 * the operator wants; this is what makes Telegram agree. The panel deliberately
 * does not call Bot API itself — it holds a token for admin notifications, and
 * that token is not guaranteed to belong to the user-facing bot. Renaming
 * somebody else's bot is not a mistake with an undo.
 *
 * ── Read before write, always ─────────────────────────────────────────────
 *
 * Every field is compared against what Telegram currently reports before any
 * setter fires. That is not an optimisation:
 *
 *   • `setMyName` is rate-limited hard. This runs at boot, on every config
 *     invalidation, and when an answered read finds the settings changed
 *     (`telegram-settings-sync.ts`), so a container restarting in a loop, or an
 *     operator saving the bot card twice, would otherwise spend the allowance
 *     on writes that change nothing — and then fail the one that matters.
 *   • The getters cost one call each and are not rate-limited the same way.
 *
 * ── Empty means "leave it alone" ──────────────────────────────────────────
 *
 * An unset field is not a request to clear anything. Most installs never open
 * the bot card, and their profile was written in @BotFather; treating a blank
 * panel field as "erase the description" would wipe it on the first boot after
 * an update. Clearing therefore has no representation here at all — a
 * deliberate limitation, on the safe side of the trade.
 *
 * Every call is best-effort: a failure is logged and the next item is still
 * attempted. Nothing here may keep the bot from starting.
 *
 * ── Plain text, emoji tokens resolved ─────────────────────────────────────
 *
 * The profile fields and the button label are `bot.*` rows the panel's «Тексты
 * бота» lists like any other text, with its emoji picker in the field, and the
 * label's default is an ordinary translator key. Telegram shows all of them as
 * plain text — no entities — so every `:slug:` / `{{KEY}}` becomes its glyph
 * (`plainCopy`) before anything is compared, measured or written.
 *
 * ── What would be pushed, without pushing it ──────────────────────────────
 *
 * `desiredProfile` and `desiredMenuButton` are the values a push writes, worked
 * out from the config alone; `botSettingsFingerprints` turns them into strings
 * that are equal when nothing Telegram shows would change. The sync keys on
 * those, so an answered read that changed nothing calls Telegram for nothing.
 */
import type { Bot } from 'grammy';
import type { LanguageCode, MenuButton } from '@grammyjs/types';

import { DEFAULT_LOCALE } from '../../core/enums/locale.enum.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import { plainCopy } from '../widgets/operator-copy.js';
import type { BotContext, PageDeps } from '../pages/types.js';

/** Telegram's own limits. Anything longer is refused with a 400. */
const LIMITS = { name: 64, description: 512, shortDescription: 120 } as const;

export type ProfileField = keyof typeof LIMITS;

/** What was written, for the caller's log line. `name:en` reads as the pair. */
type AppliedItem = string;

export interface ApplyBotSettingsResult {
  /** Items whose value differed and were written. */
  readonly updated: readonly AppliedItem[];
  /** Items that were attempted and failed. */
  readonly failed: readonly AppliedItem[];
}

/**
 * The parts of the settings a push can be limited to: each profile field on
 * its own — `setMyName`, `setMyDescription` and `setMyShortDescription` are
 * three Bot API methods, and Telegram rate-limits each on its own (a 429 on the
 * name says nothing about the descriptions) — and the menu button.
 */
export type BotSettingsPart = ProfileField | 'menuButton';

/** Every profile field. `only: 'profile'` pushes them all. */
export const PROFILE_PARTS: readonly ProfileField[] = ['name', 'description', 'shortDescription'];

interface ProfileSpec {
  readonly field: ProfileField;
  readonly read: (languageCode: LanguageCode | undefined) => Promise<string>;
  readonly write: (value: string, languageCode: LanguageCode | undefined) => Promise<unknown>;
}

/**
 * The languages a profile field is written for.
 *
 * `undefined` is Telegram's default slot — the value every user sees unless
 * their language has a dedicated one. `'en'` is a dedicated English variant.
 * Russian deliberately has NO dedicated slot: the default already carries it,
 * and writing the same string twice would double the rate-limited calls to say
 * exactly the same thing.
 */
const LANGUAGES: readonly {
  readonly code: LanguageCode | undefined;
  readonly suffix: '' | 'En';
}[] = [
  { code: undefined, suffix: '' },
  { code: 'en', suffix: 'En' },
];

/** One profile value as Telegram will hold it. */
export interface DesiredProfileItem {
  /** `name`, `name:en`, … — the caller's log line. */
  readonly label: string;
  readonly field: ProfileField;
  readonly languageCode: LanguageCode | undefined;
  /** Plain text, tokens resolved. Never empty: an unset field has no item. */
  readonly desired: string;
  /** Over Telegram's limit: never sent, reported instead. */
  readonly tooLong: boolean;
}

/** The profile values a push writes (read-before-write), in the order it writes them. */
export function desiredProfile(config: BotConfig): readonly DesiredProfileItem[] {
  const profile = config.profile;
  if (profile === undefined) return [];
  const items: DesiredProfileItem[] = [];
  for (const field of PROFILE_PARTS) {
    for (const lang of LANGUAGES) {
      // What Telegram will hold, so the limit measures it and the read
      // compares against it — see the header.
      const desired = plainCopy(
        (profile[`${field}${lang.suffix}` as keyof typeof profile] ?? '').trim(),
        config,
      );
      // Unset — see the header. Not a request to clear.
      if (desired.length === 0) continue;
      items.push({
        label: lang.code === undefined ? field : `${field}:${lang.code}`,
        field,
        languageCode: lang.code,
        desired,
        tooLong: desired.length > LIMITS[field],
      });
    }
  }
  return items;
}

/** The menu button a push sets, and whether the Mini App it was asked to open is unavailable. */
export interface DesiredMenuButton {
  readonly button: MenuButton;
  /** The panel asked for the Mini App, and the commands list stands in for it. */
  readonly appUnavailable: boolean;
}

/**
 * The menu button a push sets — `null` when the panel says nothing about it
 * (an older panel), and the button is left exactly as Telegram has it: the
 * operator may have set it by hand.
 */
export function desiredMenuButton(opts: {
  readonly config: BotConfig;
  readonly translator?: PageDeps['translator'];
  readonly miniAppUrl?: string | null;
}): DesiredMenuButton | null {
  const { config } = opts;
  const wanted = config.menuButton?.kind;
  if (wanted === undefined) return null;

  const url = (opts.miniAppUrl ?? '').trim();
  // A menu button opening the Mini App while the SAME panel has the Mini App
  // switched off is a contradiction, and the feature switch wins. So is a
  // `web_app` button with no URL to point at.
  const canOpenApp =
    config.features.miniAppEnabled && url.length > 0 && isTelegramSafeButtonUrl(url);

  const text = plainCopy(
    (config.menuButton?.text ?? '').trim() ||
      // Telegram shows ONE label to every user — `setChatMenuButton` takes no
      // language code — so an operator with a non-Russian audience has to set it
      // explicitly. The default is the bot's own, in its default locale.
      opts.translator?.t('menu_button.cabinet', DEFAULT_LOCALE) ||
      'Cabinet',
    config,
  );

  return {
    button:
      wanted === 'web_app' && canOpenApp
        ? { type: 'web_app', text, web_app: { url } }
        : { type: 'commands' },
    appUnavailable: wanted === 'web_app' && !canOpenApp,
  };
}

/**
 * What a push of each part would write, as strings that are equal when nothing
 * Telegram shows would change. An over-long value is part of it: pushing it
 * again changes nothing either — it is refused here, not by Telegram. A profile
 * field's covers both its language slots: they go through the same method.
 */
export function botSettingsFingerprints(opts: {
  readonly config: BotConfig;
  readonly translator?: PageDeps['translator'];
  readonly miniAppUrl?: string | null;
}): Readonly<Record<BotSettingsPart, string>> {
  const profile = desiredProfile(opts.config);
  const field = (name: ProfileField): string =>
    JSON.stringify(profile.filter((item) => item.field === name).map((item) => [item.label, item.desired]));
  return {
    name: field('name'),
    description: field('description'),
    shortDescription: field('shortDescription'),
    menuButton: JSON.stringify(desiredMenuButton(opts)?.button ?? null),
  };
}

/**
 * Pushes the configured settings to Telegram, one item at a time.
 *
 * Returns what it changed rather than nothing, so the caller can log a single
 * line saying what actually moved — a boot that changes nothing should look
 * different in the log from one that renames the bot.
 *
 * `only` limits the push to one part — one profile field, all of them
 * (`'profile'`), or the menu button; `onCallFailed` hears every Bot API call
 * that threw — a 429 among them, whose `retry_after` the caller keeps to
 * (`telegram-settings-sync.ts`). A value over Telegram's limit is `failed`
 * without a call.
 */
export async function applyBotSettings(opts: {
  readonly bot: Bot<BotContext>;
  readonly config: BotConfig;
  readonly logger?: PageDeps['logger'];
  readonly translator?: PageDeps['translator'];
  /** Mini App URL, for the `web_app` menu button. `null` when unconfigured. */
  readonly miniAppUrl?: string | null;
  readonly only?: BotSettingsPart | 'profile';
  readonly onCallFailed?: (err: unknown) => void;
}): Promise<ApplyBotSettingsResult> {
  const { bot, config, logger } = opts;
  const updated: AppliedItem[] = [];
  const failed: AppliedItem[] = [];

  const fields =
    opts.only === undefined || opts.only === 'profile'
      ? PROFILE_PARTS
      : PROFILE_PARTS.filter((field) => field === opts.only);
  if (fields.length > 0) {
    await applyProfile({ bot, config, logger, updated, failed, onCallFailed: opts.onCallFailed, fields });
  }
  if (opts.only === undefined || opts.only === 'menuButton') {
    await applyMenuButton({ ...opts, updated, failed });
  }

  if (updated.length > 0) {
    logger?.info({ updated }, 'bot/settings: applied operator settings to Telegram');
  }
  return { updated, failed };
}

async function applyProfile(ctx: {
  readonly bot: Bot<BotContext>;
  readonly config: BotConfig;
  readonly logger?: PageDeps['logger'];
  readonly updated: AppliedItem[];
  readonly failed: AppliedItem[];
  readonly onCallFailed?: (err: unknown) => void;
  /** The fields to push. */
  readonly fields: readonly ProfileField[];
}): Promise<void> {
  const { bot, config, logger, updated, failed } = ctx;

  const specs: Readonly<Record<ProfileField, ProfileSpec>> = {
    name: {
      field: 'name',
      read: async (language_code) => (await bot.api.getMyName({ language_code })).name,
      write: (name, language_code) => bot.api.setMyName(name, { language_code }),
    },
    description: {
      field: 'description',
      read: async (language_code) =>
        (await bot.api.getMyDescription({ language_code })).description,
      write: (description, language_code) =>
        bot.api.setMyDescription(description, { language_code }),
    },
    shortDescription: {
      field: 'shortDescription',
      read: async (language_code) =>
        (await bot.api.getMyShortDescription({ language_code })).short_description,
      write: (value, language_code) => bot.api.setMyShortDescription(value, { language_code }),
    },
  };

  for (const item of desiredProfile(config)) {
    if (!ctx.fields.includes(item.field)) continue;
    if (item.tooLong) {
      // Telegram would answer 400 and we would collect the same rejection on
      // every invalidation. Refusing here names the field and the limit.
      logger?.warn(
        { field: item.label, length: item.desired.length, limit: LIMITS[item.field] },
        'bot/settings: value exceeds the Telegram limit, skipped',
      );
      failed.push(item.label);
      continue;
    }

    const spec = specs[item.field];
    try {
      // A getter for a language with no dedicated value answers with the
      // default, so this comparison is safe in both directions: an English
      // variant equal to the default is skipped, a different one is written.
      const current = await spec.read(item.languageCode);
      if (current === item.desired) continue;
      await spec.write(item.desired, item.languageCode);
      updated.push(item.label);
    } catch (err: unknown) {
      logger?.warn({ err, field: item.label }, 'bot/settings: failed to apply field');
      failed.push(item.label);
      ctx.onCallFailed?.(err);
    }
  }
}

/**
 * `MenuButtonDefault` and `MenuButtonCommands` both show the command list —
 * "default" is simply the state of a bot nobody has configured. Treating them
 * as different would make every fresh bot take one pointless write on its first
 * boot, and then converge anyway.
 */
function showsCommands(button: MenuButton): boolean {
  return button.type === 'commands' || button.type === 'default';
}

async function applyMenuButton(ctx: {
  readonly bot: Bot<BotContext>;
  readonly config: BotConfig;
  readonly logger?: PageDeps['logger'];
  readonly translator?: PageDeps['translator'];
  readonly miniAppUrl?: string | null;
  readonly updated: AppliedItem[];
  readonly failed: AppliedItem[];
  readonly onCallFailed?: (err: unknown) => void;
}): Promise<void> {
  const { bot, config, logger, updated, failed } = ctx;
  const plan = desiredMenuButton(ctx);
  // An older panel sends nothing. Leave the button exactly as Telegram has it
  // rather than resetting it — the operator may have set it by hand.
  if (plan === null) return;

  if (plan.appUnavailable) {
    logger?.warn(
      { miniAppEnabled: config.features.miniAppEnabled, hasUrl: (ctx.miniAppUrl ?? '').trim().length > 0 },
      'bot/settings: menu button asked for the Mini App but it is unavailable — using commands',
    );
  }

  const desired = plan.button;
  try {
    const current = await bot.api.getChatMenuButton();
    const same =
      desired.type === 'commands'
        ? showsCommands(current)
        : desired.type === 'web_app' &&
          current.type === 'web_app' &&
          current.text === desired.text &&
          current.web_app.url === desired.web_app.url;
    if (same) return;
    await bot.api.setChatMenuButton({ menu_button: desired });
    updated.push('menuButton');
  } catch (err: unknown) {
    logger?.warn({ err }, 'bot/settings: failed to apply the menu button');
    failed.push('menuButton');
    ctx.onCallFailed?.(err);
  }
}
