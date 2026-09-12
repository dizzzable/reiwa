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
}));
// Rendered in place instead of portalled, so the invite code is found where it
// was drawn. What is under test happens before the dialog opens.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
    open ? <div data-testid="invite-qr-dialog">{children}</div> : null,
  DialogContent: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children?: ReactNode }) => <h2>{children}</h2>,
}));

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
});
