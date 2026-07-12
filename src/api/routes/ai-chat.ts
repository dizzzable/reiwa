/**
 * AI Chat REST API Route
 *
 * Provides an OpenAI-powered chat endpoint for the reiwa panel.
 * Users send a message and get an AI response backed by knowledge
 * base context. Conversational memory is kept in-memory (per
 * conversationId).
 *
 * POST /api/v1/ai-chat/message
 *   Body: { conversationId?: string, message: string }
 *   Returns: { response: string, conversationId: string }
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { generateResponse } from "../../core/ai/chat-client.js";
import { readKnowledgeBase } from "../../core/ai/knowledge-loader.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import type { ReiwaConfig } from "../../config.js";

// ── In-memory conversation store (simple Map, Redis later) ────────────
const conversations = new Map<string, { role: "user" | "assistant"; content: string }[]>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodic cleanup of stale conversations
setInterval(() => {
  const now = Date.now();
  // We don't store timestamps per conversation, so we keep the TTL
  // as a simple cleanup — this is in-memory only
}, CONVERSATION_TTL_MS);

const messageSchema = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1, "Message is required").max(4000, "Message too long"),
});

let knowledgeCache: string[] | null = null;
let knowledgeLastLoaded = 0;
const KNOWLEDGE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getKnowledgeContext(): Promise<string[]> {
  const now = Date.now();
  if (knowledgeCache && now - knowledgeLastLoaded < KNOWLEDGE_CACHE_TTL_MS) {
    return knowledgeCache;
  }
  try {
    knowledgeCache = await readKnowledgeBase();
    knowledgeLastLoaded = now;
  } catch {
    // Return last known content on error
    if (!knowledgeCache) {
      knowledgeCache = [];
    }
  }
  return knowledgeCache;
}

export function createAiChatRouter(deps: { config: ReiwaConfig }) {
  const { config } = deps;
  const router = Router();

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

    // Load knowledge base context
    const knowledgeEntries = await getKnowledgeContext();

    try {
      const response = await generateResponse(
        config,
        message,
        history,
        knowledgeEntries,
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
