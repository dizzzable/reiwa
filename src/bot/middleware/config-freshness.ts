/**
 * Every button press, command and message answered from the newest settings
 * reiwa knows of — the owner's "hot reload on any button" (24.09.2026).
 *
 * ── WHY IN FRONT OF EVERYTHING ────────────────────────────────────────────
 *
 * An operator's save reaches the bot by the relay (`/invalidate`, about a
 * second) and, when that hint is lost, by the bot's version poll (about twenty
 * seconds). In between, a press was answered from the copy the bot held. Now,
 * before any page sees an update that renders something, this asks whether
 * that copy is behind what reiwa already knows — the key both processes keep
 * in reiwa's Redis (`infrastructure/config-versions/latest.ts`: what the polls
 * heard, when the webhook said a group changed), and the bot's own
 * `/invalidate` — and if it is, reads the panel once and waits for it, within
 * the press's budget, before the page renders (`BotConfigCache.catchUp`).
 * Each page then renders from the config of that moment, as it always did.
 *
 * ── WHAT IT NEVER DOES ────────────────────────────────────────────────────
 *
 *  - Ask the panel whether something changed: that would make every press as
 *    slow as the panel, and a hung panel would hang the bot. It reads the panel
 *    only for a change it already knows of, once per change.
 *  - Wait longer than the update's budget (`lib/config-within.ts`): a button's
 *    spinner TOAST_CONFIG_BUDGET_MS, a message MESSAGE_CONFIG_BUDGET_MS. Updates
 *    are handled one at a time, so every millisecond here is one for each
 *    update queued behind. A Redis that fails or hangs, a panel that hangs: the
 *    update goes on at the budget at the latest, from what the bot holds.
 *  - Throw into the update.
 *  - Touch other updates: service messages, payments, chat members and
 *    everything else a page does not render words for go on at once.
 *
 * The platform policy (access mode, channel gate, rules gate) is brought up to
 * date the same way on every such update — the gate reads it in front of every
 * page (`PolicyCache.catchUp`, which never adds the invalidation's one-second
 * wait). The legal documents too, but only for a press that opens the rules
 * screen — the one screen that reads them.
 *
 * Registered in `bot/main.ts` after the session and the locale middleware (the
 * rules screen's language is the user's) and before the channel gate, whose
 * join prompt is rendered from the config too.
 */
import { Context, type MiddlewareFn } from 'grammy';

import type { LoggerPort } from '../../application/ports/logger.port.js';
import { CONFIG_VERSION_KEYS, legalDocumentsVersionKey } from '../../infrastructure/config-versions/config-version.js';
import {
  knownChangeOf,
  type KnownPanelChange,
  type LatestConfigVersions,
} from '../../infrastructure/config-versions/latest.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';
import { MESSAGE_CONFIG_BUDGET_MS, TOAST_CONFIG_BUDGET_MS } from '../lib/config-within.js';
import { coerceLocale } from '../pages/coerce-locale.js';
import { RULES_CALLBACK, RULES_COMMAND } from '../pages/rules.js';
import { findScreenByShortId } from '../pages/screen-renderer.js';
import type { BotContext, UserLocaleSyncCache } from '../pages/types.js';
import { USER_AUTHORED_FIELDS } from './channel-gate.js';

/** The bot config cache as this middleware uses it (`BotConfigCache`). */
export interface BotConfigCatchUp {
  catchUp(known: KnownPanelChange, budgetMs: number): Promise<void>;
}

/** The legal-documents cache as this middleware uses it (`LegalDocumentsCache`). */
export interface LegalDocumentsCatchUp {
  catchUp(locale: string, known: KnownPanelChange, budgetMs: number): Promise<void>;
}

/** The platform-policy cache as this middleware uses it (`PolicyCache`). */
export interface PolicyCatchUp {
  catchUp(known: KnownPanelChange, budgetMs: number): Promise<void>;
}

export interface ConfigFreshnessDeps {
  /** What reiwa's Redis knows — one read shared by a burst of presses (`memoiseLatest`); `null` when unknown. */
  readonly latest: () => Promise<LatestConfigVersions | null>;
  /** The bot config cache, when the bot has one (it has none without a panel). */
  readonly botConfig: () => BotConfigCatchUp | null;
  /**
   * The platform policy — access mode, channel gate, rules gate — once the gate
   * or `/start` has built its cache. Optional: a caller without one leaves the
   * policy to its TTL and the relay.
   */
  readonly policy?: () => PolicyCatchUp | null;
  /** The legal-documents cache, once the rules screen has built it. */
  readonly legalDocuments: () => LegalDocumentsCatchUp | null;
  readonly userLocale: Pick<UserLocaleSyncCache, 'getSync'>;
  /** The config the bot holds — which screen a `screen:<shortId>` press opens. */
  readonly peekConfig: () => BotConfig | null;
  readonly logger?: LoggerPort;
}

/** grammY's own matcher, so a rules press means exactly what `pages/rules.ts` registers. */
const isRulesCommand = Context.has.command(RULES_COMMAND);

/** The prefix `pages/dynamic-screen.ts` answers a screen's button with. */
const SCREEN_PREFIX = 'screen:';

/**
 * How long this update may wait for the settings to be brought up to date:
 * the budget of what it is answered with, or `null` — not an update a page
 * renders words for, which goes on at once.
 */
export function freshnessBudgetOf(ctx: BotContext): number | null {
  if (ctx.callbackQuery !== undefined) return TOAST_CONFIG_BUDGET_MS;
  if (ctx.inlineQuery !== undefined) return TOAST_CONFIG_BUDGET_MS;
  const message = ctx.message;
  if (message !== undefined && message.chat.type === 'private') {
    return USER_AUTHORED_FIELDS.some((field) => message[field] !== undefined) ? MESSAGE_CONFIG_BUDGET_MS : null;
  }
  return null;
}

/**
 * Whether this update opens the rules screen: the `rules` button, `/rules`, or
 * a `screen:<shortId>` / bare-shortId button onto the operator's screen named
 * `rules` (`pages/dynamic-screen.ts` hands that to the rules handler).
 */
export function opensRulesScreen(ctx: BotContext, config: BotConfig | null): boolean {
  const data = ctx.callbackQuery?.data;
  if (data !== undefined) {
    if (data === RULES_CALLBACK) return true;
    const shortId = data.startsWith(SCREEN_PREFIX) ? data.slice(SCREEN_PREFIX.length) : data;
    const screen = config === null ? null : findScreenByShortId(config.screens, shortId);
    // Matched as `dynamic-screen.ts` hands a built-in screen over: case aside.
    return screen !== null && screen.name.toLowerCase() === RULES_CALLBACK;
  }
  return ctx.message !== undefined && isRulesCommand(ctx);
}

export function createConfigFreshnessMiddleware(deps: ConfigFreshnessDeps): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const budgetMs = freshnessBudgetOf(ctx);
    if (budgetMs !== null) await caughtUpWithin(ctx, deps, budgetMs);
    await next();
  };
}

/** Everything below, cut off at `budgetMs` whatever it is waiting on. Never rejects. */
async function caughtUpWithin(ctx: BotContext, deps: ConfigFreshnessDeps, budgetMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      catchUp(ctx, deps, budgetMs, Date.now()).catch((err: unknown) => {
        deps.logger?.debug({ err }, 'config freshness: could not check the settings; answering from what is held');
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function catchUp(ctx: BotContext, deps: ConfigFreshnessDeps, budgetMs: number, startedAt: number): Promise<void> {
  const botConfig = deps.botConfig();
  const policy = deps.policy?.() ?? null;
  const legalDocuments = opensRulesScreen(ctx, deps.peekConfig()) ? deps.legalDocuments() : null;
  // No panel, no cache: nothing to bring up to date, and no reason to ask Redis.
  if (botConfig === null && policy === null && legalDocuments === null) return;
  const latest = await deps.latest();
  const left = budgetMs - (Date.now() - startedAt);
  const work: Promise<void>[] = [];
  if (botConfig !== null) work.push(botConfig.catchUp(knownChangeOf(latest, CONFIG_VERSION_KEYS.botConfig), left));
  // The gate reads it in front of every page, and `/start` and «В меню» decide on it.
  if (policy !== null) work.push(policy.catchUp(knownChangeOf(latest, CONFIG_VERSION_KEYS.platformPolicy), left));
  if (legalDocuments !== null) {
    const locale = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    work.push(legalDocuments.catchUp(locale, knownChangeOf(latest, legalDocumentsVersionKey(locale)), left));
  }
  await Promise.all(work);
}
