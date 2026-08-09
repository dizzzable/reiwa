// @vitest-environment jsdom

/**
 * Mini App ad attribution must work without telegram.org.
 *
 * A campaign link is `t.me/<bot>/app?startapp=ad_<code>`, and Telegram delivers
 * that to the Mini App as the launch parameter `tgWebAppStartParam` — in the
 * URL, from the first byte. `useAdAttribution` read it only from the bridge
 * (`initDataUnsafe.start_param`), which exists after ~100 KB has been fetched
 * from telegram.org. This product sells VPN, so the person who tapped the ad has
 * no VPN yet and that is the host their network blocks: the placement recorded
 * nothing.
 *
 * The query fallback next to it cannot cover the gap and never could. It looks
 * for `?startapp=` and `?campaign=`, and Telegram puts the start parameter in
 * neither — so on the Mini App surface, which has no server-side `ad-capture`
 * middleware to fall back on either, the entire funnel was dark.
 *
 * `window.Telegram` is defined nowhere, and the bridge's `startParam` is null
 * throughout.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ recordAdClick: vi.fn() }));
const sessionState = vi.hoisted(() => ({
  session: { userId: "u1" } as unknown,
  isAuthenticated: true,
}));
/** The bridge never arrives, so it never supplies a start parameter. */
const bridge = vi.hoisted(() => ({ startParam: null as string | null }));

vi.mock("@/lib/api-client", () => api);
vi.mock("@/hooks/use-session", () => ({ useSession: () => sessionState }));
vi.mock("@/hooks/use-telegram-webapp", () => ({
  useTelegramWebApp: () => bridge,
}));

import { useAdAttribution } from "@/hooks/use-ad-attribution";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

const INIT_DATA = `user=%7B%22id%22%3A42%7D&auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`;
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe(): ReactNode {
  useAdAttribution();
  return null;
}

async function mountProbe(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/dashboard");
  window.location.hash = "";
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  bridge.startParam = null;
  api.recordAdClick.mockResolvedValue({ ok: true, recorded: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.sessionStorage.clear();
  window.localStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ad attribution for a Mini App launch with no Telegram SDK", () => {
  it("records the campaign from the launch parameter in the URL", async () => {
    window.location.hash =
      `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppStartParam=ad_spring25`;

    await mountProbe();

    expect(
      api.recordAdClick,
      "the campaign was never recorded — Mini App ad attribution still depends on telegram.org, which is the host the people who tapped the ad cannot reach",
    ).toHaveBeenCalledWith("spring25", undefined, undefined);
    expect(window.Telegram, "the bridge was defined; this case proves nothing").toBeUndefined();
  });

  it("records it from the session mirror once the fragment is gone", async () => {
    // Attribution mounts at the app root on every route, and by the time a
    // session exists the entry hop has replaced the URL.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppStartParam: "ad_spring25" }),
    );
    expect(window.location.hash).toBe("");

    await mountProbe();

    expect(api.recordAdClick).toHaveBeenCalledWith("spring25", undefined, undefined);
  });

  it("prefers the launch parameter over a stale `?campaign=` left in the query", async () => {
    // The web funnel's marker can still be sitting in the URL from an earlier
    // hop. Telegram's own launch parameter is the one that describes THIS
    // launch, so it wins.
    window.history.replaceState(
      {},
      "",
      "/dashboard?campaign=ad_other#tgWebAppStartParam=ad_spring25",
    );

    await mountProbe();

    expect(api.recordAdClick).toHaveBeenCalledWith("spring25", undefined, undefined);
  });

  it("records nothing when no campaign came through at all", async () => {
    // The other end: a fix that recorded unconditionally would attribute every
    // organic visit to whatever it last saw.
    await mountProbe();

    expect(api.recordAdClick).not.toHaveBeenCalled();
  });
});
