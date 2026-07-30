import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const loaderSource = readFileSync(
  new URL('../../web/public/telegram-webapp-loader.js', import.meta.url),
  'utf8',
);

interface LoadedScript {
  async?: boolean;
  crossOrigin?: string;
  dataset: Record<string, string>;
  src?: string;
  addEventListener?: (event: string, callback: () => void) => void;
}

function runLoader(
  url: string,
  alreadyLoaded = false,
): { readonly appended: LoadedScript[]; readonly window: Record<string, unknown> } {
  const appended: LoadedScript[] = [];
  const listeners = new Map<string, () => void>();
  const location = new URL(url);
  const existing = alreadyLoaded ? ({ dataset: { reiwaTelegramSdk: 'true' } }) : null;
  const document = {
    querySelector: vi.fn().mockReturnValue(existing),
    createElement: vi.fn().mockImplementation(() => ({
      dataset: {},
      addEventListener: (event: string, callback: () => void) => {
        listeners.set(event, callback);
      },
    })),
    head: {
      appendChild: vi.fn().mockImplementation((script: LoadedScript) => {
        appended.push(script);
      }),
    },
  };
  const sdkWindow: Record<string, unknown> = {
    location,
    dispatchEvent: vi.fn(),
  };

  runInNewContext(loaderSource, {
    Event,
    URLSearchParams,
    document,
    window: sdkWindow,
  });

  Object.defineProperty(sdkWindow, "listeners", { value: listeners });
  return { appended, window: sdkWindow };
}

describe('Telegram WebApp SDK loader', () => {
  it('does not contact telegram.org for a regular browser session', () => {
    expect(runLoader('https://cabinet.example/sign-in?next=%2Fdashboard').appended).toEqual([]);
  });

  it.each([
    'https://cabinet.example/#tgWebAppData=signed-data&tgWebAppVersion=9.6&tgWebAppPlatform=android',
    'https://cabinet.example/?tgWebAppVersion=9.6&tgWebAppPlatform=tdesktop',
  ])('loads the SDK for Telegram launch parameters: %s', (url) => {
    expect(runLoader(url).appended).toMatchObject([
      {
        async: true,
        crossOrigin: 'anonymous',
        dataset: { reiwaTelegramSdk: 'true' },
        src: 'https://telegram.org/js/telegram-web-app.js',
      },
    ]);
  });

  it('does not append a duplicate Telegram SDK script', () => {
    expect(
      runLoader(
        'https://cabinet.example/#tgWebAppVersion=9.6&tgWebAppPlatform=android',
        true,
      ).appended,
    ).toEqual([]);
  });

  it.each([
    ["load", "ready", "reiwa:telegram-sdk-ready"],
    ["error", "error", "reiwa:telegram-sdk-error"],
  ])("publishes an explicit SDK %s signal", (event, state, signal) => {
    const result = runLoader(
      "https://cabinet.example/#tgWebAppVersion=9.6&tgWebAppPlatform=android",
    );
    const listeners = result.window["listeners"] as Map<string, () => void>;

    expect(result.window["__reiwaTelegramSdkState"]).toBe("loading");
    listeners.get(event)?.();

    expect(result.window["__reiwaTelegramSdkState"]).toBe(state);
    expect(result.window["dispatchEvent"]).toHaveBeenCalledWith(
      expect.objectContaining({ type: signal }),
    );
  });
});
