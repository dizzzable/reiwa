/**
 * The bot config for a decision or a render that must not hold the bot up.
 *
 * Updates are handled one at a time (`bot.start()`; see `lib/bot-channel-gate.ts`),
 * so whatever one of them waits on, every update queued behind it waits on too.
 * `BotConfigCache.get()` answers from memory while its entry is fresh, but past
 * the TTL it asks the panel and waits for the answer: the transport's ten
 * seconds when the panel hangs.
 *
 * `configWithin(source, budgetMs)` waits `budgetMs` at most, and gives:
 *
 *   • the config, when the read comes back in time;
 *   • else the config the bot holds (`BotConfigCache.peek()`, whatever its age):
 *     stale, which is fine for what its callers want from it — does this data
 *     name a screen, which emoji — and the operator's all the same;
 *   • else `null`: the bot holds none, and the caller goes on without a config.
 *
 * Ask for it AT the answer, not ahead of other work: a config the panel gives
 * while that work runs is then the one used. Asking costs nothing twice over —
 * a read in flight is shared by the cache (`BotConfigCache` joins concurrent
 * reads of a generation), and a fresh entry answers at once.
 *
 * Each ask goes to the source. There is no memory of its own here: one kept a
 * read begun while the panel hung and answered from it after the panel was back
 * and the cache fresh, and fell back on a page's own last read, older than the
 * config the bot held.
 */
import type { BotConfig } from '../../infrastructure/bot-config/types.js';

/**
 * The budget for words the user's spinner waits on: a toast, an alert, an edit
 * made before the button is answered.
 */
export const TOAST_CONFIG_BUDGET_MS = 250;

/** The budget for a message's words: the reply to a command, a notice, a receipt. */
export const MESSAGE_CONFIG_BUDGET_MS = 1_000;

/** Where the config comes from: `PageDeps` is one. */
export interface ConfigSource {
  readonly getConfig: () => Promise<BotConfig>;
  /** The config the bot holds, whatever its age; `null` when it holds none. */
  readonly peekConfig?: () => BotConfig | null;
}

export async function configWithin(source: ConfigSource, budgetMs: number): Promise<BotConfig | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const fresh = await Promise.race([
      // A failed read, or a getConfig that throws before it returns, is no config.
      new Promise<BotConfig>((resolve) => resolve(source.getConfig())).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
      }),
    ]);
    return fresh ?? source.peekConfig?.() ?? null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
