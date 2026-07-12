/**
 * AI Chat Client — OpenAI-compatible chat completion wrapper.
 *
 * Provides a unified interface for AI-powered conversations across
 * the REST API and Telegram bot. All OpenAI configuration is sourced
 * from the application config (env vars), so operators can switch
 * providers by changing OPENAI_API_URL.
 *
 * Supports OpenAI function calling so the AI can fetch live data
 * from the admin panel (tariffs, FAQ) instead of relying on static
 * knowledge files — feature-complete with the old knowledge/ dir
 * approach but always up to date.
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
 * OpenAI tool definitions for the AI assistant.
 *
 * These let the model request live data from the admin panel instead
 * of relying on static knowledge base files.
 */
export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_tariffs',
      description: 'Возвращает актуальные тарифы и цены из каталога сервиса',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_faq',
      description: 'Возвращает список часто задаваемых вопросов и ответов на них',
      parameters: {
        type: 'object',
        properties: {
          locale: {
            type: 'string',
            description: 'Код языка для фильтрации (например "ru" или "en")',
          },
        },
        additionalProperties: false,
      },
    },
  },
];

/**
 * Generate an AI response with tool-calling support.
 *
 * Sends the user message plus tool definitions to OpenAI. If the model
 * requests a tool call (get_tariffs / get_faq), the `toolExecutor`
 * callback is invoked, the result is fed back to the model, and the
 * final assistant response is returned.
 *
 * @param config         OpenAI connection settings
 * @param message        Current user message
 * @param history        Previous conversation history (user/assistant only)
 * @param toolExecutor   Async callback that handles tool invocations
 * @param systemPromptOverrides  Optional extra context injected below the base prompt
 * @returns              Final assistant response text
 */
export async function generateResponseWithTools(
  config: Pick<ReiwaConfig, 'OPENAI_API_KEY' | 'OPENAI_API_URL' | 'OPENAI_MODEL'>,
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  toolExecutor: (toolName: string, args: Record<string, unknown>) => Promise<string>,
  systemPromptOverrides?: string[],
): Promise<string> {
  const ai = getClient(config);

  // ── Build messages ────────────────────────────────────────────────
  const systemPrompt = systemPromptOverrides?.length
    ? buildSystemPrompt(systemPromptOverrides)
    : buildSystemPrompt();

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    { role: 'user', content: message },
  ];

  // ── First call — includes tool definitions ────────────────────────
  const response = await ai.chat.completions.create({
    model: cachedModel,
    messages,
    tools: TOOL_DEFINITIONS,
    max_tokens: 2048,
  });

  const choice = response.choices[0];
  if (!choice) {
    throw new Error('No completion choices returned from AI');
  }

  const responseMessage = choice.message;

  // If the model didn't request any tool calls, return content directly
  if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
    return responseMessage.content ?? '';
  }

  // ── Tool-calling round — execute each tool and collect results ────
  const assistantMsg: ChatCompletionMessageParam = {
    role: 'assistant',
    content: responseMessage.content ?? null,
    tool_calls: responseMessage.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    })),
  };

  const toolMessages: ChatCompletionMessageParam[] = [assistantMsg];

  for (const toolCall of responseMessage.tool_calls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch {
      // Malformed JSON from the model — use empty args
      args = {};
    }

    let result: string;
    try {
      result = await toolExecutor(toolCall.function.name, args);
    } catch (err) {
      result = `Ошибка выполнения: ${err instanceof Error ? err.message : 'Неизвестная ошибка'}`;
    }

    toolMessages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: result,
    });
  }

  // ── Final call — model produces answer with tool results in context ─
  const finalResponse = await ai.chat.completions.create({
    model: cachedModel,
    messages: [...messages, ...toolMessages],
    max_tokens: 2048,
  });

  const finalChoice = finalResponse.choices[0];
  return finalChoice?.message?.content ?? '';
}

/**
 * @deprecated Use `generateResponseWithTools` instead. Kept for
 * backward compatibility with existing callers. The old function
 * injects knowledge base entries as static system-context rather
 * than fetching live data via tool calls.
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
 * Build a system prompt that instructs the AI on its role and,
 * optionally, injects additional context / overrides.
 *
 * The base prompt now mentions that the AI has access to live data
 * through the get_tariffs and get_faq tools rather than a static
 * knowledge base.
 */
function buildSystemPrompt(overrides?: string[]): string {
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
9. У тебя есть доступ к актуальным данным через встроенные инструменты. Используй get_tariffs для получения информации о тарифах и ценах, и get_faq для получения ответов на частые вопросы.`;

  if (!overrides || overrides.length === 0) {
    return base;
  }

  const overridesSection = `\n\n--- ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ ---\n${overrides.join('\n\n')}\n--- КОНЕЦ ДОПОЛНИТЕЛЬНОГО КОНТЕКСТА ---`;

  return base + overridesSection;
}
