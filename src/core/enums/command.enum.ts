/**
 * Top-level bot commands reiwa exposes to Telegram. The values double as
 * the `/<command>` strings users type in the chat and the `command` field
 * in `Bot.api.setMyCommands` registration.
 */
export const BOT_COMMANDS = ['start', 'help', 'lang', 'rules', 'paysupport'] as const;
export type BotCommand = (typeof BOT_COMMANDS)[number];
