import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => {
  const values = new Map<string, string>();
  const reload = vi.fn();
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };

  const install = (): void => {
    vi.stubGlobal('window', {
      localStorage: storage,
      sessionStorage: storage,
      location: { reload },
    });
  };
  install();

  return {
    install,
    reload,
    reset: (): void => {
      values.clear();
      reload.mockReset();
    },
  };
});

import {
  isDynamicImportFailure,
  recoverFromDynamicImportFailure,
} from '../../web/src/lib/dynamic-import-recovery.js';

function createStorage(): {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
} {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('dynamic import recovery', () => {
  beforeEach(() => {
    browser.install();
  });

  afterEach(() => {
    browser.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('recognises Safari and Vite stale-module failures without matching ordinary crashes', () => {
    expect(isDynamicImportFailure(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(
      isDynamicImportFailure(
        new TypeError(
          'Failed to fetch dynamically imported module: https://reiwa.example/assets/web-home-page-DSlEAZwx.js',
        ),
      ),
    ).toBe(true);
    expect(isDynamicImportFailure(new TypeError('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads only once for the same failed lazy import in a tab session', () => {
    const reload = vi.fn();
    const environment = { storage: createStorage(), reload };
    const error = new TypeError(
      'Failed to fetch dynamically imported module: https://reiwa.example/assets/web-home-page-DSlEAZwx.js',
    );

    expect(recoverFromDynamicImportFailure(error, environment)).toBe(true);
    expect(recoverFromDynamicImportFailure(error, environment)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

});
