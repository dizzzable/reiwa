// @vitest-environment jsdom

/**
 * Which QR codes the operator's style reaches — proven by drawing them.
 *
 * ── The owner's decisions this file holds in place ──────────────────────────
 *
 *   1. By default a code is not styled. So every "plain" case compares against
 *      `qrcode`'s own SVG writer with `qrOptions()` — the cabinet's unstyled
 *      baseline — byte for byte, and NOT against the renderer under test,
 *      which could agree with itself. That baseline is the one this patch
 *      establishes, not the bitmap the released cabinet drew: that one came out
 *      of `toDataURL` with a one-module quiet zone, and both moved deliberately
 *      (see `qr-options`). What must not move is styling reaching a code
 *      nobody styled.
 *   2. Styling reaches the referral invite and the partner's advertising codes.
 *      The connect code — the subscription link, read by VPN clients' in-app
 *      scanners — stays plain WHATEVER the branding says.
 *
 * The branding is mocked because the branding is the input: the question is
 * what each call site does with it. It is mocked for `LocalQr` too, which never
 * reads it — that is exactly what the "does not look it up" cases catch the day
 * it starts to.
 *
 * `qrcode` is not mocked anywhere here. What reaches each `<img>` is read back
 * out of its data URL and compared as markup.
 */
import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import QRCode from "qrcode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planQrLogo } from "@/lib/qr-logo";
import { loadQrLogo } from "@/lib/qr-logo-source";
import { qrOptions } from "@/lib/qr-options";
import { isUsableDark, qrSvg, resolveQrStyle, type QrStyle } from "@/lib/qr-style";
import { DEFAULT_BRANDING, type Branding } from "@/types/branding";

const brandingState = vi.hoisted(() => ({ branding: {} as Branding }));
const api = vi.hoisted(() => ({
  getPartnerAdStats: vi.fn(),
  getPartnerAdRequests: vi.fn(),
  createPartnerAdRequest: vi.fn(),
  acceptPartnerAdRequest: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: brandingState.branding, botUsername: null }),
}));
vi.mock("@/lib/api-client", () => api);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }));
// The copy tile's little icon swap; nothing here is about it.
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  motion: {
    span: ({ children }: { readonly children?: ReactNode }) => <span>{children}</span>,
  },
  useReducedMotion: () => false,
}));
// Rendered in place instead of portalled, so a code is found where it was
// drawn. The trigger opens the dialog it sits in, as Radix's does; the real
// primitive — focus, Escape — is driven in `qr-partner-dialog.test.tsx`.
vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const Open = React.createContext<{ readonly open: boolean; readonly setOpen: (open: boolean) => void }>({
    open: false,
    setOpen: () => undefined,
  });
  return {
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      readonly open: boolean;
      readonly onOpenChange?: (open: boolean) => void;
      readonly children?: ReactNode;
    }) => <Open.Provider value={{ open, setOpen: (next) => onOpenChange?.(next) }}>{children}</Open.Provider>,
    DialogTrigger: ({ children }: { readonly children: React.ReactElement<{ onClick?: () => void }> }) => {
      const { setOpen } = React.useContext(Open);
      return React.cloneElement(children, { onClick: () => setOpen(true) });
    },
    DialogContent: ({ children }: { readonly children?: ReactNode }) =>
      React.useContext(Open).open ? <div data-testid="dialog-content">{children}</div> : null,
    DialogHeader: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { readonly children?: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { readonly children?: ReactNode }) => <p>{children}</p>,
  };
});

import { LocalQr } from "@/components/ui/local-qr";
import { ConnectLinkDialog } from "@/features/connect/connect-link-dialog";
import { PartnerAdvertisingSection } from "@/features/partner/components/partner-advertising-section";
import { InviteLinkHero } from "@/features/referrals/components/invite-link-hero";

const LINK = "https://cabinet.example.com/r/abc123";
const SUBSCRIPTION =
  "https://sub.example.com/subscription/9f2c1e7a-4d8b-4b2f-9c31-7a5e6f0b8d14" +
  "?token=aGVsbG8td29ybGQtdGhpcy1pcy1hLXJlYWxpc3RpYy1sZW5ndGgtdG9rZW4";
const TELEGRAM_INVITE = "https://t.me/reiwa_bot?start=ref_abc123";
const WEB_INVITE = "https://cabinet.example.com/register?ref=abc123";
const BOT_AD = "https://t.me/reiwa_bot?start=ad_abc123";
const WEB_AD = "https://cabinet.example.com/?ad=abc123";

/**
 * What an operator who styled their codes sends. The colour is upper-case on
 * purpose: `resolveQrStyle` lower-cases it, so a call site that handed the RAW
 * value on instead of the resolved one draws a different SVG and is caught.
 */
const OPERATOR_RAW = { modules: "dots", eyes: "rounded", dark: "#1E3A8A" };
const OPERATOR_STYLE: QrStyle = resolveQrStyle(OPERATOR_RAW);

/** The garbage the owner named; each must come out as a safe code — here, the plain one. */
const GARBAGE: ReadonlyArray<readonly [string, unknown]> = [
  ["a bare word", "dots"],
  ["an unknown module shape", { modules: "hearts" }],
  ["a white module colour", { dark: "#ffffff" }],
];

const DATA_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";

/** A small SVG logo, as the cabinet's upload relay would serve an operator's file. */
const SVG_LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="#e11d48"/></svg>';
/** What the loader makes of it. */
const LOGO_HREF = `data:image/svg+xml;base64,${btoa(SVG_LOGO)}`;

let logoFiles = 0;
/** A source no other case has loaded: the loader keeps a loaded logo for the life of the page. */
function freshLogoSrc(): string {
  logoFiles += 1;
  return `/uploads/branding/qr-logo-${logoFiles}.svg`;
}

/** The operator's raw style with a logo — what a panel with the setting sends. */
function withLogo(raw: Record<string, unknown>, src: string): Record<string, unknown> {
  return { ...raw, logo: { src, size: "small", plate: "light" } };
}

type Served = "the logo" | "a redirect to the stock icon" | "a 404" | "a network failure";

/**
 * `fetch`, answering as the cabinet's upload relay does — the file itself, the
 * 302 to the stock Reiwa icon it sends while the panel is down, a 404, or no
 * answer at all. Returns the stub, so a case can prove the load was attempted.
 */
function serveLogo(src: string, served: Served) {
  const fetch = vi.fn(async (input: string, _init?: unknown) => {
    if (served === "a network failure") throw new TypeError("Failed to fetch");
    // Every answer but the network failure carries a perfectly drawable SVG,
    // on purpose: then the redirect flag, or the status, is the ONLY thing
    // between that body and the code, and a loader that stopped checking it
    // would put a logo in and fail the case. Serving the stock PNG would not —
    // jsdom has no canvas, a raster never loads here, the case would pass anyway.
    return {
      ok: served !== "a 404",
      redirected: served === "a redirect to the stock icon",
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "image/svg+xml" : null) },
      arrayBuffer: async () => new TextEncoder().encode(input === src ? SVG_LOGO : "<svg/>").buffer,
    };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React Query's notifications on microtasks, so they land inside `act`.
  notifyManager.setScheduler(queueMicrotask);
  brandingState.branding = { ...DEFAULT_BRANDING };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  notifyManager.setScheduler(defaultScheduler);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function withQrStyle(qrStyle: unknown): Branding {
  return { ...DEFAULT_BRANDING, qrStyle };
}

/** A panel older than the setting: the key is not there at all. */
function fromAnOldPanel(): Branding {
  const { qrStyle: _absent, ...branding } = DEFAULT_BRANDING;
  return branding;
}

/** Today's code: `qrcode`'s own writer with the shared options — the owner's baseline. */
function todaysCode(text: string): Promise<string> {
  return QRCode.toString(text, qrOptions());
}

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

/** The markup a rendered code carries, or null when there is none yet. */
function readSvg(img: Element | null | undefined): string | null {
  const src = img?.getAttribute("src");
  if (src === null || src === undefined || !src.startsWith(DATA_URL_PREFIX)) return null;
  return decodeURIComponent(src.slice(DATA_URL_PREFIX.length));
}

/** Lets effects and the promises they started settle until `probe` answers, or fails naming `what`. */
async function settleFor<T>(probe: () => T | null | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  const value = probe();
  expect(value, `${what} never appeared`).not.toBeNull();
  expect(value, `${what} never appeared`).not.toBeUndefined();
  return value as T;
}

/** The SVG inside the first `<img>` matching `selector`, once it has been drawn. */
function drawnCode(selector: string, what: string, scope: ParentNode | null = container): Promise<string> {
  return settleFor(() => readSvg(scope?.querySelector(selector)), what);
}

/**
 * A "safe code" claim that does not take the resolver's word for it: an opaque
 * white field, something dark on it, and every dark colour one a scanner can
 * separate from white.
 */
function expectSafe(svg: string): void {
  const colours = [...new Set([...svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)].map((m) => m[1]!.toLowerCase()))];
  expect(colours, "the code paints no white field").toContain("#ffffff");
  const darks = colours.filter((colour) => colour !== "#ffffff");
  expect(darks.length, "the code paints nothing dark").toBeGreaterThan(0);
  for (const dark of darks) expect(isUsableDark(dark), `${dark} is too pale to scan`).toBe(true);
}

describe("LocalQr", () => {
  it("with no style, draws today's code — `qrcode`'s own writer, byte for byte", async () => {
    mount(<LocalQr url={LINK} label="code" size={208} />);
    expect(await drawnCode("img", "the code")).toBe(await todaysCode(LINK));
  });

  it("with a style, draws the styled code for the size it is shown at", async () => {
    mount(<LocalQr url={LINK} label="code" size={208} style={OPERATOR_STYLE} />);
    const svg = await drawnCode("img", "the code");
    expect(svg).toBe(await qrSvg(LINK, OPERATOR_STYLE, 208));
    // …and it really is a different picture, not the plain one by another road.
    expect(svg).not.toBe(await todaysCode(LINK));
    expect(svg).toContain("<circle");
  });

  it("passes its size on, so dots step down to rounded squares on a small code", async () => {
    // 96 CSS px across this symbol is under the pixels per module dots need.
    // A LocalQr that dropped its size would draw dots here as if it were big.
    mount(<LocalQr url={LINK} label="code" size={96} style={OPERATOR_STYLE} />);
    const svg = await drawnCode("img", "the code");
    expect(svg).toBe(await qrSvg(LINK, OPERATOR_STYLE, 96));
    expect(svg).not.toContain("<circle");
  });

  it("redraws when it is handed a different style", async () => {
    mount(<LocalQr url={LINK} label="code" size={208} />);
    expect(await drawnCode("img", "the plain code")).toBe(await todaysCode(LINK));

    act(() => {
      root?.render(<LocalQr url={LINK} label="code" size={208} style={OPERATOR_STYLE} />);
    });
    const styled = await qrSvg(LINK, OPERATOR_STYLE, 208);
    const redrawn = await settleFor(() => {
      const svg = readSvg(container?.querySelector("img"));
      return svg === styled ? svg : null;
    }, "the restyled code").catch(() => readSvg(container?.querySelector("img")));
    expect(redrawn, "LocalQr kept the code it drew for the previous style").toBe(styled);
  });

  it("does not look the style up for itself: a styled branding does not reach one handed none", async () => {
    brandingState.branding = withQrStyle(OPERATOR_RAW);
    mount(<LocalQr url={LINK} label="code" size={208} />);
    expect(await drawnCode("img", "the code")).toBe(await todaysCode(LINK));
  });
  it("holds the finished code's box while it is still drawing", async () => {
    // The placeholder and the plate must be the same box, built the same way:
    // the padding belongs to the wrapper in both. Sized `size` while the plate
    // is `size + 8`, the placeholder moved the caption — and everything below
    // it — by eight pixels the moment the code arrived.
    const box = (element: Element | null | undefined): string =>
      (element?.className ?? "")
        .split(/\s+/)
        .filter((name) => name.length > 0 && !name.startsWith("bg-"))
        .sort()
        .join(" ");

    mount(<LocalQr url={LINK} label="code" size={96} />);

    const placeholder = container?.querySelector("[aria-hidden]")?.parentElement ?? null;
    expect(placeholder, "nothing stands in for the code while it is being drawn").not.toBeNull();
    expect((placeholder?.firstElementChild as HTMLElement | null)?.style.width).toBe("96px");
    const whileDrawing = box(placeholder);

    await drawnCode("img", "the code");
    const plate = container?.querySelector("img")?.parentElement ?? null;
    expect(box(plate), "the placeholder and the plate are different boxes").toBe(whileDrawing);
  });
});

describe("the connect sheet", () => {
  it("stays plain when the operator styled their codes — VPN scanners read this one", async () => {
    brandingState.branding = withQrStyle(OPERATOR_RAW);
    mount(
      <ConnectLinkDialog
        url={SUBSCRIPTION}
        surface={{ raised: "", sunken: "" }}
        buttonClassName=""
        themeStyle={{}}
        onCopy={async () => true}
        onClose={() => undefined}
      />,
    );
    // Portalled to the body, not drawn into the container.
    const svg = await drawnCode('[data-testid="connect-link-dialog"] img', "the connect code", document.body);
    expect(svg).toBe(await todaysCode(SUBSCRIPTION));
  });
});

describe("the referral invite code", () => {
  async function openInviteCode(webLink: string = WEB_INVITE): Promise<string> {
    mount(<InviteLinkHero telegramLink={TELEGRAM_INVITE} webLink={webLink} brandName="Reiwa" />);
    const tile = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "QR",
    );
    expect(tile, "the QR tile").toBeDefined();
    await act(async () => {
      tile?.click();
    });
    return drawnCode('img[alt="QR Code"]', "the invite code");
  }

  it("is drawn in the operator's style — resolved, not raw — at the size the dialog shows it", async () => {
    brandingState.branding = withQrStyle(OPERATOR_RAW);
    const svg = await openInviteCode();
    expect(svg).toBe(await qrSvg(WEB_INVITE, OPERATOR_STYLE, 208));
    expect(svg).not.toBe(await todaysCode(WEB_INVITE));
  });

  it("is drawn for the dialog's 208 px, which decides whether dots survive on a dense link", async () => {
    // Long enough that 208 px leaves fewer pixels per module than dots need.
    // Both halves of that are checked first, so this case cannot pass by
    // choosing a link on which the size makes no difference.
    const dense = `https://cabinet.example.com/register?ref=${"a1b2c3d4e5".repeat(8)}`;
    expect(await qrSvg(dense, OPERATOR_STYLE), "precondition: without a size, dots stay").toContain("<circle");
    expect(await qrSvg(dense, OPERATOR_STYLE, 208), "precondition: at 208 px, they step down").not.toContain(
      "<circle",
    );

    brandingState.branding = withQrStyle(OPERATOR_RAW);
    expect(await openInviteCode(dense)).toBe(await qrSvg(dense, OPERATOR_STYLE, 208));
  });

  it("is today's plain code when the branding carries no qrStyle — a panel older than the setting", async () => {
    brandingState.branding = fromAnOldPanel();
    expect(await openInviteCode()).toBe(await todaysCode(WEB_INVITE));
  });

  it("is today's plain code when the panel spells the plain default out", async () => {
    // An operator who never touched the setting, on a panel that sends its
    // default explicitly — in the short hex form, which resolves the same.
    brandingState.branding = withQrStyle({ modules: "square", eyes: "square", dark: "#000" });
    expect(await openInviteCode()).toBe(await todaysCode(WEB_INVITE));
  });

  it.each(GARBAGE)("is a safe code for %s in the branding, and no error", async (_label, raw) => {
    brandingState.branding = withQrStyle(raw);
    const svg = await openInviteCode();
    expect(toastError).not.toHaveBeenCalled();
    expectSafe(svg);
    expect(svg).toBe(await todaysCode(WEB_INVITE));
  });
});

describe("the partner's advertising codes", () => {
  const PLACEMENT = {
    placementId: "placement-1",
    platform: "TELEGRAM",
    channel: "@channel",
    status: "ACTIVE",
    trackingCode: "abc123",
    payload: "ad_abc123",
    links: { botStart: BOT_AD, miniAppStart: null, miniAppWeb: WEB_AD },
    opens: 0,
    registrations: 0,
    conversions: 0,
    earnedMinor: 0,
  };

  async function drawAdvertisingCodes(): Promise<{ readonly bot: string; readonly web: string }> {
    api.getPartnerAdStats.mockResolvedValue({ placements: [PLACEMENT] });
    api.getPartnerAdRequests.mockResolvedValue({ requests: [] });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mount(
      <QueryClientProvider client={client}>
        <PartnerAdvertisingSection />
      </QueryClientProvider>,
    );
    return {
      bot: await drawnCode('img[alt="partnerAds.qrBot"]', "the bot code"),
      web: await drawnCode('img[alt="partnerAds.qrWeb"]', "the web code"),
    };
  }

  it("both carry the operator's style — resolved, not raw — at the 96 px they are shown at", async () => {
    brandingState.branding = withQrStyle(OPERATOR_RAW);
    const { bot, web } = await drawAdvertisingCodes();
    expect(bot).toBe(await qrSvg(BOT_AD, OPERATOR_STYLE, 96));
    expect(web).toBe(await qrSvg(WEB_AD, OPERATOR_STYLE, 96));
    expect(bot).not.toBe(await todaysCode(BOT_AD));
    expect(web).not.toBe(await todaysCode(WEB_AD));
  });

  it("are today's plain codes when the branding carries no qrStyle — a panel older than the setting", async () => {
    brandingState.branding = fromAnOldPanel();
    const { bot, web } = await drawAdvertisingCodes();
    expect(bot).toBe(await todaysCode(BOT_AD));
    expect(web).toBe(await todaysCode(WEB_AD));
  });

  it.each(GARBAGE)("are safe codes for %s in the branding", async (_label, raw) => {
    brandingState.branding = withQrStyle(raw);
    const { bot, web } = await drawAdvertisingCodes();
    expectSafe(bot);
    expectSafe(web);
    expect(bot).toBe(await todaysCode(BOT_AD));
    expect(web).toBe(await todaysCode(WEB_AD));
  });

  it("keeps both 96 px thumbnails byte for byte what they were — no logo, with one configured AND loaded", async () => {
    const src = freshLogoSrc();
    const fetch = serveLogo(src, "the logo");
    brandingState.branding = withQrStyle(withLogo(OPERATOR_RAW, src));
    const { bot, web } = await drawAdvertisingCodes();

    expect(bot).toBe(await qrSvg(BOT_AD, OPERATOR_STYLE, 96));
    expect(web).toBe(await qrSvg(WEB_AD, OPERATOR_STYLE, 96));
    expect(bot).not.toContain("<image");
    expect(web).not.toContain("<image");
    // Not vacuous: the logo WAS there to be had — the enlarging dialogs fetched it.
    expect(await loadQrLogo(src)).toBe(LOGO_HREF);
    expect(fetch).toHaveBeenCalledWith(src, expect.anything());
  });

  it("opens each code large, at 256 px — the same link, the operator's style, and the logo", async () => {
    const src = freshLogoSrc();
    serveLogo(src, "the logo");
    const raw = withLogo(OPERATOR_RAW, src);
    const style = resolveQrStyle(raw);
    expect(planQrLogo(BOT_AD, style, 256), "precondition: the bot link carries a logo at 256 px").not.toBeNull();
    expect(planQrLogo(WEB_AD, style, 256), "precondition: the web link carries a logo at 256 px").not.toBeNull();
    brandingState.branding = withQrStyle(raw);
    await drawAdvertisingCodes();

    for (const [kind, link] of [
      ["Bot", BOT_AD],
      ["Web", WEB_AD],
    ] as const) {
      const button = container?.querySelector(`button[aria-label="partnerAds.qrEnlarge${kind}"]`);
      expect(button, `the ${kind} thumbnail is not a button`).not.toBeNull();
      await act(async () => {
        (button as HTMLButtonElement).click();
      });
      const selector = `img[alt="partnerAds.qrDialog${kind}"]`;
      const svg = await settleFor(() => {
        const drawn = readSvg(container?.querySelector(selector));
        return drawn?.includes("<image") ? drawn : null;
      }, `the enlarged ${kind} code with its logo`);
      expect(svg).toBe(await qrSvg(link, style, 256, LOGO_HREF));
      expect(svg).toContain('<image href="data:image/svg+xml;base64,');
      expect(container?.querySelector(selector)?.getAttribute("width")).toBe("256");
      // The dialog names the link it opened.
      expect(container?.querySelector(selector)?.closest('[data-testid="dialog-content"]')?.textContent).toContain(link);
    }
  });

  it("opens large without a logo when none is configured — and fetches nothing", async () => {
    const fetch = serveLogo("/uploads/branding/none.svg", "the logo");
    brandingState.branding = withQrStyle(OPERATOR_RAW);
    await drawAdvertisingCodes();
    await act(async () => {
      (container?.querySelector('button[aria-label="partnerAds.qrEnlargeBot"]') as HTMLButtonElement).click();
    });
    const svg = await drawnCode('img[alt="partnerAds.qrDialogBot"]', "the enlarged bot code");
    expect(svg).toBe(await qrSvg(BOT_AD, OPERATOR_STYLE, 256));
    // At 256 px there is room for dots — the thumbnail's 96 px had not.
    expect(svg).toContain("<circle");
    expect(fetch).not.toHaveBeenCalled();
  });
});

/* ────────────────────────────────── the logo ───────────────────────────────── */

describe("the logo on the referral invite", () => {
  /** Mounts the invite and opens its dialog, without waiting for a code. */
  async function openInvite(): Promise<void> {
    mount(<InviteLinkHero telegramLink={TELEGRAM_INVITE} webLink={WEB_INVITE} brandName="Reiwa" />);
    const tile = [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "QR");
    expect(tile, "the QR tile").toBeDefined();
    await act(async () => {
      tile?.click();
    });
  }

  const inviteSvg = (): string | null => readSvg(container?.querySelector('img[alt="QR Code"]'));

  it("is in the invite's code once it has loaded — the operator's style, planned for 208 px, the image inlined", async () => {
    const src = freshLogoSrc();
    const fetch = serveLogo(src, "the logo");
    const raw = withLogo(OPERATOR_RAW, src);
    const style = resolveQrStyle(raw);
    expect(planQrLogo(WEB_INVITE, style, 208), "precondition: the invite link carries a logo at 208 px").not.toBeNull();
    brandingState.branding = withQrStyle(raw);

    await openInvite();
    const svg = await settleFor(() => {
      const drawn = inviteSvg();
      return drawn?.includes("<image") ? drawn : null;
    }, "the invite code with its logo");
    expect(svg).toBe(await qrSvg(WEB_INVITE, style, 208, LOGO_HREF));
    expect(svg).toContain('<image href="data:image/svg+xml;base64,');
    expect(fetch).toHaveBeenCalledWith(src, expect.anything());
  });

  it("shows the logo-less code while the logo is still loading — never an empty plate — then redraws with it", async () => {
    const src = freshLogoSrc();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = serveLogo(src, "the logo");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: unknown) => {
        await held;
        return served(input, init);
      }),
    );
    const raw = withLogo(OPERATOR_RAW, src);
    const style = resolveQrStyle(raw);
    brandingState.branding = withQrStyle(raw);

    await openInvite();
    const whileLoading = await settleFor(inviteSvg, "the invite code while its logo loads");
    expect(whileLoading).toBe(await qrSvg(WEB_INVITE, style, 208));
    expect(whileLoading).not.toContain("<image");

    release();
    const loaded = await settleFor(() => {
      const drawn = inviteSvg();
      return drawn?.includes("<image") ? drawn : null;
    }, "the invite code redrawn with its logo");
    expect(loaded).toBe(await qrSvg(WEB_INVITE, style, 208, LOGO_HREF));
  });

  it.each(["a redirect to the stock icon", "a 404", "a network failure"] as const)(
    "is the logo-less code when the upload answers with %s",
    async (served) => {
      const src = freshLogoSrc();
      const fetch = serveLogo(src, served);
      const raw = withLogo(OPERATOR_RAW, src);
      const style = resolveQrStyle(raw);
      brandingState.branding = withQrStyle(raw);

      await openInvite();
      // The very load the invite started — the loader shares it — has failed…
      expect(await loadQrLogo(src)).toBeNull();
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      // …and the dialog shows the code without a logo: no broken image, no blank.
      const svg = await settleFor(inviteSvg, "the invite code");
      expect(svg).toBe(await qrSvg(WEB_INVITE, style, 208));
      expect(svg).not.toContain("<image");
      expect(fetch, "the invite never tried to load the logo — this case guards nothing").toHaveBeenCalledWith(
        src,
        expect.anything(),
      );
    },
  );

  it("is today's styled code, and fetches nothing, from a panel older than the logo — no `logo` key", async () => {
    const fetch = serveLogo("/uploads/branding/unused.svg", "the logo");
    expect(Object.hasOwn(OPERATOR_RAW, "logo"), "precondition: the payload has no logo key").toBe(false);
    brandingState.branding = withQrStyle(OPERATOR_RAW);

    await openInvite();
    const svg = await settleFor(inviteSvg, "the invite code");
    expect(svg).toBe(await qrSvg(WEB_INVITE, OPERATOR_STYLE, 208));
    expect(svg).not.toContain("<image");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the logo and the connect sheet", () => {
  it("never reaches the connect code — configured, loadable, room for it, and the code stays plain", async () => {
    // A SHORT subscription link, on purpose: the long one is too dense for any
    // logo at 208 px, so a sheet that did pass one on would still draw none and
    // this case would guard nothing. On this one a logo fits.
    const shortSubscription = "https://sub.example.com/api/sub/9f2c1e7a4d8b4b2f9c31";
    const src = freshLogoSrc();
    serveLogo(src, "the logo");
    expect(
      planQrLogo(shortSubscription, resolveQrStyle(withLogo(OPERATOR_RAW, src)), 208),
      "precondition: a logo would fit this code at the sheet's size",
    ).not.toBeNull();
    brandingState.branding = withQrStyle(withLogo(OPERATOR_RAW, src));
    mount(
      <ConnectLinkDialog
        url={shortSubscription}
        surface={{ raised: "", sunken: "" }}
        buttonClassName=""
        themeStyle={{}}
        onCopy={async () => true}
        onClose={() => undefined}
      />,
    );
    const svg = await drawnCode('[data-testid="connect-link-dialog"] img', "the connect code", document.body);
    expect(svg).toBe(await todaysCode(shortSubscription));
    expect(svg).not.toContain("<image");
    // Not vacuous: the logo loads for anyone who asks — the sheet does not ask.
    expect(await loadQrLogo(src)).toBe(LOGO_HREF);
  });
});
