/**
 * Applies the operator's bot profile to Telegram.
 *
 * The panel stores the desired name / description / short description and does
 * NOT call Bot API for them. It could — it holds a token for admin
 * notifications — but that token is not guaranteed to belong to the
 * user-facing bot, and renaming somebody else's bot is not a mistake with an
 * undo. This process owns `BOT_TOKEN`, so it is the one that applies them.
 *
 * ── Read before write, always ─────────────────────────────────────────────
 *
 * Every field is compared against what Telegram currently reports before any
 * setter is called. That is not an optimisation:
 *
 *   • `setMyName` is rate-limited hard. This runs at boot AND on every config
 *     invalidation, so a container that restarts in a loop, or an operator
 *     saving the bot card twice, would otherwise spend the allowance on writes
 *     that change nothing — and then fail the one that matters.
 *   • The getters cost one call each and are not rate-limited in the same way.
 *
 * ── Empty means "leave it alone" ──────────────────────────────────────────
 *
 * An unset field is not a request to clear anything. Most installs will never
 * open the bot card, and their profile was written in @BotFather; treating a
 * blank panel field as "erase the description" would wipe it on first boot
 * after an update. Clearing therefore has no representation here at all, which
 * is a deliberate limitation and the safe side of the trade.
 *
 * Every call is best-effort: a failure is logged and the next field is still
 * attempted. Nothing here may keep the bot from starting.
 */
import type { Bot } from 'grammy';

import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import type { BotContext, PageDeps } from '../pages/types.js';

/** Telegram's own limits. Values beyond these are refused with a 400. */
const LIMITS = { name: 64, description: 512, shortDescription: 120 } as const;

type ProfileField = 'name' | 'description' | 'shortDescription';

interface FieldSpec {
  readonly field: ProfileField;
  readonly read: () => Promise<string>;
  readonly write: (value: string) => Promise<unknown>;
}

export interface ApplyBotProfileResult {
  /** Fields whose value differed and were written. */
  readonly updated: readonly ProfileField[];
  /** Fields that were attempted and failed. */
  readonly failed: readonly ProfileField[];
}

/**
 * Pushes the configured profile to Telegram, one field at a time.
 *
 * Returns what it changed rather than nothing, so the caller can log a single
 * line saying what actually moved — a boot that changes nothing should look
 * different in the log from one that renames the bot.
 */
export async function applyBotProfile(opts: {
  readonly bot: Bot<BotContext>;
  readonly config: BotConfig;
  readonly logger?: PageDeps['logger'];
}): Promise<ApplyBotProfileResult> {
  const { bot, config, logger } = opts;
  const profile = config.profile;
  const updated: ProfileField[] = [];
  const failed: ProfileField[] = [];
  if (profile === undefined) return { updated, failed };

  const specs: readonly FieldSpec[] = [
    {
      field: 'name',
      read: async () => (await bot.api.getMyName()).name,
      write: (name) => bot.api.setMyName(name),
    },
    {
      field: 'description',
      read: async () => (await bot.api.getMyDescription()).description,
      write: (description) => bot.api.setMyDescription(description),
    },
    {
      field: 'shortDescription',
      read: async () => (await bot.api.getMyShortDescription()).short_description,
      write: (value) => bot.api.setMyShortDescription(value),
    },
  ];

  for (const spec of specs) {
    const desired = (profile[spec.field] ?? '').trim();
    // Unset — see the header. Not a request to clear.
    if (desired.length === 0) continue;

    if (desired.length > LIMITS[spec.field]) {
      // Telegram would answer 400 and we would retry the same rejection on
      // every invalidation. Refusing locally says which field, and why.
      logger?.warn(
        { field: spec.field, length: desired.length, limit: LIMITS[spec.field] },
        'bot/profile: value exceeds the Telegram limit, skipped',
      );
      failed.push(spec.field);
      continue;
    }

    try {
      const current = await spec.read();
      if (current === desired) continue;
      await spec.write(desired);
      updated.push(spec.field);
    } catch (err: unknown) {
      logger?.warn({ err, field: spec.field }, 'bot/profile: failed to apply field');
      failed.push(spec.field);
    }
  }

  if (updated.length > 0) {
    logger?.info({ updated }, 'bot/profile: applied operator profile to Telegram');
  }
  return { updated, failed };
}
