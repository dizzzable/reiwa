import { describe, expect, it, vi } from 'vitest';

import { applyBotProfile } from '../../../src/bot/lib/apply-bot-profile.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig, BotProfileConfig } from '../../../src/infrastructure/bot-config/types.js';

/**
 * Pushing the operator's Telegram profile from the panel.
 *
 * Three of the rules this enforces are the kind that only bite in production,
 * weeks apart, and never as a stack trace:
 *
 *   • WRITE ONLY ON DIFFERENCE. `setMyName` is rate-limited hard, and this runs
 *     at every boot and every config invalidation. A version that always wrote
 *     would work perfectly in testing and then fail the one rename that
 *     mattered, because a restart loop had already spent the allowance on
 *     writes that changed nothing.
 *   • EMPTY MEANS "LEAVE IT ALONE". Most installs will never open the bot card.
 *     Reading their blank fields as "clear the description" would wipe, on the
 *     first boot after an update, a profile someone wrote in @BotFather.
 *   • ONE BAD FIELD MUST NOT EAT THE OTHERS. A description over the limit is a
 *     400 from Telegram; if that aborted the pass, a typo in one box would
 *     silently stop the other two from ever being applied.
 */

function fakeApi(current: { name?: string; description?: string; short?: string } = {}) {
  return {
    getMyName: vi.fn(async () => ({ name: current.name ?? '' })),
    getMyDescription: vi.fn(async () => ({ description: current.description ?? '' })),
    getMyShortDescription: vi.fn(async () => ({ short_description: current.short ?? '' })),
    setMyName: vi.fn(async () => true),
    setMyDescription: vi.fn(async () => true),
    setMyShortDescription: vi.fn(async () => true),
  };
}

function configWith(profile: BotProfileConfig | undefined): BotConfig {
  return { ...DEFAULT_BOT_CONFIG, ...(profile === undefined ? {} : { profile }) };
}

function run(api: ReturnType<typeof fakeApi>, profile: BotProfileConfig | undefined, logger?: unknown) {
  return applyBotProfile({
    bot: { api } as never,
    config: configWith(profile),
    logger: logger as never,
  });
}

describe('applyBotProfile', () => {
  it('touches nothing when the panel is too old to send a profile', async () => {
    const api = fakeApi();
    const result = await run(api, undefined);

    expect(api.getMyName).not.toHaveBeenCalled();
    expect(api.setMyName).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ updated: [], failed: [] });
  });

  it('treats an empty field as "leave whatever Telegram has"', async () => {
    // Not even a getter call: there is nothing to compare against, and the
    // absence of a value is not a request to clear one.
    const api = fakeApi({ description: 'written in BotFather' });
    await run(api, { name: '', description: '   ', shortDescription: '' });

    expect(api.getMyDescription).not.toHaveBeenCalled();
    expect(api.setMyDescription).not.toHaveBeenCalled();
  });

  it('reads before it writes, and writes nothing when the value already matches', async () => {
    const api = fakeApi({ name: 'Rezeis', description: 'Fast VPN', short: 'VPN' });
    const result = await run(api, {
      name: 'Rezeis',
      description: 'Fast VPN',
      shortDescription: 'VPN',
    });

    // Positive control: it DID look, so "no writes" is a decision and not a
    // silent early return.
    expect(api.getMyName).toHaveBeenCalledOnce();
    expect(api.setMyName).not.toHaveBeenCalled();
    expect(api.setMyDescription).not.toHaveBeenCalled();
    expect(api.setMyShortDescription).not.toHaveBeenCalled();
    expect(result.updated).toStrictEqual([]);
  });

  it('writes exactly the fields that differ, trimmed', async () => {
    const api = fakeApi({ name: 'Old name', description: 'Fast VPN', short: 'VPN' });
    const result = await run(api, {
      name: '  New name  ',
      description: 'Fast VPN',
      shortDescription: 'Now with more VPN',
    });

    expect(api.setMyName).toHaveBeenCalledExactlyOnceWith('New name');
    expect(api.setMyDescription).not.toHaveBeenCalled();
    expect(api.setMyShortDescription).toHaveBeenCalledExactlyOnceWith('Now with more VPN');
    expect(result.updated).toStrictEqual(['name', 'shortDescription']);
  });

  it('refuses an over-long value locally instead of collecting a 400 forever', async () => {
    // Telegram caps the short description at 120. Sending it anyway would fail
    // on every boot and every invalidation, with an error naming neither the
    // field nor the limit.
    const api = fakeApi();
    const warn = vi.fn();
    const result = await run(api, { shortDescription: 'x'.repeat(121) }, { warn, info: vi.fn() });

    expect(api.getMyShortDescription).not.toHaveBeenCalled();
    expect(api.setMyShortDescription).not.toHaveBeenCalled();
    expect(result.failed).toStrictEqual(['shortDescription']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'shortDescription', limit: 120 }),
      expect.stringContaining('exceeds the Telegram limit'),
    );
  });

  it('keeps going after one field fails', async () => {
    const api = fakeApi({ name: 'Old', short: 'Old short' });
    api.setMyName.mockRejectedValue(new Error('Too Many Requests: retry after 3600'));

    const result = await run(api, { name: 'New', shortDescription: 'New short' }, {
      warn: vi.fn(),
      info: vi.fn(),
    });

    // The rename is the one Telegram rate-limits; the short description is not,
    // and there is no reason for it to be collateral damage.
    expect(api.setMyShortDescription).toHaveBeenCalledExactlyOnceWith('New short');
    expect(result).toStrictEqual({ updated: ['shortDescription'], failed: ['name'] });
  });

  it('survives a getter failure without a logger attached', async () => {
    // The logger is optional on `PageDeps`, and a best-effort path that threw on
    // `logger?.warn` would take down the boot it was meant not to disturb.
    const api = fakeApi();
    api.getMyName.mockRejectedValue(new Error('network'));

    await expect(run(api, { name: 'New' })).resolves.toStrictEqual({
      updated: [],
      failed: ['name'],
    });
  });
});
