// @vitest-environment jsdom

/**
 * `initData` is `tgWebAppData`, and the server HMACs the exact bytes of it.
 *
 * So reading it off the URL is only safe if the string produced is the same
 * string `window.Telegram.WebApp.initData` would have held — not merely one
 * that looks similar. A second decode turns `%25` into `%`; a `+` handed to the
 * wrong decoder becomes a space; a skipped decode leaves `%7B` where a `{`
 * belongs. Each of those still yields a plausible query string, and each fails
 * the signature check on the server, which lands a Telegram-first user back on
 * the password form this whole change exists to keep them off.
 *
 * The oracle below is Telegram's own shipped code, transliterated: the SDK
 * derives `initData` as `webAppInitData = initParams.tgWebAppData`, where
 * `initParams = urlParseHashParams(location.hash)`. Comparing against it is
 * therefore a comparison against the real bridge, not against an assumption
 * about it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readTelegramLaunchInitData,
  resolveTelegramLaunchParams,
} from "../src/lib/telegram-launch-params";

const SDK_KEY = "__telegram__initParams";

// ── Telegram's shipped SDK, transliterated ───────────────────────────────────

/** `urlSafeDecode` from telegram-web-app.js, verbatim in behaviour. */
function urlSafeDecode(urlencoded: string): string {
  try {
    urlencoded = urlencoded.replace(/\+/g, "%20");
    return decodeURIComponent(urlencoded);
  } catch {
    return urlencoded;
  }
}

/**
 * `urlParseQueryString` from telegram-web-app.js. The SDK writes
 * `param[1] == null ? null : urlSafeDecode(param[1])`; `param.length < 2` is
 * the same condition expressed in a way TypeScript will accept, since
 * `split('=')` yields a second element for every `name=` form and none at all
 * for a bare `name`.
 */
function urlParseQueryString(queryString: string): Record<string, string | null> {
  const params: Record<string, string | null> = {};
  if (!queryString.length) return params;
  for (const pair of queryString.split("&")) {
    const param = pair.split("=");
    params[urlSafeDecode(param[0])] = param.length < 2 ? null : urlSafeDecode(param[1]);
  }
  return params;
}

/** `urlParseHashParams` from telegram-web-app.js. */
function urlParseHashParams(locationHash: string): Record<string, string | null> {
  locationHash = locationHash.replace(/^#/, "");
  const params: Record<string, string | null> = {};
  if (!locationHash.length) return params;
  if (locationHash.indexOf("=") < 0 && locationHash.indexOf("?") < 0) {
    params._path = urlSafeDecode(locationHash);
    return params;
  }
  const qIndex = locationHash.indexOf("?");
  if (qIndex >= 0) {
    params._path = urlSafeDecode(locationHash.substring(0, qIndex));
    locationHash = locationHash.substring(qIndex + 1);
  }
  for (const [key, value] of Object.entries(urlParseQueryString(locationHash))) {
    params[key] = value;
  }
  return params;
}

/**
 * The SDK's launch parameters for a document, including its `sessionStorage`
 * restore — the same merge the shipped code performs, where the fresh URL wins
 * and the store only fills in names it did not carry.
 */
function sdkInitParams(locationHash: string): Record<string, string | null> {
  const initParams = urlParseHashParams(locationHash);
  const storedRaw = window.sessionStorage.getItem(SDK_KEY);
  const stored: Record<string, string | null> | null =
    storedRaw === null ? null : JSON.parse(storedRaw);
  if (stored) {
    for (const key of Object.keys(stored)) {
      if (typeof initParams[key] === "undefined") initParams[key] = stored[key];
    }
  }
  return initParams;
}

/** Exactly `webAppInitData = initParams.tgWebAppData` from the SDK. */
function sdkInitData(locationHash: string): string {
  const value = sdkInitParams(locationHash).tgWebAppData;
  return typeof value === "string" && value.length > 0 ? value : "";
}

// ── A real launch payload ────────────────────────────────────────────────────

/**
 * A captured `initData`, carrying every character class a sloppy decode
 * mangles: a literal `+` in the signature, literal `%` throughout the
 * percent-encoded `user` blob (including a `%25` that is itself an escaped
 * percent, and a `%2B` that is an escaped plus), and a Cyrillic first name.
 *
 * Telegram percent-encodes this whole string once when it builds the fragment,
 * so `+` arrives as `%2B` and every `%` as `%25`. Getting back to these exact
 * bytes requires precisely one decode.
 */
const CAPTURED_INIT_DATA = [
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc",
  "user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22%D0%92%D0%BB%D0%B0%D0%B4%22%2C" +
    "%22last_name%22%3A%22%D0%AF%D0%BA%D0%BE%D0%B2%D0%BB%D0%B5%D0%B2%22%2C" +
    "%22username%22%3A%22vlad%22%2C%22language_code%22%3A%22ru%22%2C" +
    "%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2Fa%2Bb%25c.svg%22%7D",
  "auth_date=1735689600",
  "signature=Zx9+q/rM7tKQ9wA",
  "hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2",
].join("&");

const THEME_PARAMS = '{"bg_color":"#212121","text_color":"#ffffff"}';

/** The fragment Telegram appends when it opens the Mini App URL. */
const LAUNCH_HASH =
  "#tgWebAppData=" +
  encodeURIComponent(CAPTURED_INIT_DATA) +
  "&tgWebAppVersion=9.6&tgWebAppPlatform=android&tgWebAppThemeParams=" +
  encodeURIComponent(THEME_PARAMS);

function withLaunchHash(hash = LAUNCH_HASH): void {
  window.history.replaceState({}, "", `/${hash}`);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("initData extracted from the launch URL", () => {
  it("is byte-identical to the string the Telegram SDK would expose", () => {
    withLaunchHash();

    const extracted = readTelegramLaunchInitData();

    // The literal `+` survived as a `+`, the escaped `%25` did not collapse to
    // a `%`, and nothing was decoded twice.
    expect(extracted).toBe(CAPTURED_INIT_DATA);
    expect(extracted).toBe(sdkInitData(window.location.hash));
    expect(extracted).toContain("signature=Zx9+q/rM7tKQ9wA");
    expect(extracted).toContain("a%2Bb%25c.svg");
  });

  it("carries the Cyrillic user name through intact", () => {
    withLaunchHash();

    const extracted = readTelegramLaunchInitData() ?? "";
    const user = JSON.parse(new URLSearchParams(extracted).get("user") ?? "{}");

    expect(user.first_name).toBe("Влад");
    expect(user.last_name).toBe("Яковлев");
    expect(user.photo_url).toBe("https://t.me/i/userpic/320/a+b%c.svg");
  });

  it("reads a bare `+` in the fragment exactly as the SDK does", () => {
    // Not a shape Telegram emits — `encodeURIComponent` escapes a `+` to `%2B`
    // — but a proxy or a hand-copied link can rewrite an escaped space as `+`,
    // and the two decoders must not disagree about it. Both spell it a space:
    // the SDK because `urlSafeDecode` rewrites `+` to `%20` first, and
    // `URLSearchParams` because that is the form-encoding rule it implements.
    const payload = "auth_date=1&user=a b&hash=ff";
    withLaunchHash(
      "#tgWebAppData=" + encodeURIComponent(payload).replace(/%20/g, "+"),
    );

    expect(readTelegramLaunchInitData()).toBe(sdkInitData(window.location.hash));
    expect(readTelegramLaunchInitData()).toBe(payload);
  });

  it("reads the launch out of the query string too", () => {
    // Older clients, and some desktop launch URLs, put the parameters there.
    window.history.replaceState(
      {},
      "",
      `/?tgWebAppData=${encodeURIComponent(CAPTURED_INIT_DATA)}&tgWebAppVersion=9.6`,
    );

    expect(readTelegramLaunchInitData()).toBe(CAPTURED_INIT_DATA);
  });

  it("answers null when nothing in the URL came from Telegram", () => {
    window.history.replaceState({}, "", "/sign-in?next=%2Fdashboard");

    expect(readTelegramLaunchInitData()).toBeNull();
  });
});

describe("the session mirror of the launch parameters", () => {
  it("writes the SDK's own key in the SDK's own shape", () => {
    withLaunchHash();

    resolveTelegramLaunchParams();

    expect(JSON.parse(window.sessionStorage.getItem(SDK_KEY) ?? "null")).toEqual({
      tgWebAppData: CAPTURED_INIT_DATA,
      tgWebAppVersion: "9.6",
      tgWebAppPlatform: "android",
      tgWebAppThemeParams: THEME_PARAMS,
    });
  });

  it("is a store the SDK itself can restore from", () => {
    withLaunchHash();
    resolveTelegramLaunchParams();

    // A later document in the same tab, with the hash gone: the SDK's own
    // merge has to find our write and accept it, or the two would compete for
    // one key instead of agreeing on it.
    expect(sdkInitData("")).toBe(CAPTURED_INIT_DATA);
  });

  it("stands in for the hash a client-side navigation dropped", () => {
    withLaunchHash();
    resolveTelegramLaunchParams();

    window.history.replaceState({}, "", "/bootstrap");

    expect(readTelegramLaunchInitData()).toBe(CAPTURED_INIT_DATA);
  });

  it("leaves parameters it does not parse untouched", () => {
    // The SDK stores more names than this module reads. Replacing the object
    // rather than merging into it would silently cost the bridge its start
    // parameter on the next document.
    window.sessionStorage.setItem(
      SDK_KEY,
      JSON.stringify({ tgWebAppStartParam: "ref_42", tgWebAppBotInline: "1", _path: "" }),
    );
    withLaunchHash();

    resolveTelegramLaunchParams();

    const stored = JSON.parse(window.sessionStorage.getItem(SDK_KEY) ?? "null");
    expect(stored.tgWebAppStartParam).toBe("ref_42");
    expect(stored.tgWebAppBotInline).toBe("1");
    expect(stored.tgWebAppData).toBe(CAPTURED_INIT_DATA);
  });

  it("survives sessionStorage being unavailable", () => {
    // Private mode and hostile embedders both throw on access. The URL is the
    // primary source, so a failed mirror may cost a LATER document its bridge
    // — never this one its sign-in.
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    withLaunchHash();

    try {
      expect(readTelegramLaunchInitData()).toBe(CAPTURED_INIT_DATA);
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});
