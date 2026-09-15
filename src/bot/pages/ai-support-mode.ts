/**
 * AI-support mode: the session flag and the two ways out of it.
 *
 * Split from `ai-support.ts` so the channel gate middleware can name them
 * without importing the page, and with it the OpenAI client. The gate lets both
 * ways out through (`middleware/channel-gate.ts`): leaving a mode is not a
 * feature the gate protects, and a user it stops must not be trapped in one.
 */

export const CANCEL_COMMAND = 'cancel';
export const AI_SUPPORT_EXIT_CALLBACK = 'ai_support_exit';

/** Whether this chat is in AI-support mode. `false` where there is no session to read. */
export function isInAiSupportMode(ctx: { readonly session?: unknown }): boolean {
  try {
    return (ctx.session as Record<string, unknown> | undefined)?.aiSupportMode === true;
  } catch {
    // grammY's session getter throws for an update with no session key.
    return false;
  }
}
