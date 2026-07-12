/**
 * AI Support — Telegram Bot page
 *
 * Adds an AI-powered support mode to the bot:
 * - /support command enters the AI support mode
 * - While in support mode, any text message is answered by AI
 * - The AI uses knowledge base files for context
 * - /cancel or "❌ Выйти" exits support mode
 *
 * Extends the bot session with an `aiSupportMode` flag.
 */

import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { SessionFlavor } from "grammy";
import { generateResponse } from "../../core/ai/chat-client.js";
import { readKnowledgeBase } from "../../core/ai/knowledge-loader.js";
import type { PageRegistrar } from "./types.js";

// Extend session type to include AI support mode
declare module "grammy" {
  interface SessionFlavorExtension<S> {
    aiSupportMode?: boolean;
  }
}

export const registerAiSupportPage: PageRegistrar = (bot, deps) => {
  const { getConfig: _getConfig, ...rest } = deps;

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

    // Load knowledge base
    let knowledgeEntries: string[] = [];
    try {
      knowledgeEntries = await readKnowledgeBase();
    } catch {
      // No knowledge base — continue without
    }

    try {
      const response = await generateResponse(config, text, history, knowledgeEntries);

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
