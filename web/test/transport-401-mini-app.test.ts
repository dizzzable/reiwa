import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SESSION SIGNED OUT UNDER THE MINI APP GOES BACK THROUGH TELEGRAM.
 *
 * A cabinet session now ends mid-use when the account's password changes, or
 * «Выйти на всех устройствах» is pressed, somewhere else: the next request gets
 * 401. The shared transport answered every such 401 with the sign-in form —
 * which, inside Telegram, is a password form for a user who may never have had
 * a password. Under the Mini App it now goes to `/bootstrap`, which re-reads the
 * launch's Telegram credential and opens a fresh session with nothing asked.
 * In a browser nothing changes.
 *
 * Driven through the real transport and a real API function; only the adapter
 * (the network) and `window` are doubles — for the reason
 * `channel-gate-transport-401.test.ts` gives: jsdom's `location.replace` is
 * unforgeable and does not navigate, so a bounce there would be invisible.
 */

const replace = vi.fn();

const unauthorized: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  throw new AxiosError("Request failed with status code 401", AxiosError.ERR_BAD_REQUEST, config, null, {
    status: 401,
    statusText: "Unauthorized",
    headers: {},
    config,
    data: { message: "Unauthorized" },
  });
};

/** A document at `/dashboard`: its URL, its session store, and whatever else a case adds. */
function documentAt(extra: { readonly hash?: string; readonly Telegram?: unknown } = {}) {
  const stored = new Map<string, string>();
  return {
    location: { pathname: "/dashboard", search: "", hash: extra.hash ?? "", replace },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    },
    history: { replaceState: () => undefined },
    ...(extra.Telegram === undefined ? {} : { Telegram: extra.Telegram }),
  };
}

async function requestSignedOut(): Promise<void> {
  vi.resetModules();
  const { apiClient } = await import("@/lib/api-client/transport");
  apiClient.defaults.adapter = unauthorized;
  const session = await import("@/lib/api-client/session");
  await expect(session.getPlatformPolicy()).rejects.toMatchObject({ response: { status: 401 } });
}

beforeEach(() => {
  replace.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("where a session that died mid-use sends the user", () => {
  it("in a browser, to the sign-in form, as before", async () => {
    vi.stubGlobal("window", documentAt());

    await requestSignedOut();

    expect(replace.mock.calls).toEqual([["/sign-in"]]);
  });

  it("in the Mini App, back through Telegram — not to a password form", async () => {
    vi.stubGlobal(
      "window",
      documentAt({ hash: "#tgWebAppData=query_id%3DAAH%26auth_date%3D1%26hash%3Dabc&tgWebAppPlatform=ios&tgWebAppVersion=8.0" }),
    );

    await requestSignedOut();

    expect(replace.mock.calls).toEqual([["/bootstrap"]]);
  });

  it("in the Mini App whose address a navigation already emptied, by the Telegram bridge", async () => {
    vi.stubGlobal("window", documentAt({ Telegram: { WebApp: { initData: "" } } }));

    await requestSignedOut();

    expect(replace.mock.calls).toEqual([["/bootstrap"]]);
  });
});
