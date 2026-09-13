// @vitest-environment jsdom

/**
 * THE TRAMPOLINE PAGE OPENS WHAT THE OPERATOR'S CATALOG WOULD HAVE BUILT, FROM A
 * TAP, AND NOTHING ELSE.
 *
 * `/connect/open` is where an "add to app" link lands after leaving a Telegram
 * Mini App through `openLink`. It is public — Safari, a Custom Tab or Telegram's
 * in-app browser has none of the Mini App's cookies — so anybody can hand
 * anybody an address of it, and whatever its button opens, it opens on the
 * operator's own domain. Each case below is a way that could go wrong:
 *
 *   - the link must come from the FRAGMENT, which no request carries;
 *   - it must be what some deep-link button of the operator's own catalog builds
 *     from the subscription URL beside it — any scheme the operator configured,
 *     none they did not;
 *   - http, https and executing schemes are refused before the catalog is read,
 *     so no catalog can talk the page into them;
 *   - nothing is clickable before that check has answered;
 *   - the one request is the public catalog, and nothing of the link is in it.
 *
 * The React Query client is REAL here and only the transport function is
 * stubbed: a stubbed `useQuery` would decide for the page when the catalog
 * "arrived", which is the very ordering these cases are about.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectButton, ConnectCatalog } from "@/features/connect/connect-catalog";
import {
  readTrampolinePayload,
  trampolineUrl,
  verifyTrampolinePayload,
} from "@/features/connect/connect-trampoline";

const SUBSCRIPTION_URL = "https://sub.example.test/s/AbC123";
const HAPP_LINK = `happ://add/${SUBSCRIPTION_URL}`;
/** An operator-defined app with a scheme the shipped catalog never had. */
const OPERATOR_LINK = `shopvpn://import?url=${encodeURIComponent(SUBSCRIPTION_URL)}`;

function deepLinkApp(id: string, template: string, encode: "raw" | "component") {
  return {
    id,
    name: id,
    iconKey: null,
    featured: false,
    steps: [
      {
        title: { ru: "Добавление подписки" },
        body: null,
        iconKey: null,
        buttons: [{ kind: "deepLink", label: { ru: "Добавить" }, template, encode }],
      },
    ],
  };
}

/** The catalog as the edge serves it — raw, re-read by the page itself. */
const CATALOG_PAYLOAD = {
  platforms: [
    {
      id: "ios",
      title: { ru: "iPhone" },
      apps: [deepLinkApp("happ", "happ://add/{{SUBSCRIPTION_LINK}}", "raw")],
    },
    {
      id: "android",
      title: { ru: "Android" },
      apps: [deepLinkApp("shop", "shopvpn://import?url={{SUBSCRIPTION_LINK}}", "component")],
    },
  ],
  icons: {},
  connectScreenEnabled: true,
};

const getConnectPage = vi.fn<() => Promise<unknown>>();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key} ${JSON.stringify(options)}`,
    i18n: { language: "ru" },
  }),
}));
vi.mock("@/lib/api-client", () => ({ getConnectPage: () => getConnectPage() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { default: ConnectOpenPage } = await import("../src/features/connect/connect-open-page");

const HERE = dirname(fileURLToPath(import.meta.url));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function openAt(address: string): void {
  window.history.replaceState({}, "", address);
}

function render(): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <ConnectOpenPage />
      </QueryClientProvider>,
    ),
  );
  return host;
}

/**
 * Let the catalog promise settle and React commit what it decided.
 *
 * Macrotasks, not microtasks: React Query's notify manager batches through
 * `setTimeout(0)`, so a loop of resolved promises finishes before the query has
 * told anybody it has data, and every case would be asserted on "checking".
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function verdict(el: HTMLElement): string | null {
  return el.querySelector("[data-testid='connect-open']")?.getAttribute("data-verdict") ?? null;
}

function appButton(el: HTMLElement): HTMLAnchorElement | null {
  return el.querySelector<HTMLAnchorElement>("a[data-connect-open-app]");
}

function trampolineHash(link: string, subscriptionUrl = SUBSCRIPTION_URL): string {
  return new URL(trampolineUrl("https://cabinet.example.test", { link, subscriptionUrl })).hash;
}

let fetchSpy: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getConnectPage.mockReset();
  getConnectPage.mockResolvedValue(CATALOG_PAYLOAD);
  toast.success.mockReset();
  toast.error.mockReset();
  // Any request that is not the stubbed catalog read lands here and fails the
  // case that made it.
  fetchSpy = vi.fn(async () => new Response(null, { status: 599 }));
  vi.stubGlobal("fetch", fetchSpy);
  xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
  openAt("/connect/open");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  openAt("/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a link the operator's catalog vouches for", () => {
  it("opens from a same-window anchor, after one request for the public catalog and nothing else", async () => {
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("ready");
    const anchor = appButton(el);
    expect(anchor?.getAttribute("href")).toBe(HAPP_LINK);
    // The shape the owner saw work in Safari: no new window, no script.
    expect(anchor?.hasAttribute("target")).toBe(false);
    expect(anchor?.hasAttribute("onclick")).toBe(false);

    expect(getConnectPage).toHaveBeenCalledTimes(1);
    expect(fetchSpy, "the page made a request of its own").not.toHaveBeenCalled();
    expect(xhrOpen, "the page made a request of its own").not.toHaveBeenCalled();
  });

  it("accepts a scheme only the operator configured, whatever it is", async () => {
    openAt(`/connect/open${trampolineHash(OPERATOR_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("ready");
    expect(appButton(el)?.getAttribute("href")).toBe(OPERATOR_LINK);
  });

  it("names the subscription host beside the button", async () => {
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(el.querySelector("[data-connect-open-host]")?.textContent).toContain("sub.example.test");
  });

  it("copies the subscription URL, not the deep link", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
      const el = render();
      await settle();

      await act(async () => {
        el.querySelector<HTMLButtonElement>("button[data-connect-open-copy]")?.click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith(SUBSCRIPTION_URL);
      expect(toast.success).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window.navigator, "clipboard");
    }
  });
});

describe("nothing is clickable until the catalog has answered", () => {
  it("shows no button while the check is running", async () => {
    getConnectPage.mockReturnValue(new Promise(() => undefined));
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("checking");
    expect(appButton(el)).toBeNull();
    expect(el.querySelector("button[data-connect-open-copy]")).toBeNull();
  });

  it("offers a retry, not the button, when the catalog cannot be read", async () => {
    getConnectPage.mockRejectedValue(new Error("offline"));
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("failed");
    expect(appButton(el)).toBeNull();
    expect(el.textContent).toContain("common.retry");
  });

  it("refuses when the edge has no catalog at all", async () => {
    getConnectPage.mockResolvedValue(null);
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("unverified");
    expect(appButton(el)).toBeNull();
  });
});

describe("a link the catalog would not have built is refused", () => {
  it.each([
    ["another endpoint of a configured app", `happ://import-profile/${SUBSCRIPTION_URL}`],
    ["a scheme nobody configured", `itms-services://?action=download-manifest&url=${SUBSCRIPTION_URL}`],
    ["a configured template around a different subscription", `happ://add/https://other.example.test/s/1`],
    ["an Android intent URL", `intent://add/#Intent;scheme=happ;end`],
  ])("%s", async (_name, link) => {
    openAt(`/connect/open${trampolineHash(link)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("unverified");
    expect(appButton(el)).toBeNull();
    expect(el.querySelector("button[data-connect-open-copy]")).toBeNull();
  });
});

describe("the fragment is the only carrier, and a bad one costs nothing", () => {
  it("ignores a link in the query string and asks the network nothing", async () => {
    const hash = trampolineHash(HAPP_LINK);
    openAt(`/connect/open?${hash.slice(1)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("invalid");
    expect(getConnectPage).not.toHaveBeenCalled();
  });

  it.each([
    ["no fragment", ""],
    ["percent garbage", "#%E0%A4%A"],
    ["base64 of nothing useful", "#AAAA"],
    ["an array", `#${btoa("[1,2]")}`],
    ["a link with no subscription", `#${btoa(JSON.stringify({ link: HAPP_LINK }))}`],
    // A payload that WOULD decode — a string of `A`s is not base64 and would be
    // refused with or without the length cap, guarding nothing.
    ["an oversized fragment", trampolineHash(`${HAPP_LINK}?pad=${"x".repeat(20_000)}`)],
  ])("%s", async (_name, fragment) => {
    openAt(`/connect/open${fragment}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("invalid");
    expect(getConnectPage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the checks that no catalog can talk the page out of", () => {
  /** A catalog built by hand, as if the reader had let a template through. */
  function catalogWith(template: string): ConnectCatalog {
    const button: ConnectButton = { kind: "deepLink", label: { ru: "x" }, template, encode: "raw" };
    return {
      platforms: [
        {
          id: "ios",
          title: { ru: "x" },
          iconKey: null,
          apps: [
            {
              id: "x",
              name: "x",
              iconKey: null,
              featured: false,
              steps: [{ title: { ru: "x" }, body: null, iconKey: null, iconColor: null, buttons: [button] }],
            },
          ],
        },
      ],
      icons: {},
      connectScreenEnabled: true,
      featuredColor: "#FACC15",
    };
  }

  it.each(["https://evil.example.test/{{SUBSCRIPTION_LINK}}", "http://evil.example.test/{{SUBSCRIPTION_LINK}}"])(
    "refuses a browser navigation even when a catalog lists it: %s",
    (template) => {
      const link = template.replace("{{SUBSCRIPTION_LINK}}", SUBSCRIPTION_URL);
      expect(verifyTrampolinePayload(catalogWith(template), { link, subscriptionUrl: SUBSCRIPTION_URL })).toBe(
        false,
      );
    },
  );

  it.each(["javascript", "data", "vbscript", "file", "blob", "about"])(
    "refuses %s: even when a catalog lists it",
    (scheme) => {
      const template = `${scheme}:{{SUBSCRIPTION_LINK}}`;
      const link = template.replace("{{SUBSCRIPTION_LINK}}", SUBSCRIPTION_URL);
      expect(verifyTrampolinePayload(catalogWith(template), { link, subscriptionUrl: SUBSCRIPTION_URL })).toBe(
        false,
      );
    },
  );

  it("refuses a subscription that is not an http(s) address", () => {
    const template = "happ://add/{{SUBSCRIPTION_LINK}}";
    const subscriptionUrl = "javascript:alert(1)";
    expect(
      verifyTrampolinePayload(catalogWith(template), {
        link: `happ://add/${subscriptionUrl}`,
        subscriptionUrl,
      }),
    ).toBe(false);
  });

  it("accepts the same template with a real subscription — the control for the three above", () => {
    const template = "happ://add/{{SUBSCRIPTION_LINK}}";
    expect(
      verifyTrampolinePayload(catalogWith(template), { link: HAPP_LINK, subscriptionUrl: SUBSCRIPTION_URL }),
    ).toBe(true);
  });
});

describe("the address survives every host that carries it", () => {
  it("round-trips links full of the characters URL escapers rewrite", () => {
    const subscriptionUrl = "https://sub.example.test/s/Ключ?x=1&y=a+b%20c#frag";
    const link = `happ://add/${subscriptionUrl}`;
    const url = trampolineUrl("https://cabinet.example.test", { link, subscriptionUrl });
    const hash = new URL(url).hash;

    // Letters, digits, `-` and `_` only: nothing for Telegram's iOS, Android,
    // macOS or web link handling to percent-encode, rebuild or split.
    expect(hash.slice(1)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readTrampolinePayload(hash)).toEqual({ link, subscriptionUrl });
  });
});

describe("the route really is public", () => {
  // Source-text contracts, deliberately: the property is WHERE the route is
  // declared and WHICH list the transport consults, and rendering the whole
  // router to observe it would test the router instead.
  const app = readFileSync(join(HERE, "..", "src", "App.tsx"), "utf8");
  const transport = readFileSync(join(HERE, "..", "src", "lib", "api-client", "transport.ts"), "utf8");

  it("is declared before the protected shell opens", () => {
    const route = app.indexOf('path="/connect/open"');
    const shell = app.indexOf("<Route element={<StealthLayout />}>");
    expect(route, "the route is not declared at all").toBeGreaterThan(0);
    expect(shell, "the protected shell was not found — this contract needs updating").toBeGreaterThan(0);
    expect(route, "the trampoline sits inside the session-guarded shell").toBeLessThan(shell);
  });

  it("is one of the paths a 401 never bounces to the sign-in form", () => {
    const list = /const PUBLIC_PATHS = \[([\s\S]*?)\];/.exec(transport)?.[1] ?? "";
    expect(list.length, "PUBLIC_PATHS was not found").toBeGreaterThan(0);
    expect(list).toContain('"/connect/open"');
  });
});
