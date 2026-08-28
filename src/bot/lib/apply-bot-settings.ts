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
 *   • `setMyName` is rate-limited hard. This runs at boot AND on every config
 *     invalidation, so a container restarting in a loop, or an operator saving
 *     the bot card twice, would otherwise spend the allowance on writes that
 *     change nothing — and then fail the one that matters.
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
 */
import type { Bot } from 'grammy';
import type { LanguageCode, MenuButton } from '@grammyjs/types';

import { DEFAULT_LOCALE } from '../../core/enums/locale.enum.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import type { BotContext, PageDeps } from '../pages/types.js';

/** Telegram's own limits. Anything longer is refused with a 400. */
const LIMITS = { name: 64, description: 512, shortDescription: 120 } as const;

type ProfileField = keyof typeof LIMITS;

/** What was written, for the caller's log line. `name:en` reads as the pair. */
type AppliedItem = string;

export interface ApplyBotSettingsResult {
  /** Items whose value differed and were written. */
  readonly updated: readonly AppliedItem[];
  /** Items that were attempted and failed. */
  readonly failed: readonly AppliedItem[];
}

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

/**
 * Pushes the configured settings to Telegram, one item at a time.
 *
 * Returns what it changed rather than nothing, so the caller can log a single
 * line saying what actually moved — a boot that changes nothing should look
 * different in the log from one that renames the bot.
 */
export async function applyBotSettings(opts: {
  readonly bot: Bot<BotContext>;
  readonly config: BotConfig;
  readonly logger?: PageDeps['logger'];
  readonly translator?: PageDeps['translator'];
  /** Mini App URL, for the `web_app` menu button. `null` when unconfigured. */
  readonly miniAppUrl?: string | null;
}): Promise<ApplyBotSettingsResult> {
  const { bot, config, logger } = opts;
  const updated: AppliedItem[] = [];
  const failed: AppliedItem[] = [];

  await applyProfile({ bot, config, logger, updated, failed });
  await applyMenuButton({ ...opts, updated, failed });

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
}): Promise<void> {
  const { bot, config, logger, updated, failed } = ctx;
  const profile = config.profile;
  if (profile === undefined) return;

  const specs: readonly ProfileSpec[] = [
    {
      field: 'name',
      read: async (language_code) => (await bot.api.getMyName({ language_code })).name,
      write: (name, language_code) => bot.api.setMyName(name, { language_code }),
    },
    {
      field: 'description',
      read: async (language_code) =>
        (await bot.api.getMyDescription({ language_code })).description,
      write: (description, language_code) =>
        bot.api.setMyDescription(description, { language_code }),
    },
    {
      field: 'shortDescription',
      read: async (language_code) =>
        (await bot.api.getMyShortDescription({ language_code })).short_description,
      write: (value, language_code) => bot.api.setMyShortDescription(value, { language_code }),
    },
  ];

  for (const spec of specs) {
    for (const lang of LANGUAGES) {
      const label = lang.code === undefined ? spec.field : `${spec.field}:${lang.code}`;
      const desired = (profile[`${spec.field}${lang.suffix}` as keyof typeof profile] ?? '').trim();
      // Unset — see the header. Not a request to clear.
      if (desired.length === 0) continue;

      if (desired.length > LIMITS[spec.field]) {
        // Telegram would answer 400 and we would collect the same rejection on
        // every invalidation. Refusing here names the field and the limit.
        logger?.warn(
          { field: label, length: desired.length, limit: LIMITS[spec.field] },
          'bot/settings: value exceeds the Telegram limit, skipped',
        );
        failed.push(label);
        continue;
      }

      try {
        // A getter for a language with no dedicated value answers with the
        // default, so this comparison is safe in both directions: an English
        // variant equal to the default is skipped, a different one is written.
        const current = await spec.read(lang.code);
        if (current === desired) continue;
        await spec.write(desired, lang.code);
        updated.push(label);
      } catch (err: unknown) {
        logger?.warn({ err, field: label }, 'bot/settings: failed to apply field');
        failed.push(label);
      }
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
}): Promise<void> {
  const { bot, config, logger, updated, failed } = ctx;
  const wanted = config.menuButton?.kind;
  // An older panel sends nothing. Leave the button exactly as Telegram has it
  // rather than resetting it — the operator may have set it by hand.
  if (wanted === undefined) return;

  const url = (ctx.miniAppUrl ?? '').trim();
  // A menu button opening the Mini App while the SAME panel has the Mini App
  // switched off is a contradiction, and the feature switch wins. So is a
  // `web_app` button with no URL to point at.
  const canOpenApp =
    config.features.miniAppEnabled && url.length > 0 && isTelegramSafeButtonUrl(url);
  if (wanted === 'web_app' && !canOpenApp) {
    logger?.warn(
      { miniAppEnabled: config.features.miniAppEnabled, hasUrl: url.length > 0 },
      'bot/settings: menu button asked for the Mini App but it is unavailable — using commands',
    );
  }

  const text =
    (config.menuButton?.text ?? '').trim() ||
    // Telegram shows ONE label to every user — `setChatMenuButton` takes no
    // language code — so an operator with a non-Russian audience has to set it
    // explicitly. The default is the bot's own, in its default locale.
    ctx.translator?.t('menu_button.cabinet', DEFAULT_LOCALE) ||
    'Cabinet';

  const desired: MenuButton =
    wanted === 'web_app' && canOpenApp
      ? { type: 'web_app', text, web_app: { url } }
      : { type: 'commands' };

  try {
    const current = await bot.api.getChatMenuButton();
    const same =
      desired.type === 'commands'
        ? showsCommands(current)
        : current.type === 'web_app' &&
          current.text === desired.text &&
          current.web_app.url === desired.web_app.url;
    if (same) return;
    await bot.api.setChatMenuButton({ menu_button: desired });
    updated.push('menuButton');
  } catch (err: unknown) {
    logger?.warn({ err }, 'bot/settings: failed to apply the menu button');
    failed.push('menuButton');
  }
}
