/**
 * `src/bot/main.ts` — the bot config as the pages get it.
 *
 *   • `peekConfig`: what a reply that cannot wait for the panel falls back on
 *     (`lib/config-within.ts`) is the config the bot holds — the cache's
 *     `peek()` — wired once, here. Without it every such reply goes without a
 *     config, and the operator's emoji go out raw while one is in memory.
 *   • The warm-up tick is `startConfigWarmup` on the cache: a forced read on
 *     every tick, before the TTL is out. The tick it replaced called `get()` on
 *     the TTL itself, which skipped an entry still fresh.
 *
 * Read through the TypeScript parser, not a regex over the text: a commented-out
 * line is not code, and a pin that a comment satisfies pins nothing.
 */
import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const main = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../../src/bot/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function nodesOf(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

const textOf = (node: ts.Node): string => node.getText(main);

function declared(name: string): ts.Expression | undefined {
  return nodesOf(main)
    .filter(ts.isVariableDeclaration)
    .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)?.initializer;
}

describe('src/bot/main.ts — the bot config as the pages get it', () => {
  it('hands every page the config the bot holds: the cache’s peek', () => {
    const pageDeps = declared('pageDeps');
    expect(pageDeps !== undefined && ts.isObjectLiteralExpression(pageDeps), 'const pageDeps = { … }').toBe(true);
    const peek = (pageDeps as ts.ObjectLiteralExpression).properties.find(
      (property) => ts.isPropertyAssignment(property) && textOf(property.name) === 'peekConfig',
    ) as ts.PropertyAssignment | undefined;
    expect(peek && textOf(peek.initializer)).toBe('() => botConfigCache?.peek() ?? null');
  });

  // The cache logs each failed fetch (`BotConfigCache: refresh failed …`) —
  // given a logger. Built without one, a panel outage left no line in the log.
  it('builds the cache with the bot’s logger: a failed refresh reaches the log', () => {
    const constructions = nodesOf(main)
      .filter(ts.isNewExpression)
      .filter((call) => textOf(call.expression) === 'BotConfigCache');
    expect(constructions).toHaveLength(1);
    const [options] = constructions[0]!.arguments ?? [];
    expect(options !== undefined && ts.isObjectLiteralExpression(options)).toBe(true);
    const logger = (options as ts.ObjectLiteralExpression).properties.find(
      (property) => property.name !== undefined && textOf(property.name) === 'logger',
    );
    expect(logger && textOf(logger)).toMatch(/^logger(: logger)?$/);
  });

  // What Telegram holds — the commands, the profile, the menu button — follows
  // every config the panel ANSWERS with (`lib/telegram-settings-sync.ts`): the
  // cache announces each answered read to the sync, a save hands its fresh
  // config on forced, and the pushes are worked out from the config offered.
  // Without the first, a save whose own read failed stayed off Telegram until
  // the next save or a restart.
  it('offers every answered read to the settings sync, and a save forced', () => {
    const constructions = nodesOf(main)
      .filter(ts.isNewExpression)
      .filter((call) => textOf(call.expression) === 'BotConfigCache');
    const [options] = constructions[0]!.arguments ?? [];
    const onAnswered = (options as ts.ObjectLiteralExpression).properties.find(
      (property) => property.name !== undefined && textOf(property.name) === 'onAnswered',
    ) as ts.PropertyAssignment | undefined;
    expect(onAnswered && textOf(onAnswered.initializer)).toBe('(fresh) => void settingsSync?.offer(fresh)');

    const onConfigApplied = nodesOf(main)
      .filter(ts.isPropertyAssignment)
      .find((property) => textOf(property.name) === 'onConfigApplied');
    expect(onConfigApplied && textOf(onConfigApplied.initializer)).toBe('(fresh) => sync.offer(fresh, { force: true })');

    const starts = nodesOf(main)
      .filter(ts.isCallExpression)
      .filter((call) => textOf(call.expression) === 'sync.start')
      .map((call) => textOf(call.arguments[0]!));
    expect(starts).toEqual(['telegramSettingsOf({ bot, translator, logger, miniAppUrl: reiwaWebAppUrl })']);

    // The sync is built before the boot read, so that read is the first offered.
    const text = main.getFullText();
    expect(text.indexOf('settingsSync = sync;')).toBeGreaterThan(-1);
    expect(text.indexOf('settingsSync = sync;')).toBeLessThan(text.indexOf('await getBotConfig(adminClient, logger)'));

    // A bot with no panel at all has no answered read to wait for: its
    // defaults are its config, and without them it would have no command list.
    const offers = nodesOf(main)
      .filter(ts.isIfStatement)
      .map((statement) => textOf(statement))
      .filter((statement) => statement.includes('sync.offer('));
    expect(offers).toEqual(['if (botConfigCache === null) void sync.offer(botConfig, { force: true });']);
  });

  it('pushes nothing to Telegram past the sync: no command list, profile or menu button of its own', () => {
    const calls = nodesOf(main)
      .filter(ts.isCallExpression)
      .map((call) => textOf(call.expression));
    for (const pushed of ['setMyCommands', 'applyBotSettings', 'setChatMenuButton', 'setMyName']) {
      expect(calls.filter((callee) => callee.endsWith(pushed)), pushed).toEqual([]);
    }
  });

  it('keeps the entry fresh with the warm-up on the cache, and no other tick reads the config', () => {
    const timer = declared('configRefreshTimer');
    expect(timer && textOf(timer)).toBe('botConfigCache !== null ? startConfigWarmup(botConfigCache) : null');
    const intervals = nodesOf(main)
      .filter(ts.isCallExpression)
      .filter((call) => textOf(call.expression) === 'setInterval')
      .map((call) => textOf(call));
    expect(intervals.filter((text) => /getBotConfig|botConfigCache/.test(text))).toEqual([]);
  });
});
