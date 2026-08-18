// @vitest-environment jsdom

/**
 * A ROUTE RENDERED OUTSIDE THE CABINET SHELL MUST BRING ITS OWN SCROLLER.
 *
 * `web/src/index.css` gives the mount point `height: 100dvh; overflow: hidden`
 * (the `html, body, #root` rule). That is not a stylistic choice — it is what
 * stops the whole Mini App from rubber-banding on iOS — and it means the shell
 * root CLIPS. Inside `StealthLayout` that is harmless, because the shell hands
 * the page a `<main class="scroll-area">` of its own. The fifteen routes in
 * `App.tsx` that render OUTSIDE the shell get no such thing: whatever they draw
 * below the first screen is not merely off-screen, it is unreachable. There is
 * no scrollbar, no touch scroll, no keyboard scroll — the content is simply
 * gone.
 *
 * `/legal` is the worst case in the set. It renders the operator's agreement
 * and offer as `whitespace-pre-wrap` bodies of arbitrary length, and it is
 * linked from the sign-up form and from the bot — so the documents a subscriber
 * is asked to accept were, in the literal sense, impossible to finish reading.
 * `/support/guest` is the same defect over a captcha'd form and a ticket
 * thread. Both are old and neither has anything to do with the bottom
 * navigation.
 *
 * An audit of all fourteen out-of-shell components found five that could be
 * cut off. `/onboarding`, `/payment-return` and `/tma` are the other three,
 * and each has a case below. They are not identical to the first two:
 * `/onboarding` had no `overflow-y` at all, while the last two were BOUNDED
 * but SEALED (`h-dvh` + `overflow-hidden`), which is the worse shape — a
 * sealed box hides the defect from any test that only asks "is the height
 * bounded".
 *
 * WHAT THIS FILE CANNOT SEE, so that nobody trusts it for more than it says.
 * `/payment-return` and `/tma` are centred splashes, and a centred flex
 * container that overflows overflows at BOTH ends while only the end-edge
 * overflow joins the scrollable region — so bolting `scroll-area` onto the
 * old centred root would have left the top of the card stranded above the
 * scroll origin, where nothing reaches it. Both pages therefore moved the
 * centring into an inner `min-h-full justify-center` column, the shape the
 * six entry screens use. The cascade here CANNOT check that half: the
 * stylesheet injected below is the authored `index.css`, and `min-h-full`,
 * `flex` and `justify-center` are Tailwind-generated utilities that are not
 * in it. The wrong fix would pass every assertion in this file. It was ruled
 * out by measurement in Chrome instead (375x360, `/tma` with a long [dev]
 * message: scroll range 83px and the brand tile frozen at -83px with the
 * wrong shape, 230px and both ends reachable with the right one).
 *
 * WHY THIS FILE ASSERTS SHAPE AND NOT A MEASUREMENT. jsdom has no layout
 * engine: `scrollHeight`, `clientHeight` and every rect are 0 here, so "is the
 * last line reachable" cannot be measured, and a test that pretended to measure
 * it would only be asserting zeroes. What CAN be established without layout is
 * the shape that makes the answer yes, and the whole shipped `index.css` is
 * injected so the cascade — not a class-name string — is what answers:
 *
 *   1. the page's outermost box scrolls in the block axis, and
 *   2. that same box's block size is BOUNDED.
 *
 * Both, and separately. Either one alone is satisfied by a page that is still
 * broken: `overflow-y: auto` on a box that sizes to its content never scrolls
 * (it just grows past the clipping root and is cut off), and a bounded box that
 * does not scroll is the defect itself. That pairing is what stops this file
 * from joining the repo's collection of green tests that guard nothing, and it
 * is proved by mutation — dropping `h-dvh` while keeping `scroll-area` reds
 * this file, as does dropping `scroll-area` while keeping `h-dvh`.
 *
 * The premise is asserted too (`describe` block one). If `#root` ever stops
 * clipping, these pages stop needing a scroller and this file's reasoning is
 * void — better that it says so out loud than that it keeps passing for a
 * reason that has expired.
 *
 * Note on the stylesheet: this reads `web/src/index.css`, the authored file,
 * because `#root`, `.scroll-area` and `.h-dvh` are all hand-written rules in it
 * that the build copies through untouched. Tailwind's generated utilities
 * (`pb-10`, `px-4`, `min-h-full`, …) are NOT visible here, which is deliberate:
 * it keeps the assertions on the two properties that decide reachability and
 * off the decorative ones. It is also the reason for the blind spot named
 * above — the price of not running a Tailwind build inside a unit test.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Doubles ──────────────────────────────────────────────────────────────────
// Only the data and icon layers are stubbed. The page components themselves —
// the thing under test — are the real ones, and so is every element they
// render, because the element this file inspects is the one they actually ship.

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));

vi.mock("lucide-react", () => ({
  ArrowLeft: () => <svg />,
  ArrowRight: () => <svg />,
  Check: () => <svg />,
  Copy: () => <svg />,
  ExternalLink: () => <svg />,
  Gift: () => <svg />,
  Loader2: () => <svg />,
  Paperclip: () => <svg />,
  Send: () => <svg />,
  Shield: () => <svg />,
  Users: () => <svg />,
  X: () => <svg />,
  Zap: () => <svg />,
}));

// `motion/react`. Every one of the three screens added below draws its content
// through `motion.*`, and the animation props are not DOM attributes — passing
// them through would make React warn on every element. The stub keeps the tag
// and the props that decide layout, which is all this file reads.
vi.mock("motion/react", () => {
  const LAYOUT_PROPS = new Set(["className", "style", "id", "role"]);
  const host = (tag: string) =>
    function MotionStub(props: Record<string, unknown>) {
      const forwarded: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(props)) {
        if (name === "children") continue;
        if (LAYOUT_PROPS.has(name) || name.startsWith("aria-") || name.startsWith("data-")) {
          forwarded[name] = value;
        }
      }
      return createElement(tag, forwarded, (props as { children?: ReactNode }).children);
    };
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: new Proxy({} as Record<string, unknown>, {
      get: (_target, tag) => (typeof tag === "string" ? host(tag) : undefined),
    }),
  };
});

// One `navigate` for the process, not one per render: `/payment-return` and
// `/tma` both list it in an effect dependency array, and a fresh function each
// render would re-run those effects forever.
vi.mock("react-router", () => {
  const navigate = vi.fn();
  const setSearchParams = vi.fn();
  return {
    useNavigate: () => navigate,
    useSearchParams: () => [new URLSearchParams("paymentId=probe"), setSearchParams],
  };
});

// `/legal`
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button" />,
}));
vi.mock("@/lib/use-legal-documents", () => ({
  useLegalDocuments: () => ({
    documents: [
      { key: "offer", title: "Публичная оферта", body: "…" },
      { key: "privacy", title: "Политика конфиденциальности", body: "…" },
    ],
    isLoading: false,
    failed: false,
    retry: () => undefined,
  }),
}));

// `/support/guest`
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@tanstack/react-query", () => {
  // One client object for the process, for the same reason as `navigate`
  // above: `/tma` and `/payment-return` both depend on it from an effect.
  const queryClient = {
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(async () => undefined),
    fetchQuery: vi.fn(async () => null),
  };
  return {
    useQuery: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useQueryClient: () => queryClient,
  };
});
vi.mock("@/lib/api-client", () => ({
  createGuestTicket: vi.fn(),
  getGuestConversation: vi.fn(),
  replyGuestConversation: vi.fn(),
  closeGuestConversation: vi.fn(),
  getGuestSupportConfig: vi.fn(),
  supportGuestAttachmentUrl: vi.fn(),
  // `/payment-return`: answering FAILED on the first poll is what puts the
  // page on the branch this file is about — the one with the button stack.
  getPaymentStatus: vi.fn(async () => ({ paymentId: "probe", status: "FAILED" })),
  abandonCheckout: vi.fn(),
  // `/tma`
  bootstrapTelegram: vi.fn(),
}));

// `/onboarding`, `/tma`
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  fetchSessionOrNull: vi.fn(async () => null),
  useSession: () => ({ session: null, isLoading: false }),
}));

// `/tma`: `isReady` with no `initData` is the launch that has nothing to
// authenticate with, which is what lands the page on its error branch.
vi.mock("@/hooks/use-telegram-webapp", () => ({
  useTelegramWebApp: () => ({ initData: null, isReady: true, telegram: null }),
}));

// `/payment-return`, `/tma`
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({
    branding: { brandName: "Reiwa", tagline: "", primary: "#22c55e" },
  }),
}));
vi.mock("@/components/ui/entry-brand-tile", () => ({
  EntryBrandTile: () => <div />,
}));

import LegalPage from "@/features/legal/legal-page";
import GuestSupportPage from "@/features/support/guest-support-page";
import OnboardingPage from "@/features/onboarding/onboarding-page";
import PaymentReturnPage from "@/features/payment/payment-return-page";
import TmaBootstrapPage from "@/features/auth/tma-bootstrap-page";

// jsdom replaces the global `URL`, so a `new URL(…, import.meta.url)` handed to
// `node:fs` is rejected here — the neighbouring jsdom specs go through
// `fileURLToPath` for the same reason.
const HERE = dirname(fileURLToPath(import.meta.url));

// React 19 refuses to treat `act()` as a real act scope without this, and warns
// on every render that the environment is not configured for it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The shipped stylesheet, minus its `@import` lines.
 *
 * The imports are Tailwind and the font faces; jsdom cannot resolve either and
 * would print a "Could not parse CSS @import URL" line for each one. Nothing
 * below depends on them — `#root`, `.scroll-area` and `.h-dvh` are all authored
 * directly in this file.
 */
const SHELL_STYLESHEET = readFileSync(join(HERE, "..", "src", "index.css"), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("@import"))
  .join("\n");

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Render a route the way `main.tsx` does: into the real `#root`, under the real cascade. */
function renderOutsideShell(element: ReactNode): HTMLElement {
  document.head.innerHTML = `<style>${SHELL_STYLESHEET}</style>`;
  host = document.createElement("div");
  // The id is the point: `html, body, #root { overflow: hidden }` only applies
  // to an element that really is the mount point.
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(element);
  });
  const rendered = host.firstElementChild;
  if (!(rendered instanceof window.HTMLElement)) {
    throw new Error("the route rendered no element at all");
  }
  return rendered;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  document.head.innerHTML = "";
});

/**
 * Let the mount effects resolve.
 *
 * `/payment-return` and `/tma` both decide what to draw from an async effect
 * (a status poll, a session probe). Without this they would be asserted on
 * their first-paint spinner instead of on the branch that is actually tall —
 * the button stack and the retry screen. The outermost box is the same element
 * either way, so this changes no assertion; it makes the failure message tell
 * the truth about what was on screen.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const SCROLLS = /(^|\s)(auto|scroll|overlay)(\s|$)/;
const CLIPS = /(^|\s)(hidden|clip)(\s|$)/;

interface BlockAxis {
  /** Does this box scroll its own overflow in the block axis? */
  readonly scrolls: boolean;
  /** Is its block size bounded, rather than growing with its content? */
  readonly bounded: boolean;
  /** Does it cut its overflow off with no way to reach it? */
  readonly clips: boolean;
  /** Verbatim resolved values, for the failure message. */
  readonly resolved: string;
}

/**
 * Resolve the two properties that decide reachability through the real cascade.
 *
 * Both the shorthand and the longhand are read: jsdom's CSSOM does not expand
 * `overflow: hidden` into `overflow-y`, and `index.css` writes the shell root
 * with the shorthand and `.scroll-area` with the longhand.
 */
function blockAxis(el: Element): BlockAxis {
  const style = window.getComputedStyle(el);
  const overflow = style.getPropertyValue("overflow").trim();
  const overflowY = style.getPropertyValue("overflow-y").trim();
  const height = style.getPropertyValue("height").trim();
  const maxHeight = style.getPropertyValue("max-height").trim();
  const bounds = [height, maxHeight].filter((v) => v !== "" && v !== "auto" && v !== "none");
  return {
    scrolls: SCROLLS.test(overflowY) || SCROLLS.test(overflow),
    bounded: bounds.length > 0,
    clips: CLIPS.test(overflowY) || CLIPS.test(overflow),
    resolved:
      `overflow:${overflow || "—"} overflow-y:${overflowY || "—"} ` +
      `height:${height || "—"} max-height:${maxHeight || "—"}`,
  };
}

describe("the shell root clips — the premise every case below rests on", () => {
  it("gives #root a viewport-bounded height and hides its overflow", () => {
    renderOutsideShell(<span />);
    const shellRoot = document.getElementById("root");
    if (shellRoot === null) throw new Error("no #root");
    const box = blockAxis(shellRoot);
    expect(
      { clipsItsOverflow: box.clips, blockSizeBounded: box.bounded },
      "web/src/index.css no longer clips #root. If that is intended, the pages " +
        "below no longer need a scroller of their own and this file's reasoning " +
        "has expired — do not just delete the assertion.",
    ).toEqual({ clipsItsOverflow: true, blockSizeBounded: true });
  });
});

describe("a route outside StealthLayout owns its scroller", () => {
  it("/legal can be read to the end", () => {
    const page = renderOutsideShell(<LegalPage />);
    const box = blockAxis(page);
    expect(
      { blockAxisScrolling: box.scrolls, blockSizeBounded: box.bounded },
      "/legal renders outside the shell, so #root — which clips — is its only " +
        `container. Its outermost box resolved to { ${box.resolved} }, which ` +
        "cannot scroll: everything past the first screen of the operator's " +
        "agreement and offer is unreachable.",
    ).toEqual({ blockAxisScrolling: true, blockSizeBounded: true });
  });

  it("/support/guest can be filled in and read to the end", () => {
    const page = renderOutsideShell(<GuestSupportPage />);
    const box = blockAxis(page);
    expect(
      { blockAxisScrolling: box.scrolls, blockSizeBounded: box.bounded },
      "/support/guest renders outside the shell, so #root — which clips — is " +
        `its only container. Its outermost box resolved to { ${box.resolved} }, ` +
        "which cannot scroll: the submit button below the captcha, and the foot " +
        "of a ticket thread, are unreachable.",
    ).toEqual({ blockAxisScrolling: true, blockSizeBounded: true });
  });

  it("/onboarding can be finished on a short viewport", () => {
    const page = renderOutsideShell(<OnboardingPage />);
    const box = blockAxis(page);
    expect(
      { blockAxisScrolling: box.scrolls, blockSizeBounded: box.bounded },
      "/onboarding renders outside the shell, so #root — which clips — is its " +
        `only container. Its outermost box resolved to { ${box.resolved} }, ` +
        "which cannot scroll: the step dots and the «next / start» button are " +
        "the last 130px of the page, and a short viewport puts them past the " +
        "cut with nothing to reach them — measured in Chrome at 375x360, the " +
        "three bands come to 420px against a 360px clip and the CTA ended 12px " +
        "below the fold. Note the two ways to fail this: `min-height` alone is " +
        "NOT bounded here, because a box that grows with its content simply " +
        "grows past the clip.",
    ).toEqual({ blockAxisScrolling: true, blockSizeBounded: true });
  });

  it("/payment-return keeps the whole failure card reachable", async () => {
    const page = renderOutsideShell(<PaymentReturnPage />);
    await settle();
    const box = blockAxis(page);
    expect(
      { blockAxisScrolling: box.scrolls, blockSizeBounded: box.bounded },
      "/payment-return renders outside the shell, so #root — which clips — is " +
        `its only container. Its outermost box resolved to { ${box.resolved} }, ` +
        "which cannot scroll: the failed/timeout branch stacks a 96px icon, a " +
        "title, a hint and up to four full-width buttons — «open payment», " +
        "«retry», «abandon», «back to dashboard» — and a buyer whose payment " +
        "just failed could not reach the bottom of that stack. Measured in " +
        "Chrome at 375x360: card 384px, top edge at -12px, last button 12px " +
        "below the fold, scroll range 0.",
    ).toEqual({ blockAxisScrolling: true, blockSizeBounded: true });
  });

  it("/tma keeps a long bootstrap error reachable", async () => {
    const page = renderOutsideShell(<TmaBootstrapPage />);
    await settle();
    const box = blockAxis(page);
    expect(
      { blockAxisScrolling: box.scrolls, blockSizeBounded: box.bounded },
      "/tma renders outside the shell, so #root — which clips — is its only " +
        `container. Its outermost box resolved to { ${box.resolved} }, which ` +
        "cannot scroll: the error branch carries a `whitespace-pre-line` " +
        "message the BFF may extend with a multi-line [dev] block (up to 500 " +
        "characters of upstream body) and the retry button under it. Measured " +
        "in Chrome with such a message the column is 526px, so at 375x360 it " +
        "began at -83px and the retry button ended 66px below the fold, with a " +
        "scroll range of 0.",
    ).toEqual({ blockAxisScrolling: true, blockSizeBounded: true });
  });
});
