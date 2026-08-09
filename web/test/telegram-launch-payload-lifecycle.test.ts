// @vitest-environment jsdom

/**
 * What counts as a launch payload, and how long it stays one.
 *
 * `readLaunchParamsFromUrl` answers with a record if ANY of the launch names
 * carries a value, and the resolver used to take that record as gospel:
 * `capturedLaunchParams = fromUrl`, replacing a good capture and — being
 * non-`null` — stopping the session mirror from being consulted at all. Two
 * measured consequences:
 *
 *   - `#tgWebAppData=&tgWebAppVersion=9.6` resolved to `{tgWebAppVersion:"9.6"}`,
 *     a payload-less record that won over a mirror holding the real payload.
 *   - `#tgWebAppData=%20` passed `value.length > 0`, so one space was accepted as
 *     a signed launch: `detectTma()` answered true and the bootstrap sent it to
 *     the server to come back 401.
 *
 * And nothing ever expired the mirror. A document opened past the server's own
 * 24h `auth_date` window replayed a payload the server was committed to
 * refusing, and the bootstrap error screen's only affordance is Retry, which is
 * `window.location.reload()` — a new document, same mirror, same 401, forever.
 *
 * `window.Telegram` is defined nowhere in this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  forgetTelegramLaunchPayload,
  readTelegramLaunchInitData,
  readTelegramLaunchStartParam,
  resolveTelegramLaunchParams,
  __resetTelegramLaunchCaptureForTests,
} from "@/lib/telegram-launch-params";

const SDK_KEY = "__telegram__initParams";
/** The server's window, restated: `src/lib/telegram-auth.ts` 401s past this. */
const MAX_AGE_SECONDS = 86_400;

function initDataAged(ageSeconds: number): string {
  const authDate = Math.floor(Date.now() / 1000) - ageSeconds;
  return `user=%7B%22id%22%3A42%7D&auth_date=${authDate}&hash=deadbeef`;
}

const FRESH = initDataAged(60);

function mirror(record: Record<string, string>): void {
  window.sessionStorage.setItem(SDK_KEY, JSON.stringify(record));
}

function storedRecord(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(SDK_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
});

afterEach(() => {
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  vi.restoreAllMocks();
});

describe("a URL record with no usable payload", () => {
  it("does not shadow the mirror that is holding the real one", () => {
    mirror({ tgWebAppData: FRESH, tgWebAppVersion: "9.5" });
    // A present-but-empty payload next to a descriptive name. Non-`null` under
    // the old rule, and that alone was enough to win.
    window.history.replaceState({}, "", "/renew#tgWebAppData=&tgWebAppVersion=9.6");

    expect(
      readTelegramLaunchInitData(),
      "a payload-less URL record shadowed the session mirror — the launch is spent and the subscriber lands on a password form",
    ).toBe(FRESH);
    // The descriptive name from the URL still wins for its OWN key: that is the
    // SDK's merge rule, and it is what the module header has always documented.
    expect(resolveTelegramLaunchParams()?.tgWebAppVersion).toBe("9.6");
  });

  it("does not replace an in-memory capture already taken from this launch", () => {
    window.history.replaceState({}, "", `/renew#tgWebAppData=${encodeURIComponent(FRESH)}`);
    resolveTelegramLaunchParams();
    // A later hop appends only the descriptive names — no payload.
    window.history.replaceState({}, "", "/bootstrap?tgWebAppVersion=9.6");

    expect(
      readTelegramLaunchInitData(),
      "a descriptive-only URL wiped the captured payload — everything downstream of this hop now believes the session is a plain browser",
    ).toBe(FRESH);
  });

  it("treats a whitespace-only payload as no payload at all", () => {
    // `value.length > 0` accepted this. `detectTma()` then answered true and the
    // bootstrap posted two spaces to `/auth/telegram/bootstrap` for a 401.
    window.history.replaceState({}, "", "/renew#tgWebAppData=%20%20");

    expect(
      readTelegramLaunchInitData(),
      "a blank payload was accepted as a signed launch — the session is classified as a Mini App and the bootstrap 401s",
    ).toBeNull();
    expect(storedRecord()?.tgWebAppData).toBeUndefined();
  });

  it("still keeps the byte-for-byte payload it does accept", () => {
    // The emptiness test uses `trim()`; the VALUE must never be trimmed, because
    // the server HMACs these exact bytes.
    const padded = `${FRESH}&note=%20trailing%20`;
    window.history.replaceState({}, "", `/renew#tgWebAppData=${encodeURIComponent(padded)}`);

    expect(readTelegramLaunchInitData()).toBe(padded);
  });
});

describe("the URL and the carried copy merge key-wise, as the SDK does", () => {
  it("lets the fresh URL win per name and keeps the names it does not carry", () => {
    mirror({ tgWebAppData: initDataAged(120), tgWebAppPlatform: "android", _path: "" });
    const fresher = initDataAged(5);
    window.history.replaceState(
      {},
      "",
      `/renew#tgWebAppData=${encodeURIComponent(fresher)}&tgWebAppVersion=9.6`,
    );

    const resolved = resolveTelegramLaunchParams();

    expect(resolved?.tgWebAppData).toBe(fresher);
    expect(resolved?.tgWebAppVersion).toBe("9.6");
    expect(
      resolved?.tgWebAppPlatform,
      "a name the fresh URL did not carry was dropped instead of merged — the code and the module header disagree again",
    ).toBe("android");
    // And names this module never parses survive the write untouched, or the
    // SDK's own launch parameters lose them.
    expect(storedRecord()?._path).toBe("");
  });
});

describe("a payload past the server's own window is not replayed", () => {
  it("is not served from the mirror, and is taken out of it", () => {
    mirror({ tgWebAppData: initDataAged(MAX_AGE_SECONDS + 60), tgWebAppVersion: "9.6" });
    window.history.replaceState({}, "", "/dashboard");

    expect(
      readTelegramLaunchInitData(),
      "a payload the server will refuse on auth_date was replayed — the bootstrap 401s and Retry reloads into the same 401 forever",
    ).toBeNull();
    expect(
      storedRecord()?.tgWebAppData,
      "the spent payload is still in the mirror, so the reload picks it straight back up",
    ).toBeUndefined();
    // The rest of the record describes the client and is not what expired: the
    // loader still uses it to decide the bridge is worth fetching.
    expect(storedRecord()?.tgWebAppVersion).toBe("9.6");
  });

  it("is not served from the in-memory carrier of a long-lived document either", () => {
    const fresh = initDataAged(60);
    window.history.replaceState({}, "", `/renew#tgWebAppData=${encodeURIComponent(fresh)}`);
    resolveTelegramLaunchParams();
    window.history.replaceState({}, "", "/renew");
    expect(readTelegramLaunchInitData()).toBe(fresh);

    // The document is still open a day and a bit later.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + (MAX_AGE_SECONDS + 120) * 1000);

    expect(
      readTelegramLaunchInitData(),
      "a document open past the window kept handing its dead payload to every consumer",
    ).toBeNull();
  });

  it("keeps a payload the window has NOT closed on", () => {
    mirror({ tgWebAppData: initDataAged(MAX_AGE_SECONDS - 600) });
    window.history.replaceState({}, "", "/dashboard");

    expect(
      readTelegramLaunchInitData(),
      "a launch the server would still accept was thrown away — the heuristic is now costing sign-ins instead of saving them",
    ).not.toBeNull();
  });

  it("does not judge THIS document's own URL by the device clock", () => {
    // A phone whose clock is days fast. Telegram just opened this document, the
    // server's own clock is fine, and the payload would validate — discarding it
    // here would tell the user to open the app in Telegram while they are doing
    // exactly that.
    const payload = initDataAged(0);
    window.history.replaceState({}, "", `/renew#tgWebAppData=${encodeURIComponent(payload)}`);
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 5 * MAX_AGE_SECONDS * 1000);

    expect(
      readTelegramLaunchInitData(),
      "a launch document's own payload was discarded on the strength of the DEVICE clock, which the server never consults",
    ).toBe(payload);
  });

  it("gives no verdict at all on a payload that states no auth_date", () => {
    // Judging it here would be inventing a rejection the server never made.
    mirror({ tgWebAppData: "user=%7B%22id%22%3A42%7D&hash=deadbeef" });
    window.history.replaceState({}, "", "/dashboard");

    expect(readTelegramLaunchInitData()).toBe("user=%7B%22id%22%3A42%7D&hash=deadbeef");
  });
});

describe("forgetting a payload the server has refused", () => {
  it("clears it from memory, from the mirror AND from this document's URL", () => {
    // The URL is the half a `catch`-and-clear would miss: Retry is
    // `window.location.reload()`, and a reload keeps the fragment.
    window.history.replaceState(
      {},
      "",
      `/tma#tgWebAppData=${encodeURIComponent(FRESH)}&tgWebAppVersion=9.6`,
    );
    expect(readTelegramLaunchInitData()).toBe(FRESH);

    forgetTelegramLaunchPayload();

    expect(
      window.location.hash,
      "the refused payload is still in the address bar — reload replays it and the 401 loop is untouched",
    ).not.toContain("tgWebAppData");
    expect(storedRecord()?.tgWebAppData).toBeUndefined();
    expect(readTelegramLaunchInitData()).toBeNull();
    // Still recognisably a Mini App document, so the bridge is still fetched.
    expect(window.location.hash).toContain("tgWebAppVersion=9.6");
    expect(storedRecord()?.tgWebAppVersion).toBe("9.6");
  });

  it("takes it out of a query-delivered launch too", () => {
    window.history.replaceState(
      {},
      "",
      `/tma?tgWebAppData=${encodeURIComponent(FRESH)}&next=%2Frenew`,
    );
    expect(readTelegramLaunchInitData()).toBe(FRESH);

    forgetTelegramLaunchPayload();

    expect(new URLSearchParams(window.location.search).has("tgWebAppData")).toBe(false);
    // Unrelated query parameters are not collateral: `next` is the deep-link
    // destination and losing it would land the user on the dashboard.
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/renew");
  });

  it("creates nothing on a document that never had a launch", () => {
    window.history.replaceState({}, "", "/sign-in");

    forgetTelegramLaunchPayload();

    expect(window.sessionStorage.getItem(SDK_KEY)).toBeNull();
  });
});

describe("the start parameter travels with the launch", () => {
  it("is read off the launch URL, with no bridge", () => {
    // Telegram delivers `t.me/<bot>/app?startapp=ad_x` as `tgWebAppStartParam`.
    // It is NOT in the query, which is why the `?startapp=` fallback in
    // `use-ad-attribution` never fired for a Mini App.
    window.history.replaceState(
      {},
      "",
      `/renew#tgWebAppData=${encodeURIComponent(FRESH)}&tgWebAppStartParam=ad_spring25`,
    );

    expect(
      readTelegramLaunchStartParam(),
      "the launch's start parameter was not captured, so Mini App ad attribution still depends on telegram.org",
    ).toBe("ad_spring25");
    expect(window.Telegram).toBeUndefined();
  });

  it("survives the navigation that drops the fragment", () => {
    window.history.replaceState(
      {},
      "",
      `/renew#tgWebAppData=${encodeURIComponent(FRESH)}&tgWebAppStartParam=ad_spring25`,
    );
    resolveTelegramLaunchParams();
    window.history.replaceState({}, "", "/bootstrap");

    expect(readTelegramLaunchStartParam()).toBe("ad_spring25");
    expect(storedRecord()?.tgWebAppStartParam).toBe("ad_spring25");
  });

  it("is null for a session that did not come through one", () => {
    window.history.replaceState({}, "", `/renew#tgWebAppData=${encodeURIComponent(FRESH)}`);

    expect(readTelegramLaunchStartParam()).toBeNull();
  });
});
