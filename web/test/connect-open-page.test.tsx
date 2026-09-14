// @vitest-environment jsdom

/**
 * THE TRAMPOLINE PAGE OPENS WHAT THE OPERATOR'S CATALOG WOULD HAVE BUILT, AROUND
 * A SUBSCRIPTION THIS CABINET ISSUED, FROM A TAP — AND NOTHING ELSE.
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
 *   - the subscription inside it must be one the cabinet signed: the page asks
 *     with the SHA-256 of the url and the signature, and opens nothing on any
 *     answer but a yes — a crafted address around a stranger's subscription,
 *     even through the operator's own template, gets no button;
 *   - nothing is clickable before BOTH checks have answered;
 *   - the two requests are the public catalog and that check, and neither
 *     carries the subscription url or the link.
 *
 * The React Query client is REAL here and only the transport functions are
 * stubbed: a stubbed `useQuery` would decide for the page when an answer
 * "arrived", which is the very ordering these cases are about. The verify stub
 * is a fake cabinet that really checks an HMAC over the digest it is sent, so a
 * page that sent anything but the right digest would be told no.
 */

import { createHash, createHmac } from "node:crypto";
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
  subscriptionDigest,
  trampolineUrl,
  verifyTrampolinePayload,
} from "@/features/connect/connect-trampoline";

const SUBSCRIPTION_URL = "https://sub.example.test/s/AbC123";
const HAPP_LINK = `happ://add/${SUBSCRIPTION_URL}`;
/** An operator-defined app with a scheme the shipped catalog never had. */
const OPERATOR_LINK = `shopvpn://import?url=${encodeURIComponent(SUBSCRIPTION_URL)}`;
/** A subscription this cabinet never issued, on a host the sender controls. */
const FOREIGN_URL = "https://evil.example.test/sub/attacker";

/** Stands in for the cabinet's derived key. The page never sees it. */
const CABINET_KEY = "fake-cabinet-key-for-this-spec";

/** What `GET /subscriptions/all` would have put on a subscription with this url. */
function signFor(url: string): string {
  return createHmac("sha256", CABINET_KEY).update(createHash("sha256").update(url, "utf8").digest()).digest("base64url");
}

/** base64url of the raw SHA-256 of the url — what the page must send. */
function digestOf(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("base64url");
}

/** The cabinet as the page meets it: yes only for its own signature over the digest it receives. */
async function fakeCabinet(input: { digest: string; signature: string }): Promise<{ valid: boolean }> {
  const expected = createHmac("sha256", CABINET_KEY).update(Buffer.from(input.digest, "base64url")).digest("base64url");
  return { valid: input.signature === expected };
}

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
const verifyConnectHandoff = vi.fn<(input: { digest: string; signature: string }) => Promise<unknown>>();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key} ${JSON.stringify(options)}`,
    i18n: { language: "ru" },
  }),
}));
vi.mock("@/lib/api-client", () => ({
  getConnectPage: () => getConnectPage(),
  verifyConnectHandoff: (input: { digest: string; signature: string }) => verifyConnectHandoff(input),
}));
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
 * Let both checks settle and React commit what they decided.
 *
 * Macrotasks, not microtasks: React Query's notify manager batches through
 * `setTimeout(0)`, so a loop of resolved promises finishes before the query has
 * told anybody it has data, and every case would be asserted on "checking".
 * Twenty rather than a handful because there are now two queries in sequence
 * and a SHA-256 between them, which `crypto.subtle` answers on a later turn.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
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

function copyButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>("button[data-connect-open-copy]");
}

function trampolineHash(link: string, subscriptionUrl = SUBSCRIPTION_URL, signature = signFor(subscriptionUrl)): string {
  return new URL(trampolineUrl("https://cabinet.example.test", { link, subscriptionUrl, signature })).hash;
}

/** A fragment written by hand, the way anybody can write one: base64url JSON. */
function handmadeFragment(fields: Record<string, unknown>): string {
  return `#${Buffer.from(JSON.stringify(fields), "utf8").toString("base64url")}`;
}

let fetchSpy: ReturnType<typeof vi.fn>;
let xhrOpen: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getConnectPage.mockReset();
  getConnectPage.mockResolvedValue(CATALOG_PAYLOAD);
  verifyConnectHandoff.mockReset();
  verifyConnectHandoff.mockImplementation(fakeCabinet);
  toast.success.mockReset();
  toast.error.mockReset();
  // Any request that is not one of the stubbed transport calls lands here and
  // fails the case that made it.
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

describe("a link the operator's catalog vouches for, around a subscription the cabinet signed", () => {
  it("opens from a same-window anchor, after the catalog and the signature check and nothing else", async () => {
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
    expect(verifyConnectHandoff).toHaveBeenCalledTimes(1);
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
        copyButton(el)?.click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith(SUBSCRIPTION_URL);
      expect(toast.success).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(window.navigator, "clipboard");
    }
  });
});

/**
 * Copying is this page's way out when the app does not open, and the page lands
 * exactly where the clipboard API is least dependable: Telegram's in-app browser
 * and the other in-app browsers `openLink` can hand it to.
 */
describe("copying when navigator.clipboard is no help", () => {
  /** jsdom has no `execCommand`: each case installs the document's answer. */
  function documentCopies(answer: boolean): ReturnType<typeof vi.fn> {
    const execCommand = vi.fn((_command: string) => answer);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    return execCommand;
  }

  function clipboard(value: unknown): void {
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value });
  }

  async function readyPage(): Promise<HTMLDivElement> {
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();
    expect(verdict(el)).toBe("ready");
    return el;
  }

  /** A macrotask, not a microtask: a refused write settles a few promise turns later. */
  async function tapCopy(el: HTMLElement): Promise<void> {
    await act(async () => {
      copyButton(el)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
    Reflect.deleteProperty(window.navigator, "clipboard");
  });

  it("copies through the selection when the browser has no navigator.clipboard", async () => {
    clipboard(undefined);
    const execCommand = documentCopies(true);
    const el = await readyPage();

    await tapCopy(el);

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(toast.success).toHaveBeenCalledWith("connect.copied");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("copies through the selection when navigator.clipboard refuses the write", async () => {
    const writeText = vi.fn(async (_value: string) => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    clipboard({ writeText });
    const execCommand = documentCopies(true);
    const el = await readyPage();

    await tapCopy(el);

    expect(writeText).toHaveBeenCalledWith(SUBSCRIPTION_URL);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(toast.success).toHaveBeenCalledWith("connect.copied");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("sends the subscriber back to Telegram when neither path copies — this page shows no link to select", async () => {
    clipboard(undefined);
    const execCommand = documentCopies(false);
    const el = await readyPage();

    await tapCopy(el);

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(toast.success).not.toHaveBeenCalled();
    // `connect.copyFailed` is the connect screen's line: it sends the subscriber
    // to the QR code behind that screen's header icon, which this page does not
    // have. Nor is there a link on this page to select by hand:
    expect(el.textContent).not.toContain(SUBSCRIPTION_URL);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("connect.openCopyFailed");
  });
});

/**
 * A tap, never an attempt on load: Chrome refuses an app scheme no gesture
 * started, and on iOS a page that redirects by itself reads as broken.
 *
 * jsdom cannot go to another document, and it REPORTS every attempt on its
 * virtual console as a `not-implemented` error: `location.assign`, `replace`, an
 * `href` assignment, an anchor's activation. That report is the only trace a
 * scripted navigation leaves here — `Location`'s methods are unforgeable, so no
 * spy can stand in for them.
 */
describe("the page never opens the app by itself", () => {
  interface VirtualConsoleLike {
    on(event: "jsdomError", listener: (error: Error & { type?: string }) => void): unknown;
    off(event: "jsdomError", listener: (error: Error & { type?: string }) => void): unknown;
  }

  it("neither navigates nor clicks its own button once both checks have said yes", async () => {
    const virtualConsole = (globalThis as unknown as { jsdom?: { virtualConsole?: VirtualConsoleLike } }).jsdom
      ?.virtualConsole;
    if (virtualConsole === undefined) throw new Error("vitest's jsdom environment no longer exposes its JSDOM instance");
    const navigations: string[] = [];
    const onJsdomError = (error: Error & { type?: string }): void => {
      if (error.type === "not-implemented") navigations.push(error.message);
    };
    const clicks: Element[] = [];
    const onClick = (event: Event): void => {
      clicks.push(event.target as Element);
    };
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    virtualConsole.on("jsdomError", onJsdomError);
    document.addEventListener("click", onClick, true);
    try {
      openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
      const el = render();
      await settle();
      expect(verdict(el)).toBe("ready");
      // Room for anything a ready page could have queued: an effect, a timer.
      await settle();

      expect(navigations, "the page navigated without a tap").toEqual([]);
      expect(clicks, "the page clicked a control of its own").toEqual([]);
      expect(open, "the page opened a window without a tap").not.toHaveBeenCalled();

      // The harness does see a navigation when one happens — a real tap on the
      // button is one — so the silence above is evidence and not a deaf ear.
      act(() => appButton(el)?.click());
      await settle();
      expect(clicks).toHaveLength(1);
      expect(navigations, "jsdom did not report the tap's navigation; this case proves nothing").toHaveLength(1);
    } finally {
      virtualConsole.off("jsdomError", onJsdomError);
      document.removeEventListener("click", onClick, true);
    }
  });
});

describe("the signature check carries a digest and a signature, and nothing else", () => {
  it("sends the SHA-256 of the subscription url with the signature — never the url, the host or the link", async () => {
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    render();
    await settle();

    expect(verifyConnectHandoff).toHaveBeenCalledTimes(1);
    const [input] = verifyConnectHandoff.mock.calls[0] ?? [];
    expect(input).toEqual({ digest: digestOf(SUBSCRIPTION_URL), signature: signFor(SUBSCRIPTION_URL) });
    const sent = JSON.stringify(input);
    expect(sent).not.toContain("sub.example.test");
    expect(sent).not.toContain("happ:");
    expect(sent).not.toContain("AbC123");
  });

  it("hashes the url's UTF-8 bytes, exactly as the cabinet does", async () => {
    const url = "https://sub.example.test/s/Ключ?x=1&y=a+b%20c#frag";

    expect(await subscriptionDigest(url)).toBe(digestOf(url));
    expect(await subscriptionDigest(url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not ask the cabinet about a link the catalog already refused", async () => {
    openAt(`/connect/open${trampolineHash(`happ://import-profile/${SUBSCRIPTION_URL}`)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("unverified");
    expect(verifyConnectHandoff).not.toHaveBeenCalled();
  });
});

describe("a subscription this cabinet never issued gets no button, whatever template carries it", () => {
  it("a crafted address around a stranger's subscription, with a genuine signature of another one", async () => {
    // The attack this check exists for: the operator's own template, around the
    // sender's own subscription, with a signature the cabinet really issued —
    // for a different url. Before the check, this page offered the button.
    openAt(
      `/connect/open${handmadeFragment({ link: `happ://add/${FOREIGN_URL}`, sub: FOREIGN_URL, sig: signFor(SUBSCRIPTION_URL) })}`,
    );
    const el = render();
    await settle();

    expect(appButton(el), "the page offered to add a subscription the cabinet never issued").toBeNull();
    expect(copyButton(el)).toBeNull();
    expect(verdict(el)).toBe("unverified");
    // Refused by the cabinet's answer, not by something earlier.
    expect(verifyConnectHandoff).toHaveBeenCalledWith({
      digest: digestOf(FOREIGN_URL),
      signature: signFor(SUBSCRIPTION_URL),
    });
  });

  it("a forged signature around the operator's own subscription", async () => {
    openAt(`/connect/open${trampolineHash(HAPP_LINK, SUBSCRIPTION_URL, digestOf("forged"))}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("unverified");
    expect(appButton(el)).toBeNull();
  });

  it("a payload with no signature is not a payload", async () => {
    openAt(`/connect/open${handmadeFragment({ link: HAPP_LINK, sub: SUBSCRIPTION_URL })}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("invalid");
    expect(appButton(el)).toBeNull();
    expect(getConnectPage).not.toHaveBeenCalled();
    expect(verifyConnectHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ["one character short", signFor(SUBSCRIPTION_URL).slice(0, 42)],
    ["one character long", `${signFor(SUBSCRIPTION_URL)}A`],
    ["from the standard base64 alphabet", `+${signFor(SUBSCRIPTION_URL).slice(1)}`],
    ["a number", 42],
    ["empty", ""],
  ])("a signature that is %s is not a payload either", async (_name, sig) => {
    openAt(`/connect/open${handmadeFragment({ link: HAPP_LINK, sub: SUBSCRIPTION_URL, sig })}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("invalid");
    expect(verifyConnectHandoff).not.toHaveBeenCalled();
  });
});

describe("nothing is clickable until both checks have answered yes", () => {
  it("shows no button while the catalog is being read", async () => {
    getConnectPage.mockReturnValue(new Promise(() => undefined));
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("checking");
    expect(appButton(el)).toBeNull();
    expect(copyButton(el)).toBeNull();
  });

  it("shows no button while the signature is being checked", async () => {
    verifyConnectHandoff.mockReturnValue(new Promise(() => undefined));
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verifyConnectHandoff).toHaveBeenCalledTimes(1);
    expect(verdict(el)).toBe("checking");
    expect(appButton(el), "the button was there before the cabinet answered").toBeNull();
    expect(copyButton(el)).toBeNull();
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

  it("offers a retry, not the button, when the cabinet cannot be asked — and the retry asks the cabinet again", async () => {
    // A network failure and a 5xx both reach the page as a rejected call.
    verifyConnectHandoff.mockRejectedValueOnce(new Error("Request failed with status code 503"));
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("failed");
    expect(appButton(el), "a check that failed was taken for a yes").toBeNull();
    expect(copyButton(el)).toBeNull();

    await act(async () => {
      el.querySelector<HTMLButtonElement>("button[data-connect-open-retry]")?.click();
    });
    await settle();

    expect(verifyConnectHandoff).toHaveBeenCalledTimes(2);
    expect(getConnectPage, "the retry re-read the catalog instead of re-asking the cabinet").toHaveBeenCalledTimes(1);
    expect(verdict(el)).toBe("ready");
    expect(appButton(el)?.getAttribute("href")).toBe(HAPP_LINK);
  });

  it.each([
    ["a string that says true", { valid: "true" }],
    ["no answer at all", {}],
    ["null", null],
  ])("treats an answer that is not a boolean — %s — as a check that did not happen", async (_name, answer) => {
    verifyConnectHandoff.mockResolvedValue(answer);
    openAt(`/connect/open${trampolineHash(HAPP_LINK)}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("failed");
    expect(appButton(el)).toBeNull();
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
    expect(copyButton(el)).toBeNull();
    expect(verifyConnectHandoff).not.toHaveBeenCalled();
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
    expect(verifyConnectHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ["no fragment", ""],
    ["percent garbage", "#%E0%A4%A"],
    ["base64 of nothing useful", "#AAAA"],
    ["an array", `#${btoa("[1,2]")}`],
    ["a link with no subscription", `#${btoa(JSON.stringify({ link: HAPP_LINK, sig: signFor(SUBSCRIPTION_URL) }))}`],
    // A payload that WOULD decode — a string of `A`s is not base64 and would be
    // refused with or without the length cap, guarding nothing.
    ["an oversized fragment", trampolineHash(`${HAPP_LINK}?pad=${"x".repeat(20_000)}`)],
  ])("%s", async (_name, fragment) => {
    openAt(`/connect/open${fragment}`);
    const el = render();
    await settle();

    expect(verdict(el)).toBe("invalid");
    expect(getConnectPage).not.toHaveBeenCalled();
    expect(verifyConnectHandoff).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the checks that no catalog can talk the page out of", () => {
  const SIGNATURE = signFor(SUBSCRIPTION_URL);

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
      expect(
        verifyTrampolinePayload(catalogWith(template), { link, subscriptionUrl: SUBSCRIPTION_URL, signature: SIGNATURE }),
      ).toBe(false);
    },
  );

  it.each(["javascript", "data", "vbscript", "file", "blob", "about"])(
    "refuses %s: even when a catalog lists it",
    (scheme) => {
      const template = `${scheme}:{{SUBSCRIPTION_LINK}}`;
      const link = template.replace("{{SUBSCRIPTION_LINK}}", SUBSCRIPTION_URL);
      expect(
        verifyTrampolinePayload(catalogWith(template), { link, subscriptionUrl: SUBSCRIPTION_URL, signature: SIGNATURE }),
      ).toBe(false);
    },
  );

  it("refuses a subscription that is not an http(s) address", () => {
    const template = "happ://add/{{SUBSCRIPTION_LINK}}";
    const subscriptionUrl = "javascript:alert(1)";
    expect(
      verifyTrampolinePayload(catalogWith(template), {
        link: `happ://add/${subscriptionUrl}`,
        subscriptionUrl,
        signature: SIGNATURE,
      }),
    ).toBe(false);
  });

  it("accepts the same template with a real subscription — the control for the three above", () => {
    const template = "happ://add/{{SUBSCRIPTION_LINK}}";
    expect(
      verifyTrampolinePayload(catalogWith(template), {
        link: HAPP_LINK,
        subscriptionUrl: SUBSCRIPTION_URL,
        signature: SIGNATURE,
      }),
    ).toBe(true);
  });
});

describe("the address survives every host that carries it", () => {
  it("round-trips links full of the characters URL escapers rewrite, with their signature", () => {
    const subscriptionUrl = "https://sub.example.test/s/Ключ?x=1&y=a+b%20c#frag";
    const link = `happ://add/${subscriptionUrl}`;
    const signature = signFor(subscriptionUrl);
    const url = trampolineUrl("https://cabinet.example.test", { link, subscriptionUrl, signature });
    const hash = new URL(url).hash;

    // Letters, digits, `-` and `_` only: nothing for Telegram's iOS, Android,
    // macOS or web link handling to percent-encode, rebuild or split.
    expect(hash.slice(1)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readTrampolinePayload(hash)).toEqual({ link, subscriptionUrl, signature });
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
