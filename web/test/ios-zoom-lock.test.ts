// @vitest-environment jsdom

/**
 * ios-zoom-lock must never register touch listeners on the document again.
 *
 * A non-passive `touchmove`/`touchend` on `document` disables WebKit's
 * compositor-thread (fast-path) scrolling for the whole app — every scroll
 * then waits on the main thread, which was a measured cause of entry-screen
 * lag on iOS. Zoom suppression rests on CSS `touch-action: pan-x pan-y`
 * (html/body/#root, `index.css`) plus the Safari-proprietary `gesture*`
 * events, which are not touch events and cannot block scrolling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function installFreshModule(): Promise<Array<[string, AddEventListenerOptions | boolean | undefined]>> {
  vi.resetModules();
  const registered: Array<[string, AddEventListenerOptions | boolean | undefined]> = [];
  const spy = vi
    .spyOn(document, 'addEventListener')
    .mockImplementation((type: string, _listener, options?: AddEventListenerOptions | boolean) => {
      registered.push([type, options]);
    });
  const { installIosZoomLock } = await import('../src/lib/ios-zoom-lock');
  installIosZoomLock();
  spy.mockRestore();
  return registered;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installIosZoomLock', () => {
  it('registers only Safari gesture listeners — never touch listeners', async () => {
    const registered = await installFreshModule();

    const types = registered.map(([type]) => type);
    expect(
      types,
      'ios-zoom-lock registered a listener that is not a Safari gesture event — a document touch listener kills WebKit fast-path scrolling app-wide',
    ).toEqual(['gesturestart', 'gesturechange', 'gestureend']);
    for (const touchEvent of ['touchstart', 'touchmove', 'touchend'] as const) {
      expect(
        types,
        `a document \`${touchEvent}\` listener is back — WebKit then runs every scroll through the main thread`,
      ).not.toContain(touchEvent);
    }
  });

  it('installs at most once', async () => {
    vi.resetModules();
    const { installIosZoomLock } = await import('../src/lib/ios-zoom-lock');
    installIosZoomLock();

    const spy = vi.spyOn(document, 'addEventListener');
    installIosZoomLock();
    expect(spy).not.toHaveBeenCalled();
  });
});
