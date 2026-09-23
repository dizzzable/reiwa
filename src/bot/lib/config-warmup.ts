/**
 * The warm-up tick: keeps an idle bot's config entry fresh, so a user action
 * finds the config in memory instead of paying the panel round trip — or, with
 * a slow panel, a budget and a fallback (`lib/config-within.ts`).
 *
 * It ran every five minutes — the cache's TTL — through `get()`, which skips an
 * entry still fresh. A refresh lands a moment after its tick, so the next tick
 * found the entry just short of the TTL and skipped it: an idle bot's entry was
 * stale about half the time. Every tick reads the panel now (`refresh()`), and
 * ticks come a minute before the TTL is out, so a read slower than usual still
 * lands before the entry would have gone stale.
 *
 * Nothing to catch here: `refresh()` does not reject — a failed read resolves
 * to the config the cache holds — and the cache logs each failed fetch itself
 * (`BotConfigCache: refresh failed …`, given the logger `bot/main.ts` builds it
 * with). A tick that finds a read in flight joins it: one line per failed
 * fetch, whoever asked.
 */

/** A minute under the cache's five-minute TTL (`infrastructure/bot-config/cache.ts`). */
export const CONFIG_WARMUP_MS = 4 * 60 * 1000;

export function startConfigWarmup(
  cache: { refresh(): Promise<unknown> },
  intervalMs: number = CONFIG_WARMUP_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    void cache.refresh();
  }, intervalMs);
}
