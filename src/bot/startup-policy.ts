export interface BotStartupPolicyInput {
  readonly nodeEnv: string | undefined;
  readonly botToken: string | undefined;
}

export function getMissingBotTokenError({
  nodeEnv,
  botToken,
}: BotStartupPolicyInput): string | null {
  if (nodeEnv !== "production" || botToken?.trim()) return null;

  return "BOT_TOKEN is required in production. Set BOT_TOKEN before starting reiwa-bot.";
}
