/**
 * AI Chat REST API Route
 *
 * Provides an OpenAI-powered chat endpoint with function-calling.
 * Instead of loading static knowledge files, the AI fetches live
 * data (tariffs, FAQ) from the rezeis admin panel via AdminClient
 * tool calls.
 *
 * POST /api/v1/ai-chat/message
 *   Body: { conversationId?: string, message: string }
 *   Returns: { response: string, conversationId: string }
 *
 * AI config resolution:
 *   1. Local env vars (OPENAI_API_KEY, OPENAI_API_URL, OPENAI_MODEL)
 *   2. Fallback: rezeis internal API (/internal/ai-config/settings)
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  generateResponseWithTools,
  TOOL_DEFINITIONS,
} from "../../core/ai/chat-client.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import type { ReiwaConfig } from "../../config.js";
import type { AdminClient } from "../../infrastructure/admin-client/index.js";
import type { AiConfigSettings } from "../../infrastructure/admin-client/namespaces/ai-config.js";

// ── In-memory conversation store ─────────────────────────────────────
const conversations = new Map<string, { role: "user" | "assistant"; content: string }[]>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;

// Periodic cleanup
setInterval(() => {
  // Simple cleanup — in production use Redis with TTL
}, CONVERSATION_TTL_MS);

const messageSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1, "Message is required").max(4000, "Message too long"),
});

/**
 * Resolves AI config: first from local env, then from rezeis panel.
 */
async function resolveAiConfig(
  config: ReiwaConfig,
  adminClient: AdminClient | null,
): Promise<{ apiKey: string; baseUrl: string; model: string } | null> {
  // 1. Local env vars
  if (config.OPENAI_API_KEY) {
    return {
      apiKey: config.OPENAI_API_KEY,
      baseUrl: config.OPENAI_API_URL || "",
      model: config.OPENAI_MODEL || "gpt-4o-mini",
    };
  }

  // 2. Fallback: rezeis panel
  if (adminClient) {
    try {
      const settings = await adminClient.aiConfig.getSettings();
      if (settings.apiKey) {
        return {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || "",
          model: settings.model || "gpt-4o-mini",
        };
      }
    } catch (err) {
      // Silent fallback — log but don't crash
    }
  }

  return null;
}

function generateConvId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createAiChatRouter(deps: { config: ReiwaConfig; adminClient: AdminClient | null }) {
  const { config, adminClient } = deps;
  const router = Router();

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
          const faq = await adminClient.faq.getPublicFaq();
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

  router.post("/ai-chat/message", async (req: Request, res: Response) => {
    const log = getRequestLogger(req);

    // Resolve AI config (local env → rezeis panel)
    const aiConfig = await resolveAiConfig(config, adminClient);
    if (!aiConfig) {
      res.status(503).json({ error: "AI chat is not configured. Set OPENAI_API_KEY or configure in admin panel." });
      return;
    }

    // Validate body
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues.map((i) => i.message),
      });
      return;
    }

    const { conversationId, message } = parsed.data;
    const convId = conversationId ?? generateConvId();

    // Get or create conversation history
    if (!conversations.has(convId)) {
      conversations.set(convId, []);
    }
    const history = conversations.get(convId)!;

    try {
      const response = await generateResponseWithTools(
        {
          OPENAI_API_KEY: aiConfig.apiKey,
          OPENAI_API_URL: aiConfig.baseUrl,
          OPENAI_MODEL: aiConfig.model,
        },
        message,
        history,
        toolExecutor,
      );

      // Update conversation history
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: response });

      // Keep history trimmed to last 20 messages
      while (history.length > 20) {
        history.shift();
      }

      log.info(
        { conversationId: convId, messageLength: message.length, responseLength: response.length },
        "AI chat message processed",
      );

      res.json({ response, conversationId: convId });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      log.error({ err, conversationId: convId }, "AI chat completion failed");
      res.status(500).json({ error: "Failed to generate response" });
    }
  });

  return router;
}
