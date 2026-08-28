import { describe, expect, it, vi } from 'vitest';

import { applyBotSettings } from '../../../src/bot/lib/apply-bot-settings.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type {
  BotConfig,
  BotMenuButtonConfig,
  BotProfileConfig,
} from '../../../src/infrastructure/bot-config/types.js';

/**
 * Pushing the operator's settings from the panel to Telegram.
 *
 * Four rules here only bite in production, weeks apart, and never as a stack
 * trace:
 *
 *   • WRITE ONLY ON DIFFERENCE. `setMyName` is rate-limited hard, and this runs
 *     at every boot and every config invalidation. A version that always wrote
 *     would pass every test and then fail the one rename that mattered, because
 *     a restart loop had already spent the allowance on writes that changed
 *     nothing.
 *   • EMPTY MEANS "LEAVE IT ALONE". Most installs never open the bot card.
 *     Reading their blank fields as "clear the description" would wipe, on the
 *     first boot after an update, a profile someone wrote in @BotFather.
 *   • ONE BAD ITEM MUST NOT EAT THE OTHERS. An over-long description is a 400;
 *     if that aborted the pass, a typo in one box would silently stop
 *     everything after it from ever being applied.
 *   • THE MENU BUTTON MUST NOT CONTRADICT THE FEATURE SWITCH. The same panel
 *     that offers "open the Mini App" can switch the Mini App off, and a button
 *     that opens a disabled feature is worse than no button.
 */

function fakeApi(current: {
  name?: string;
  description?: string;
  short?: string;
  nameEn?: string;
  descriptionEn?: string;
  shortEn?: string;
  menuButton?: { type: string; text?: string; web_app?: { url: string } };
} = {}) {
  const pick = <T>(lang: string | undefined, en: T | undefined, base: T): T =>
    lang === 'en' && en !== undefined ? en : base;
  return {
    getMyName: vi.fn(async (args?: { language_code?: string }) => ({
      name: pick(args?.language_code, current.nameEn, current.name ?? ''),
    })),
    getMyDescription: vi.fn(async (args?: { language_code?: string }) => ({
      description: pick(args?.language_code, current.descriptionEn, current.description ?? ''),
    })),
    getMyShortDescription: vi.fn(async (args?: { language_code?: string }) => ({
      short_description: pick(args?.language_code, current.shortEn, current.short ?? ''),
    })),
    setMyName: vi.fn(async () => true),
    setMyDescription: vi.fn(async () => true),
    setMyShortDescription: vi.fn(async () => true),
    getChatMenuButton: vi.fn(async () => current.menuButton ?? { type: 'default' }),
    setChatMenuButton: vi.fn(async () => true),
  };
}

function configWith(over: {
  profile?: BotProfileConfig;
  menuButton?: BotMenuButtonConfig;
  miniAppEnabled?: boolean;
}): BotConfig {
  return {
    ...DEFAULT_BOT_CONFIG,
    features: {
      ...DEFAULT_BOT_CONFIG.features,
      miniAppEnabled: over.miniAppEnabled ?? true,
    },
    ...(over.profile === undefined ? {} : { profile: over.profile }),
    ...(over.menuButton === undefined ? {} : { menuButton: over.menuButton }),
  };
}

const translator = { t: (key: string) => key } as never;

function run(
  api: ReturnType<typeof fakeApi>,
  config: BotConfig,
  extra: { logger?: unknown; miniAppUrl?: string | null } = {},
) {
  return applyBotSettings({
    bot: { api } as never,
    config,
    logger: extra.logger as never,
    translator,
    // `in`, not `??`: the point of the no-URL case is passing null, and a
    // nullish fallback would quietly hand it the default instead.
    miniAppUrl: 'miniAppUrl' in extra ? extra.miniAppUrl : 'https://app.example.test',
  });
}

describe('applyBotSettings — profile', () => {
  it('touches nothing when the panel is too old to send a profile', async () => {
    const api = fakeApi();
    const result = await run(api, configWith({}));

    expect(api.getMyName).not.toHaveBeenCalled();
    expect(api.setMyName).not.toHaveBeenCalled();
    // The menu button is a separate key and is equally absent here.
    expect(api.getChatMenuButton).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ updated: [], failed: [] });
  });

  it('treats an empty field as "leave whatever Telegram has"', async () => {
    // Not even a getter call: there is nothing to compare against, and the
    // absence of a value is not a request to clear one.
    const api = fakeApi({ description: 'written in BotFather' });
    await run(api, configWith({ profile: { name: '', description: '   ' } }));

    expect(api.getMyDescription).not.toHaveBeenCalled();
    expect(api.setMyDescription).not.toHaveBeenCalled();
  });

  it('reads before it writes, and writes nothing when the value already matches', async () => {
    const api = fakeApi({ name: 'Rezeis', description: 'Fast VPN', short: 'VPN' });
    const result = await run(
      api,
      configWith({
        profile: { name: 'Rezeis', description: 'Fast VPN', shortDescription: 'VPN' },
      }),
    );

    // Positive control: it DID look, so "no writes" is a decision and not a
    // silent early return.
    expect(api.getMyName).toHaveBeenCalledOnce();
    expect(api.setMyName).not.toHaveBeenCalled();
    expect(result.updated).toStrictEqual([]);
  });

  it('writes exactly the fields that differ, trimmed', async () => {
    const api = fakeApi({ name: 'Old name', description: 'Fast VPN', short: 'VPN' });
    const result = await run(
      api,
      configWith({
        profile: {
          name: '  New name  ',
          description: 'Fast VPN',
          shortDescription: 'Now with more VPN',
        },
      }),
    );

    expect(api.setMyName).toHaveBeenCalledExactlyOnceWith('New name', {
      language_code: undefined,
    });
    expect(api.setMyDescription).not.toHaveBeenCalled();
    expect(result.updated).toStrictEqual(['name', 'shortDescription']);
  });

  it('applies the English variant against the English slot, not the default', async () => {
    // The whole point of `language_code`: an English user should read the
    // English name. Writing it into the default slot would replace the Russian
    // one for everybody, which is the failure this asserts against.
    const api = fakeApi({ name: 'Резеис', nameEn: 'old english' });
    const result = await run(
      api,
      configWith({ profile: { name: 'Резеис', nameEn: 'Rezeis' } }),
    );

    expect(api.setMyName).toHaveBeenCalledExactlyOnceWith('Rezeis', { language_code: 'en' });
    expect(result.updated).toStrictEqual(['name:en']);
  });

  it('leaves the English slot alone when the operator set no English variant', async () => {
    // Empty is not "copy the Russian into English" — Telegram already falls
    // back to the default for every language without a dedicated value, so
    // writing one would just double the rate-limited calls.
    const api = fakeApi({ name: 'Old' });
    await run(api, configWith({ profile: { name: 'Резеис' } }));

    expect(api.setMyName).toHaveBeenCalledExactlyOnceWith('Резеис', {
      language_code: undefined,
    });
    expect(api.getMyName).toHaveBeenCalledExactlyOnceWith({ language_code: undefined });
  });

  it('refuses an over-long value locally instead of collecting a 400 forever', async () => {
    const api = fakeApi();
    const warn = vi.fn();
    const result = await run(
      api,
      configWith({ profile: { shortDescription: 'x'.repeat(121) } }),
      { logger: { warn, info: vi.fn() } },
    );

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

    const result = await run(
      api,
      configWith({ profile: { name: 'New', shortDescription: 'New short' } }),
      { logger: { warn: vi.fn(), info: vi.fn() } },
    );

    // The rename is what Telegram rate-limits; the short description is not,
    // and there is no reason for it to be collateral damage.
    expect(api.setMyShortDescription).toHaveBeenCalledExactlyOnceWith('New short', {
      language_code: undefined,
    });
    expect(result).toStrictEqual({ updated: ['shortDescription'], failed: ['name'] });
  });

  it('survives a getter failure without a logger attached', async () => {
    // The logger is optional on `PageDeps`, and a best-effort path that threw
    // on `logger?.warn` would take down the boot it was meant not to disturb.
    const api = fakeApi();
    api.getMyName.mockRejectedValue(new Error('network'));

    await expect(run(api, configWith({ profile: { name: 'New' } }))).resolves.toStrictEqual({
      updated: [],
      failed: ['name'],
    });
  });
});

describe('applyBotSettings — menu button', () => {
  it('leaves the button alone when the panel is too old to have an opinion', async () => {
    // Absent is not "reset to default": the operator may have set the button by
    // hand in @BotFather, and an update should not undo that.
    const api = fakeApi({ menuButton: { type: 'web_app', text: 'App', web_app: { url: 'https://x' } } });
    await run(api, configWith({ profile: { name: '' } }));

    expect(api.getChatMenuButton).not.toHaveBeenCalled();
    expect(api.setChatMenuButton).not.toHaveBeenCalled();
  });

  it('points the button at the Mini App when the operator asked for it', async () => {
    const api = fakeApi();
    const result = await run(api, configWith({ menuButton: { kind: 'web_app', text: 'Кабинет' } }));

    expect(api.setChatMenuButton).toHaveBeenCalledExactlyOnceWith({
      menu_button: {
        type: 'web_app',
        text: 'Кабинет',
        web_app: { url: 'https://app.example.test' },
      },
    });
    expect(result.updated).toStrictEqual(['menuButton']);
  });

  it('falls back to its own label when the operator left it empty', async () => {
    // Telegram shows ONE label to every user — `setChatMenuButton` takes no
    // language code — so there has to be a default, and it has to be the bot's
    // own rather than a string typed into the panel.
    const api = fakeApi();
    await run(api, configWith({ menuButton: { kind: 'web_app', text: '' } }));

    const [[call]] = api.setChatMenuButton.mock.calls as unknown as [
      [{ menu_button: { text: string } }],
    ];
    expect(call.menu_button.text).toBe('menu_button.cabinet');
  });

  it('takes the Mini App button back down when the panel switches the Mini App off', async () => {
    // The contradiction case, started from a live `web_app` button so the
    // fallback has to actually DO something. The feature switch wins, and the
    // operator is told why rather than left wondering where the button went.
    const api = fakeApi({
      menuButton: { type: 'web_app', text: 'App', web_app: { url: 'https://app.example.test' } },
    });
    const warn = vi.fn();
    await run(
      api,
      configWith({ menuButton: { kind: 'web_app' }, miniAppEnabled: false }),
      { logger: { warn, info: vi.fn() } },
    );

    expect(api.setChatMenuButton).toHaveBeenCalledExactlyOnceWith({
      menu_button: { type: 'commands' },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ miniAppEnabled: false }),
      expect.stringContaining('using commands'),
    );
  });

  it('never points the button at a Mini App URL it does not have', async () => {
    // A `web_app` button needs a URL. Without one the only honest answer is
    // the command list — never a button whose target is an empty string.
    const api = fakeApi({
      menuButton: { type: 'web_app', text: 'App', web_app: { url: 'https://app.example.test' } },
    });
    await run(api, configWith({ menuButton: { kind: 'web_app' } }), { miniAppUrl: null });

    expect(api.setChatMenuButton).toHaveBeenCalledExactlyOnceWith({
      menu_button: { type: 'commands' },
    });
  });

  it('writes nothing when the fallback matches what Telegram already shows', async () => {
    // The same refusal against a bot that was never configured: it already
    // shows commands, so the correct number of API calls is zero. Asserting
    // the write above without this one would hide a version that rewrites the
    // same button on every boot.
    const api = fakeApi();
    await run(api, configWith({ menuButton: { kind: 'web_app' } }), { miniAppUrl: null });

    expect(api.getChatMenuButton).toHaveBeenCalledOnce();
    expect(api.setChatMenuButton).not.toHaveBeenCalled();
  });

  it('treats Telegram’s "default" as already showing commands', async () => {
    // A bot nobody configured reports `default`, which shows the command list —
    // the same thing `commands` shows. Writing anyway would cost every fresh
    // bot one pointless rate-limited call on its first boot.
    const api = fakeApi({ menuButton: { type: 'default' } });
    const result = await run(api, configWith({ menuButton: { kind: 'commands' } }));

    expect(api.getChatMenuButton).toHaveBeenCalledOnce();
    expect(api.setChatMenuButton).not.toHaveBeenCalled();
    expect(result.updated).toStrictEqual([]);
  });

  it('rewrites the button when only its label changed', async () => {
    const api = fakeApi({
      menuButton: { type: 'web_app', text: 'Old', web_app: { url: 'https://app.example.test' } },
    });
    await run(api, configWith({ menuButton: { kind: 'web_app', text: 'New' } }));

    expect(api.setChatMenuButton).toHaveBeenCalledOnce();
  });

  it('switches back to commands when the operator changes their mind', async () => {
    const api = fakeApi({
      menuButton: { type: 'web_app', text: 'App', web_app: { url: 'https://app.example.test' } },
    });
    const result = await run(api, configWith({ menuButton: { kind: 'commands' } }));

    expect(api.setChatMenuButton).toHaveBeenCalledExactlyOnceWith({
      menu_button: { type: 'commands' },
    });
    expect(result.updated).toStrictEqual(['menuButton']);
  });
});
