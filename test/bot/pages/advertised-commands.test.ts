import { describe, expect, it } from 'vitest';

import { BOT_COMMANDS } from '../../../src/core/enums/command.enum.js';
import {
  registerAiSupportPage,
  registerClosePage,
  registerDynamicScreenPage,
  registerHelpCallbackPage,
  registerHelpCommandPage,
  registerInlineSharePage,
  registerInvitePage,
  registerLangPage,
  registerMenuPage,
  registerPaySupportPage,
  registerQuestChannelPage,
  registerRulesPage,
  registerStartPage,
  type PageRegistrar,
} from '../../../src/bot/pages/index.js';
import { buildDeps, buildFakeBot } from './helpers.js';

/**
 * Every command the bot advertises must actually do something.
 *
 * `BOT_COMMANDS` is not a documentation list — `registerSlashCommands` sends it
 * straight to Telegram with `setMyCommands`, so every entry becomes a row in
 * the `/` autocomplete bubble that users can tap. Two of them (`rules`,
 * `paysupport`) sat there for a long time with no `bot.command` handler
 * anywhere. Tapping them did nothing at all: the AI-support catch-all swallows
 * anything starting with `/`, so there was not even an error to notice.
 *
 * Nothing about that failure is visible from either side on its own. The
 * command list looks complete; each page looks complete. Only putting the two
 * together shows the gap, which is exactly what this file does — and why it
 * asserts over the WHOLE list rather than naming the two that were missing.
 *
 * NOT asserted, deliberately: the reverse direction. `/support` and `/cancel`
 * have handlers (`ai-support.ts`) and are not advertised, which is a product
 * choice about a feature that costs money per message — not an oversight to
 * fail a build over. If that ever changes, the assertion to add is here.
 */

const REGISTRARS: readonly PageRegistrar[] = [
  registerLangPage,
  registerInvitePage,
  registerInlineSharePage,
  registerRulesPage,
  registerHelpCallbackPage,
  registerHelpCommandPage,
  registerPaySupportPage,
  registerMenuPage,
  registerStartPage,
  registerQuestChannelPage,
  registerClosePage,
  registerDynamicScreenPage,
  registerAiSupportPage,
];

function registeredCommands(): Set<string> {
  const bot = buildFakeBot();
  const { deps } = buildDeps();
  for (const register of REGISTRARS) {
    register(bot as unknown as Parameters<PageRegistrar>[0], deps);
  }
  return new Set(bot.commandHandlers.keys());
}

describe('advertised slash commands', () => {
  it('has a handler for every command sent to setMyCommands', () => {
    const handled = registeredCommands();
    const missing = BOT_COMMANDS.filter((command) => !handled.has(command));
    // Named rather than counted: a failure should say WHICH command is dead,
    // because the fix differs per command and the list will grow.
    expect(missing).toStrictEqual([]);
  });

  it('registers each advertised command exactly once', () => {
    // `commandHandlers` is a Map, so a second registration silently replaces
    // the first — the last page registered would win, quietly, depending on the
    // order in `main.ts`. Counting registrations catches the duplicate that a
    // presence check cannot.
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    const seen: string[] = [];
    const recorder = {
      ...bot,
      command(name: string, handler: Parameters<typeof bot.command>[1]) {
        seen.push(name);
        bot.command(name, handler);
      },
    };
    for (const register of REGISTRARS) {
      register(recorder as unknown as Parameters<PageRegistrar>[0], deps);
    }

    const duplicates = seen.filter((name, i) => seen.indexOf(name) !== i);
    expect(duplicates).toStrictEqual([]);
  });
});
