import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { probeChannelMembership, type ChatMemberApi } from "../../bot/lib/channel-gate.js";
import { createFlexibleSessionMiddleware } from "../middleware/session.js";
import type { AuthRequest } from "../middleware/session.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";
import { isUpstreamStatus } from "../lib/upstream-error.js";
import { parseTelegramUserId } from "../lib/telegram-user-id.js";
import { createChatMemberApi } from "./channel-gate.js";

/** What the panel attaches to a «needs the channel» refusal. */
interface ChannelAsk {
  readonly chatId: string;
  readonly joinUrl: string;
  readonly telegramId: string | null;
}

interface EnterAnswer {
  readonly entered: boolean;
  readonly reason: string | null;
  readonly channel?: ChannelAsk;
}

function readEnterAnswer(value: unknown): EnterAnswer {
  if (typeof value !== "object" || value === null) return { entered: false, reason: "NOT_OPEN" };
  const record = value as Record<string, unknown>;
  const channel = record.channel;
  const ask =
    typeof channel === "object" &&
    channel !== null &&
    typeof (channel as Record<string, unknown>).chatId === "string" &&
    typeof (channel as Record<string, unknown>).joinUrl === "string"
      ? {
          chatId: (channel as Record<string, unknown>).chatId as string,
          joinUrl: (channel as Record<string, unknown>).joinUrl as string,
          telegramId:
            typeof (channel as Record<string, unknown>).telegramId === "string"
              ? ((channel as Record<string, unknown>).telegramId as string)
              : null,
        }
      : undefined;
  return {
    entered: record.entered === true,
    reason: typeof record.reason === "string" ? record.reason : null,
    ...(ask === undefined ? {} : { channel: ask }),
  };
}

/**
 * Contests — events with a draw at the end — for the person entering them.
 *
 * Session-scoped like the wheel and the quests: the identity is resolved from
 * the reiwa session and forwarded as `:userRef`, so a person only ever reads
 * their own standing and enters as themselves.
 *
 * ── A contest that needs a channel ────────────────────────────────────────
 *
 * The panel has no bot token, so it cannot ask Telegram whether somebody is
 * in the contest's channel. Entering is two calls then: the panel refuses the
 * first with `CHANNEL_REQUIRED` and names the chat and the person's Telegram
 * id; this route asks Telegram once and enters again with the answer. A
 * Telegram that cannot be asked — no token here, an outage, a bot that is not
 * an admin of the channel — sends `null`, which the panel lets in, the rule
 * «Канал обязателен» follows. What goes back to the browser is the reason and
 * the link to join; the chat id and the Telegram id stay on this side.
 */
export function createContestsRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
  /** Who asks Telegram. Built from the config when omitted; a spec passes its own. */
  chatMemberApi?: ChatMemberApi | null;
}) {
  const { adminClient, sessionStore, config } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const telegram = deps.chatMemberApi === undefined ? createChatMemberApi(config) : deps.chatMemberApi;
  const router = Router();

  // GET /api/v1/contests — running contests, results, and finished contests' winners.
  router.get("/contests", requireSession, async (req: AuthRequest, res) => {
    try {
      const result = await adminClient?.contests.list(resolveUserIdentity(req));
      res.json(result ?? []);
    } catch (err: unknown) {
      // Same reasoning as the wheel: a panel that predates contests answers
      // 404, this runs on every dashboard render, and "no contests" is a
      // truthful answer the screen already draws.
      if (isUpstreamStatus(err, 404)) {
        getRequestLogger(req).warn("GET /contests: panel does not have contests yet");
        res.json([]);
        return;
      }
      getRequestLogger(req).error({ err }, "GET /contests failed");
      res.status(500).json({ error: "internal" });
    }
  });

  // POST /api/v1/contests/:contestId/enter — take part.
  router.post("/contests/:contestId/enter", requireSession, async (req: AuthRequest, res) => {
    const contestId = String(req.params.contestId);
    try {
      if (adminClient === null) {
        res.json({ entered: false, reason: "NOT_OPEN" });
        return;
      }
      const identity = resolveUserIdentity(req);
      let answer = readEnterAnswer(await adminClient.contests.enter(identity, contestId));
      const ask = answer.channel;
      if (answer.reason === "CHANNEL_REQUIRED" && ask !== undefined) {
        const telegramUserId = parseTelegramUserId(ask.telegramId);
        let member: boolean | null = null;
        if (telegram !== null && telegramUserId !== null) {
          member = await probeChannelMembership(telegram, ask.chatId, telegramUserId);
        }
        if (member === null) {
          getRequestLogger(req).warn(
            { contestId, hasToken: telegram !== null },
            "POST /contests/:contestId/enter: channel membership could not be checked; the panel lets the entry in",
          );
        }
        answer = readEnterAnswer(await adminClient.contests.enter(identity, contestId, member));
      }
      res.json({
        entered: answer.entered,
        reason: answer.reason,
        ...(answer.reason === "CHANNEL_REQUIRED" && ask !== undefined ? { joinUrl: ask.joinUrl } : {}),
      });
    } catch (err: unknown) {
      getRequestLogger(req).warn({ err, contestId }, "POST /contests/:contestId/enter failed");
      const status = isUpstreamStatus(err, 404) ? 404 : isUpstreamStatus(err, 400) ? 400 : 500;
      res.status(status).json({ error: status === 500 ? "internal" : "entry_rejected" });
    }
  });

  return router;
}
