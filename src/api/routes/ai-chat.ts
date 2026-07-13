/**
 * AI Chat REST API Route
 *
 * OpenAI-powered chat endpoint with function-calling. Instead of loading
 * static knowledge files, the AI fetches live data (tariffs, FAQ) from the
 * rezeis admin panel via AdminClient tool calls.
 *
 * POST /api/v1/ai-chat/message
 *   Body: { conversationId?: string, message: string }
 *   Returns: { response: string, conversationId: string }
 *
 * Security: the endpoint REQUIRES an authenticated session (web or Telegram)
 * and is throttled per IP by a dedicated Redis limiter — each message can fan
 * out to two paid LLM completions, so it must never be an open proxy.
 * Conversations are bound to the caller's identity so one user can never read
 * or append to another's history.
 *
 * AI config resolution:
 *   1. Local env vars (OPENAI_API_KEY, OPENAI_API_URL, OPENAI_MODEL)
 *   2. Fallback: rezeis internal API (/internal/ai-config/settings)
 */

import { Router, type Response } from "express";
import { z } from "zod";
import { generateResponseWithTools, summarizeUserMemory } from "../../core/ai/chat-client.js";
import { ConversationMemory, UserMemory } from "../../core/ai/conversation-memory.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";
import { createRedisRateLimiter } from "../middleware/rate-limit.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import type { ReiwaConfig } from "../../config.js";
import type { AdminClient } from "../../infrastructure/admin-client/index.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { WebSessionStore } from "../../infrastructure/redis/session.js";

const messageSchema = z.object({
  conversationId: z.string().max(128).optional(),
  message: z.string().min(1, "Message is required").max(4000, "Message too long"),
});

interface AiRuntime {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** Operator-curated knowledge (active ai_instructions) injected as context. */
  knowledge: string[];
}

// Short in-process cache so we don't hit the rezeis panel on every message.
let cachedRuntime: { value: AiRuntime | null; at: number } | null = null;
const RUNTIME_TTL_MS = 30_000;

/**
 * Resolves the AI runtime. The panel is the source of truth for the master
 * `enabled` switch, operator persona (`systemPrompt`) and curated knowledge; a
 * local env `OPENAI_API_KEY` is treated as an explicit opt-in (enabled) and
 * overrides the key/URL/model. Fails closed: no resolvable key → null.
 */
async function resolveAiRuntime(
  config: ReiwaConfig,
  adminClient: AdminClient | null,
  onError: (err: unknown) => void,
): Promise<AiRuntime | null> {
  const now = Date.now();
  if (cachedRuntime && now - cachedRuntime.at < RUNTIME_TTL_MS) return cachedRuntime.value;

  const envKey = config.OPENAI_API_KEY;
  let panelKey = "";
  let panelBaseUrl = "";
  let panelModel = "";
  let panelEnabled = false;
  let systemPrompt = "";
  let knowledge: string[] = [];

  if (adminClient) {
    try {
      const settings = await adminClient.aiConfig.getSettings();
      panelKey = settings.apiKey || "";
      panelBaseUrl = settings.baseUrl || "";
      panelModel = settings.model || "";
      panelEnabled = settings.enabled === true;
      systemPrompt = settings.systemPrompt || "";
    } catch (err) {
      onError(err);
    }
    try {
      const instructions = await adminClient.aiConfig.getInstructions();
      knowledge = instructions
        .filter((i) => i.isActive)
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((i) => `# ${i.title}\n${i.content}`);
    } catch (err) {
      onError(err);
    }
  }

  const apiKey = envKey || panelKey;
  let runtime: AiRuntime | null = null;
  if (apiKey) {
    runtime = {
      // Env key = explicit opt-in; otherwise the panel toggle governs.
      enabled: envKey ? true : panelEnabled,
      apiKey,
      baseUrl: envKey ? config.OPENAI_API_URL || "" : panelBaseUrl,
      model: (envKey ? config.OPENAI_MODEL : panelModel) || "gpt-4o-mini",
      systemPrompt,
      knowledge,
    };
  }

  cachedRuntime = { value: runtime, at: now };
  return runtime;
}

function generateConvId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createAiChatRouter(deps: {
  config: ReiwaConfig;
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  webSessionStore: WebSessionStore | null;
}) {
  const { config, adminClient, sessionStore, webSessionStore } = deps;
  const router = Router();
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const redis = webSessionStore?.getRedis() ?? null;
  const aiLimiter = createRedisRateLimiter(redis, "aiChat");
  // Durable per-user conversation memory (Redis, sliding TTL; in-memory fallback).
  const memory = new ConversationMemory(redis);
  // Long-term per-user memory summary (facts injected into future chats).
  const userMemory = new UserMemory(redis);
  // Refresh the long-term summary at most once per this many turns (or when empty).
  const MEMORY_REFRESH_EVERY = 3;

  // ── Tool executor — bridges AI tool calls to AdminClient ───────────
  const toolExecutor = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    switch (toolName) {
      case "get_tariffs": {
        if (!adminClient) return JSON.stringify({ error: "Catalog service unavailable" });
        try {
          return JSON.stringify(await adminClient.catalog.getPublicPlans(), null, 2);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return JSON.stringify({ error: `Failed to fetch tariffs: ${msg}` });
        }
      }
      case "get_faq": {
        if (!adminClient) return JSON.stringify({ error: "FAQ service unavailable" });
        try {
          const locale = typeof args.locale === "string" ? args.locale : null;
          return JSON.stringify(await adminClient.faq.getPublicFaq(locale), null, 2);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return JSON.stringify({ error: `Failed to fetch FAQ: ${msg}` });
        }
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  };

  // GET /ai-chat/config — lets the cabinet know whether to SHOW the AI tab.
  // When disabled (or unconfigured) the assistant is hidden from users entirely.
  router.get("/ai-chat/config", requireSession, async (req: AuthRequest, res: Response) => {
    const log = getRequestLogger(req);
    const runtime = await resolveAiRuntime(config, adminClient, (err) =>
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "AI config resolve failed"),
    );
    res.json({ enabled: !!runtime && runtime.enabled });
  });

  router.post(
    "/ai-chat/message",
    requireSession,
    aiLimiter,
    async (req: AuthRequest, res: Response) => {
      const log = getRequestLogger(req);

      const runtime = await resolveAiRuntime(config, adminClient, (err) =>
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "AI config resolve failed"),
      );
      if (!runtime) {
        res.status(503).json({
          error: "AI chat is not configured. Set OPENAI_API_KEY or configure in admin panel.",
        });
        return;
      }
      // Disabled by the operator → refuse (the UI also hides the entry point).
      if (!runtime.enabled) {
        res.status(403).json({ error: "AI chat is disabled" });
        return;
      }

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

      // Bind the conversation to the caller — a foreign conversationId resolves
      // to a fresh, owner-scoped history (never another user's transcript).
      const identity = resolveUserIdentity(req);
      const ownerKey = identity.userId ?? identity.telegramId;
      if (!ownerKey) {
        // requireSession ran, but be defensive — never fall back to a shared
        // bucket that could mix users' memory.
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const storeKey = `${ownerKey}::${convId}`;

      const history = await memory.get(storeKey);
      const longTerm = await userMemory.get(ownerKey);

      // Operator persona + curated knowledge + the long-term memory note, all
      // injected below the (non-overridable) security preamble in the client.
      const overrides = [
        runtime.systemPrompt,
        ...runtime.knowledge,
        longTerm.summary ? `Заметка о пользователе (справочно): ${longTerm.summary}` : "",
      ].filter((s) => s.trim().length > 0);

      try {
        const response = await generateResponseWithTools(
          {
            OPENAI_API_KEY: runtime.apiKey,
            OPENAI_API_URL: runtime.baseUrl,
            OPENAI_MODEL: runtime.model,
          },
          message,
          history,
          toolExecutor,
          overrides,
        );

        // Persist the turn to durable memory (trim + sliding TTL handled inside).
        await memory.append(storeKey, [
          { role: "user", content: message },
          { role: "assistant", content: response },
        ]);

        // Refresh the long-term per-user memory — throttled + fire-and-forget so
        // it never adds latency to the reply. Failures are non-fatal.
        const nextTurns = longTerm.turnsSinceUpdate + 1;
        // Refresh on the very first turn (never summarised) or every N turns —
        // gate the first-run branch on updatedAt, NOT on an empty summary, so a
        // chat with nothing worth remembering doesn't re-summarise every turn.
        if (longTerm.updatedAt === 0 || nextTurns >= MEMORY_REFRESH_EVERY) {
          void (async () => {
            try {
              const recent = await memory.get(storeKey);
              const summary = await summarizeUserMemory(
                {
                  OPENAI_API_KEY: runtime.apiKey,
                  OPENAI_API_URL: runtime.baseUrl,
                  OPENAI_MODEL: runtime.model,
                },
                longTerm.summary,
                recent,
              );
              await userMemory.save(ownerKey, { summary, turnsSinceUpdate: 0, updatedAt: Date.now() });
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "long-term memory refresh failed",
              );
            }
          })();
        } else {
          void userMemory
            .save(ownerKey, { ...longTerm, turnsSinceUpdate: nextTurns })
            .catch(() => undefined);
        }

        log.info(
          { conversationId: convId, messageLength: message.length, responseLength: response.length },
          "AI chat message processed",
        );

        res.json({ response, conversationId: convId });
      } catch (err: unknown) {
        // Redact: an OpenAI SDK error can carry the Authorization header.
        log.error(
          { err: err instanceof Error ? err.message : String(err), conversationId: convId },
          "AI chat completion failed",
        );
        res.status(502).json({ error: "Failed to generate response" });
      }
    },
  );

  return router;
}
