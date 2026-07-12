/**
 * AI Chat Client — OpenAI-compatible chat completion wrapper.
 *
 * Provides a unified interface for AI-powered conversations across
 * the REST API and Telegram bot. All OpenAI configuration is sourced
 * from the application config (env vars), so operators can switch
 * providers by changing OPENAI_API_URL.
 *
 * Knowledge base entries (from the knowledge/ directory) are injected
 * as system-context when provided, giving the model project-specific
 * awareness without exposing the underlying technical stack.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/index.js';
import type { ReiwaConfig } from '../config/app.config.js';

let client: OpenAI | null = null;
let cachedModel = '';
let cachedConfig: Pick<ReiwaConfig, 'OPENAI_API_KEY' | 'OPENAI_API_URL' | 'OPENAI_MODEL'> | null = null;

function getClient(config: Pick<ReiwaConfig, 'OPENAI_API_KEY' | 'OPENAI_API_URL' | 'OPENAI_MODEL'>): OpenAI {
  const key = config.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const apiUrl = config.OPENAI_API_URL || undefined;
  if (
    !client ||
    cachedConfig?.OPENAI_API_KEY !== key ||
    cachedConfig?.OPENAI_API_URL !== apiUrl
  ) {
    client = new OpenAI({
      apiKey: key,
      baseURL: apiUrl,
    });
    cachedConfig = { ...config };
  }
  cachedModel = config.OPENAI_MODEL;
  return client;
}

/**
 * Create a chat completion with optional tool calling.
 */
export async function createChatCompletion(
  config: Pick<ReiwaConfig, 'OPENAI_API_KEY' | 'OPENAI_API_URL' | 'OPENAI_MODEL'>,
  messages: ChatCompletionMessageParam[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
): Promise<string> {
  const ai = getClient(config);
  const response = await ai.chat.completions.create({
    model: cachedModel,
    messages,
    tools,
    max_tokens: 2048,
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error('No completion choices returned from AI');
  }

  const content = choice.message.content;
  return content ?? '';
}

/**
 * Generate an AI response for a user message, optionally injecting
 * knowledge base context.
 */
export async function generateResponse(
  config: Pick<ReiwaConfig, 'OPENAI_API_KEY' | 'OPENAI_API_URL' | 'OPENAI_MODEL'>,
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  knowledgeEntries?: string[],
): Promise<string> {
  const systemPrompt = buildSystemPrompt(knowledgeEntries);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    { role: 'user', content: message },
  ];

  return createChatCompletion(config, messages);
}

/**
 * Build a system prompt that instructs the AI on its role and injects
 * knowledge base entries for context.
 */
function buildSystemPrompt(knowledgeEntries?: string[]): string {
  const base = `Ты — дружелюбный AI-помощник службы поддержки. Твоя задача — помогать пользователям с вопросами о нашем сервисе.

ВАЖНЫЕ ПРАВИЛА:
1. Отвечай только на русском языке.
2. Будь вежливым, дружелюбным и полезным.
3. Используй эмодзи для создания дружелюбной атмосферы.
4. Если вопрос касается технических деталей — дай простую пошаговую инструкцию.
5. НЕ упоминай технический стек: никаких Remnawave, Xray, протоколов, VPN-протоколов, панелей управления.
6. Если не знаешь ответа — честно скажи об этом и предложи обратиться в поддержку.
7. Отвечай кратко и по делу, но достаточно подробно, чтобы помочь.
8. Если пользователь спрашивает о статусе подписки или тарифах, посоветуй зайти в личный кабинет через Mini App или сайт.
9. Не выдумывай тарифы или цены — используй только информацию из базы знаний.`;

  if (!knowledgeEntries || knowledgeEntries.length === 0) {
    return base;
  }

  const knowledgeSection = `\n\n--- БАЗА ЗНАНИЙ ---\n${knowledgeEntries.join('\n\n')}\n--- КОНЕЦ БАЗЫ ЗНАНИЙ ---\n\nИспользуй информацию из базы знаний для ответа на вопросы пользователя. Если информации недостаточно, честно скажи об этом.`;

  return base + knowledgeSection;
}
