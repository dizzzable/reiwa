/**
 * AI Support — Telegram Bot page
 *
 * Adds an AI-powered support mode to the bot:
 * - /support command enters the AI support mode
 * - While in support mode, any text message is answered by AI
 * - The AI uses function calling to fetch live data from the admin panel
 * - /cancel or "❌ Выйти" exits support mode
 *
 * Extends the bot session with an `aiSupportMode` flag.
 */

import { InlineKeyboard } from "grammy";
import { generateResponseWithTools } from "../../core/ai/chat-client.js";
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
   * Resolve OpenAI settings the same way the cabinet does: local env first,
   * then the rezeis panel config. Without this the bot would report "AI
   * unavailable" whenever the key is set ONLY in the panel (the documented
   * fallback path), while the cabinet works — an inconsistent half-config.
   */
  interface BotAiRuntime {
    enabled: boolean;
    config: { OPENAI_API_KEY: string; OPENAI_API_URL: string; OPENAI_MODEL: string };
    overrides: string[];
  }

  const resolveAiConfig = async (): Promise<BotAiRuntime | null> => {
    const { loadConfig } = await import("../../config.js");
    const envConfig = loadConfig();
    const envKey = envConfig.OPENAI_API_KEY;

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

    const apiKey = envKey || panelKey;
    if (!apiKey) return null;
    return {
      enabled: envKey ? true : panelEnabled,
      config: {
        OPENAI_API_KEY: apiKey,
        OPENAI_API_URL: (envKey ? envConfig.OPENAI_API_URL : panelBaseUrl) || "",
        OPENAI_MODEL: (envKey ? envConfig.OPENAI_MODEL : panelModel) || "gpt-4o-mini",
      },
      overrides: [systemPrompt, ...knowledge].filter((s) => s.trim().length > 0),
    };
  };

  const exitKeyboard = () => new InlineKeyboard().text("❌ Выйти из поддержки", "ai_support_exit");

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
    const runtime = await resolveAiConfig();
    if (!runtime || !runtime.enabled) {
      await ctx.reply(
        "😔 *AI-поддержка временно недоступна*\n\nПожалуйста, обратись к оператору через /help",
        { parse_mode: "Markdown" },
      );
      return;
    }

    await ctx.reply(
      "🤖 *Режим AI-поддержки*\n\n"
      + "Привет! Я AI-помощник. Задавай любые вопросы о нашем сервисе.\n"
      + "Я могу рассказать о тарифах, помочь с настройкой приложений, "
      + "подсказать решение проблем.\n\n"
      + "Просто напиши свой вопрос, и я отвечу! 📝\n\n"
      + "_Чтобы выйти из режима, напиши /cancel_",
      { parse_mode: "Markdown" },
    );

    // Set the session flag — only if session is available
    try {
      (ctx.session as Record<string, unknown>).aiSupportMode = true;
    } catch {
      // Session might not be available
    }
  });

  // ── /cancel — exits AI support mode (the advertised escape hatch) ──
  bot.command("cancel", async (ctx, next) => {
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
    await ctx.reply(
      "✅ *Режим AI-поддержки завершён*\n\nЕсли понадобится помощь — пиши /support или /help",
      { parse_mode: "Markdown" },
    );
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
    const chatId = ctx.chat?.id;
    if (chatId !== undefined && isChatRateLimited(chatId)) {
      await ctx.reply("⏳ Слишком много сообщений подряд. Подожди немного и попробуй снова.", {
        reply_markup: exitKeyboard(),
      });
      return;
    }

    // Show typing indicator
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // Resolve OpenAI settings (env → rezeis panel) + the operator master switch.
    const runtime = await resolveAiConfig();
    if (!runtime || !runtime.enabled) {
      clearSupportMode(ctx);
      await ctx.reply(
        "😔 *AI-поддержка временно недоступна*\n\n"
        + "Пожалуйста, обратись к оператору через /help",
        { parse_mode: "Markdown" },
      );
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
      // answer we already paid for. Attach the exit keyboard.
      await ctx.reply(response, { reply_markup: exitKeyboard() });
    } catch (err: unknown) {
      // Redact: log only the message/status, never the full error object (an
      // OpenAI SDK error can carry request headers incl. the Authorization key).
      const msg = err instanceof Error ? err.message : "Unknown error";
      deps.logger?.error?.({ err: msg }, "AI support response failed");
      // Keep the exit affordance on the error path too, so the user is never
      // stuck in support mode with no way out.
      await ctx.reply(
        "😔 Не удалось получить ответ. Попробуй ещё раз или напиши /cancel для выхода.",
        { reply_markup: exitKeyboard() },
      );
    }
  });

  // ── Exit AI support mode ───────────────────────────────────────────
  bot.callbackQuery("ai_support_exit", async (ctx) => {
    try {
      (ctx.session as Record<string, unknown>).aiSupportMode = false;
      (ctx.session as Record<string, unknown>).aiMessages = [];
    } catch {
      // Noop
    }
    await ctx.editMessageText(
      "✅ *Режим AI-поддержки завершён*\n\n"
      + "Если понадобится помощь — пиши /support или /help",
      { parse_mode: "Markdown" },
    );
    await ctx.answerCallbackQuery();
  });
};
