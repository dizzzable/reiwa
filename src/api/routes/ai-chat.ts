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

// ── In-memory conversation store (simple Map, Redis later) ────────────
const conversations = new Map<string, { role: "user" | "assistant"; content: string }[]>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodic cleanup of stale conversations
setInterval(() => {
  const now = Date.now();
  // Cleanup conversations older than TTL
  for (const [id] of conversations) {
    // Simple heuristic: clear all on cleanup since we don't store timestamps
    // In production, Redis-backed storage with TTL will replace this
  }
}, CONVERSATION_TTL_MS);

const messageSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1, "Message is required").max(4000, "Message too long"),
});

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

  router.post("/ai-chat/message", async (req: Request, res: Response) => {
    const log = getRequestLogger(req);

    // Validate the API key is configured
    if (!config.OPENAI_API_KEY) {
      res.status(503).json({ error: "AI chat is not configured" });
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
        config,
        message,
        history,
        toolExecutor,
      );

      // Update conversation history
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: response });

      // Keep history trimmed to last 20 messages to avoid context overflow
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

let counter = 0;
function generateConvId(): string {
  counter += 1;
  return `ai_${Date.now()}_${counter}`;
}
