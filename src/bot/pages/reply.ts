/**
 * Shared `replyWithEntities` helper — pages that render messages with
 * Telegram custom-emoji entities funnel through this so the
 * grammy-side detail (omit `entities` when empty so the API doesn't
 * reject the call) stays in one place.
 */
import type { TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';

interface ReplyableContext {
  reply: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

export async function replyWithEntities(
  ctx: ReplyableContext,
  message: { text: string; entities: TgCustomEmojiEntity[] },
  extra?: Record<string, unknown>,
): Promise<void> {
  await ctx.reply(message.text, {
    entities: message.entities.length > 0 ? message.entities : undefined,
    ...(extra ?? {}),
  });
}
