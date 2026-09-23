/**
 * AI Support — Telegram Bot page
 *
 * Adds an AI-powered support mode to the bot:
 * - /support command enters the AI support mode
 * - While in support mode, any text message is answered by AI
 * - The AI uses function calling to fetch live data from the admin panel
 * - /cancel or the inline exit button leaves support mode
 *
 * Extends the bot session with an `aiSupportMode` flag.
 */

import { InlineKeyboard } from "grammy";
import { generateResponseWithTools } from "../../core/ai/chat-client.js";
import type { SupportedLocale } from "../../core/enums/locale.enum.js";
import { configWithin, MESSAGE_CONFIG_BUDGET_MS, TOAST_CONFIG_BUDGET_MS } from "../lib/config-within.js";
import { inlineButton } from "../widgets/inline-button.js";
import { markdownCopy, messageCopy, type CopyEmojis } from "../widgets/operator-copy.js";
import { AI_SUPPORT_EXIT_CALLBACK, CANCEL_COMMAND } from "./ai-support-mode.js";
import { coerceLocale } from "./coerce-locale.js";
import { replyWithEntities } from "./reply.js";
import type { PageRegistrar } from "./types.js";

// ── Per-chat rate limit ─────────────────────────────────────────────────────
// Each AI-support message fans out to paid LLM calls, so bound bursts per chat
// (the bot is a single process, so an in-memory sliding window is sufficient;
// the REST route has its own Redis limiter).
const CHAT_RATE_MAX = 15;
const CHAT_RATE_WINDOW_MS = 60_000;
const chatHits = new Map<number, number[]>();

function isChatRateLimited(chatId: number): boolean {
  const now = Date.now();
  const hits = (chatHits.get(chatId) ?? []).filter((t) => now - t < CHAT_RATE_WINDOW_MS);
  if (hits.length >= CHAT_RATE_MAX) {
    chatHits.set(chatId, hits);
    return true;
  }
  hits.push(now);
  chatHits.set(chatId, hits);
  // Keep the map flat over the process lifetime: once it grows past a bound,
  // drop chats whose window has fully elapsed.
  if (chatHits.size > 1_000) {
    for (const [id, ts] of chatHits) {
      const last = ts[ts.length - 1];
      if (last === undefined || now - last >= CHAT_RATE_WINDOW_MS) chatHits.delete(id);
    }
  }
  return false;
}

// Extend session type to include AI support mode
declare module "grammy" {
  interface SessionFlavorExtension<S> {
    aiSupportMode?: boolean;
  }
}

export const registerAiSupportPage: PageRegistrar = (bot, deps) => {
  const { adminClient } = deps;

  /**
   * Resolve OpenAI-compatible settings from rezeis panel only (encrypted API
   * key at rest). Same source as the cabinet — never OPENAI_* env on reiwa.
   */
  interface BotAiRuntime {
    enabled: boolean;
    config: { OPENAI_API_KEY: string; OPENAI_API_URL: string; OPENAI_MODEL: string };
    overrides: string[];
  }

  const resolveAiConfig = async (): Promise<BotAiRuntime | null> => {
    let panelKey = "";
    let panelBaseUrl = "";
    let panelModel = "";
    let panelEnabled = false;
    let systemPrompt = "";
    let knowledge: string[] = [];

    if (adminClient) {
      try {
        const s = await adminClient.aiConfig.getSettings();
        panelKey = s.apiKey || "";
        panelBaseUrl = s.baseUrl || "";
        panelModel = s.model || "";
        panelEnabled = s.enabled === true;
        systemPrompt = s.systemPrompt || "";
      } catch (err) {
        deps.logger?.warn?.({ err }, "AI config panel fetch failed (bot)");
      }
      try {
        const instructions = await adminClient.aiConfig.getInstructions();
        knowledge = instructions
          .filter((i) => i.isActive)
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((i) => `# ${i.title}\n${i.content}`);
      } catch (err) {
        deps.logger?.warn?.({ err }, "AI instructions fetch failed (bot)");
      }
    }

    if (!panelKey) return null;
    return {
      enabled: panelEnabled,
      config: {
        OPENAI_API_KEY: panelKey,
        OPENAI_API_URL: panelBaseUrl || "",
        OPENAI_MODEL: panelModel || "gpt-4o-mini",
      },
      overrides: [systemPrompt, ...knowledge].filter((s) => s.trim().length > 0),
    };
  };

  // Every string on this page goes through the pack now. It used to be the one
  // page in the bot with no localization at all, and that produced the worst
  // possible combination: the model answers in the customer's own language
  // (the system prompt in `chat-client.ts` tells it to), and that answer
  // arrived wrapped in a Russian screen, under a Russian button, with a
  // Russian refusal whenever something went wrong.
  const langOf = (ctx: { from?: { id?: number } }): SupportedLocale =>
    coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));

  // Every one of those strings is operator copy too, and «Тексты бота» puts
  // emoji tokens into it. Three are sent with `parse_mode: "Markdown"` — their
  // default copy is Markdown — which cannot also carry entities and has no
  // custom-emoji syntax of its own, so they get glyphs, escaped where legacy
  // Markdown reserves a character (`markdownCopy`). The rest are plain messages
  // and get the pack emoji's entity too (`messageCopy`), and the exit button's
  // caption is drawn like every other one (`inlineButton`).
  const markdown = (key: string, lang: SupportedLocale, botCfg: CopyEmojis): string =>
    markdownCopy(deps.translator.t(key, lang), botCfg);

  // The config those renders read — reads this page made none of before —
  // asked for at each answer. A refresh against a hung panel must not hold an
  // answer, and every update queued behind it (they are handled one at a
  // time): past the budget, the config the bot holds.
  const copyConfig = (budgetMs: number) => configWithin(deps, budgetMs);

  const exitKeyboard = (lang: SupportedLocale, botCfg: CopyEmojis) =>
    new InlineKeyboard().text(
      inlineButton(deps.translator.t("ai_support.exit_button", lang), botCfg),
      AI_SUPPORT_EXIT_CALLBACK,
    );

  const clearSupportMode = (ctx: { session: unknown }) => {
    try {
      (ctx.session as Record<string, unknown>).aiSupportMode = false;
      (ctx.session as Record<string, unknown>).aiMessages = [];
    } catch {
      // Session might not be available — noop.
    }
  };

  // ── Tool executor — bridges AI tool calls to AdminClient ───────────
  const toolExecutor = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    switch (toolName) {
      case "get_tariffs": {
        if (!adminClient) {
          return JSON.stringify({ error: "Catalog service unavailable" });
        }
        try {
          const plans = await adminClient.catalog.getPublicPlans();
          return JSON.stringify(plans, null, 2);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return JSON.stringify({ error: `Failed to fetch tariffs: ${msg}` });
        }
      }

      case "get_faq": {
        if (!adminClient) {
          return JSON.stringify({ error: "FAQ service unavailable" });
        }
        try {
          const locale = typeof args.locale === "string" ? args.locale : null;
          const faq = await adminClient.faq.getPublicFaq(locale);
          return JSON.stringify(faq, null, 2);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return JSON.stringify({ error: `Failed to fetch FAQ: ${msg}` });
        }
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  };

  // ── /support command — enters AI support mode ──────────────────────
  bot.command("support", async (ctx) => {
    // Don't enter a dead support mode when the assistant is off/unconfigured.
    const lang = langOf(ctx);
    const runtime = await resolveAiConfig();
    const botCfg = await copyConfig(MESSAGE_CONFIG_BUDGET_MS);
    if (!runtime || !runtime.enabled) {
      await ctx.reply(markdown("ai_support.unavailable", lang, botCfg), {
        parse_mode: "Markdown",
      });
      return;
    }

    await ctx.reply(markdown("ai_support.intro", lang, botCfg), {
      parse_mode: "Markdown",
    });

    // Set the session flag — only if session is available
    try {
      (ctx.session as Record<string, unknown>).aiSupportMode = true;
    } catch {
      // Session might not be available
    }
  });

  // ── /cancel — exits AI support mode (the advertised escape hatch) ──
  bot.command(CANCEL_COMMAND, async (ctx, next) => {
    let wasInSupport = false;
    try {
      wasInSupport = !!(ctx.session as Record<string, unknown>).aiSupportMode;
    } catch {
      // Session not available — fall through to other handlers.
    }
    if (!wasInSupport) {
      return next();
    }
    clearSupportMode(ctx);
    await ctx.reply(markdown("ai_support.exited", langOf(ctx), await copyConfig(MESSAGE_CONFIG_BUDGET_MS)), {
      parse_mode: "Markdown",
    });
  });

  // ── Handle text messages in AI support mode ────────────────────────
  bot.hears(/.*/, async (ctx, next) => {
    // Only handle if in AI support mode
    let isInSupportMode = false;
    try {
      isInSupportMode = !!(ctx.session as Record<string, unknown>).aiSupportMode;
    } catch {
      // Session not available — pass through
      return next();
    }

    if (!isInSupportMode) {
      return next();
    }

    // Get the message text
    const text = ctx.message?.text;
    if (!text || text.startsWith("/")) {
      return next();
    }

    // Per-chat rate limit — bound paid LLM calls from one chat.
    const lang = langOf(ctx);
    const chatId = ctx.chat?.id;
    if (chatId !== undefined && isChatRateLimited(chatId)) {
      const botCfg = await copyConfig(MESSAGE_CONFIG_BUDGET_MS);
      await replyWithEntities(ctx, messageCopy(deps.translator.t("ai_support.rate_limited", lang), botCfg), {
        reply_markup: exitKeyboard(lang, botCfg),
      });
      return;
    }

    // Show typing indicator
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // Resolve OpenAI-compatible settings from panel (encrypted key) + master switch.
    const runtime = await resolveAiConfig();
    if (!runtime || !runtime.enabled) {
      clearSupportMode(ctx);
      await ctx.reply(markdown("ai_support.unavailable", lang, await copyConfig(MESSAGE_CONFIG_BUDGET_MS)), {
        parse_mode: "Markdown",
      });
      return;
    }

    // Build history from session
    const history: { role: "user" | "assistant"; content: string }[] = [];
    const sessionMessages = (ctx.session as Record<string, unknown>).aiMessages as
      | { role: "user" | "assistant"; content: string }[]
      | undefined;
    if (sessionMessages) {
      history.push(...sessionMessages);
    }

    try {
      const response = await generateResponseWithTools(
        runtime.config,
        text,
        history,
        toolExecutor,
        runtime.overrides,
      );

      // Store in session history
      const msgs = sessionMessages ?? [];
      msgs.push({ role: "user", content: text });
      msgs.push({ role: "assistant", content: response });
      // Keep last 10 pairs
      while (msgs.length > 20) {
        msgs.shift();
      }
      (ctx.session as Record<string, unknown>).aiMessages = msgs;

      // Send as PLAIN TEXT (no parse_mode): LLM output routinely contains
      // unbalanced Markdown, which Telegram rejects with a 400 "can't parse
      // entities" — that would throw the whole reply into the catch and lose an
      // answer we already paid for. Attach the exit keyboard. The answer is the
      // model's words, not operator copy: nothing in it is rendered.
      await ctx.reply(response, { reply_markup: exitKeyboard(lang, await copyConfig(MESSAGE_CONFIG_BUDGET_MS)) });
    } catch (err: unknown) {
      // Redact: log only the message/status, never the full error object (an
      // OpenAI SDK error can carry request headers incl. the Authorization key).
      const msg = err instanceof Error ? err.message : "Unknown error";
      deps.logger?.error?.({ err: msg }, "AI support response failed");
      // Keep the exit affordance on the error path too, so the user is never
      // stuck in support mode with no way out.
      const botCfg = await copyConfig(MESSAGE_CONFIG_BUDGET_MS);
      await replyWithEntities(ctx, messageCopy(deps.translator.t("ai_support.failed", lang), botCfg), {
        reply_markup: exitKeyboard(lang, botCfg),
      });
    }
  });

  // ── Exit AI support mode ───────────────────────────────────────────
  bot.callbackQuery(AI_SUPPORT_EXIT_CALLBACK, async (ctx) => {
    try {
      (ctx.session as Record<string, unknown>).aiSupportMode = false;
      (ctx.session as Record<string, unknown>).aiMessages = [];
    } catch {
      // Noop
    }
    // Made before the button is answered: the spinner waits on this edit.
    await ctx.editMessageText(markdown("ai_support.exited", langOf(ctx), await copyConfig(TOAST_CONFIG_BUDGET_MS)), {
      parse_mode: "Markdown",
    });
    await ctx.answerCallbackQuery();
  });
};
