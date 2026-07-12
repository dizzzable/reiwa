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
import type { Context } from "grammy";
import type { SessionFlavor } from "grammy";
import {
  generateResponseWithTools,
  TOOL_DEFINITIONS,
} from "../../core/ai/chat-client.js";
import type { PageRegistrar } from "./types.js";

// Extend session type to include AI support mode
declare module "grammy" {
  interface SessionFlavorExtension<S> {
    aiSupportMode?: boolean;
  }
}

export const registerAiSupportPage: PageRegistrar = (bot, deps) => {
  const { getConfig: _getConfig, adminClient } = deps;

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
    const lang = (ctx.from?.language_code ?? "ru") as "ru" | "en";

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

    // Show typing indicator
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");

    // Get config for OpenAI settings
    const { loadConfig } = await import("../../config.js");
    const config = loadConfig();

    if (!config.OPENAI_API_KEY) {
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
        config,
        text,
        history,
        toolExecutor,
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

      // Send the response with a keyboard to exit support mode
      const kb = new InlineKeyboard().text("❌ Выйти из поддержки", "ai_support_exit");
      await ctx.reply(response, {
        parse_mode: "Markdown",
        reply_markup: kb,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      deps.logger?.error?.({ err }, "AI support response failed");
      await ctx.reply(
        "😔 *Ошибка*\n\nНе удалось получить ответ. Попробуй ещё раз или напиши /cancel для выхода.",
        { parse_mode: "Markdown" },
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
