// @vitest-environment jsdom

/**
 * THE BOTTOM NAVIGATION IS A FLOATING PILL, NOT A FOOTER ROW.
 *
 * The cabinet shell (`.app-shell`) is a flex COLUMN. While the navigation was
 * an in-flow `shrink-0` child of it, it cut itself a full-width row out of the
 * shell no matter how narrow the pill inside it was — the scroller stopped
 * above that row, so the last ~78 px of the screen were bare app background
 * from edge to edge with the `w-fit` capsule floating in the middle of it. That
 * band is what an operator reads as a "footer around the navbar", and no file
 * paints it: it is reserved space, so removing paint (which
 * `app-background-contrast.ts` already did for the veil's bottom ramp) could
 * never remove it.
 *
 * The fix takes the navigation out of flow and gives the SCROLLER the room back
 * as bottom padding, so content keeps running underneath the pill and still
 * scrolls clear of it. Three things have to hold together for that, and this
 * file pins all three:
 *
 *   1. The room reserved at the foot of the scroller is at least the height the
 *      pill actually occupies. Both numbers are read back off the rendered DOM
 *      here — not imported from the module that computes them — so the day the
 *      pill grows and the inset does not, this reds instead of silently hiding
 *      the last card behind the capsule.
 *   2. The shell reserves NOTHING beside the pill: the navigation's own slot is
 *      out of flow, click-through, and paints nothing of its own.
 *   3. The onboarding spotlight rings the PILL. It measures
 *      `[data-tour="bottom-nav"]` with `getBoundingClientRect()`
 *      (`spotlight-overlay.tsx`), so an attribute left on the full-width slot
 *      would ring the whole width of the screen.
 *
 * WHY THE `MIN_TAP_TARGET_PX` FLOOR IS LOAD-BEARING. "Reserved room >= pill
 * height" is satisfied by 0 >= 0, which is exactly the shape the pre-fix code
 * has: no inset at all, and a pill whose box is declared nowhere this test can
 * read. The floor is what makes the pair fail closed — delete it and this file
 * joins the repo's collection of green tests that guard nothing.
 *
 * The placement rules come out of the SHIPPED `web/src/index.css` and are
 * injected into the document, so `position` / `pointer-events` below are
 * resolved by the real cascade over the real declarations rather than by
 * matching class names. jsdom carries no Tailwind, which is also why the pill's
 * geometry is declared through `bottom-nav-metrics.ts` as element styles: one
 * module is the source of both the capsule's size and the scroller's inset,
 * and that coupling is what this file exists to keep honest.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { act, type ReactNode, type SVGProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Branding } from "../src/types/branding";

const brandingState = vi.hoisted(() => ({ branding: {} as Partial<Branding> }));

const Icon = (_props: SVGProps<SVGSVGElement>) => <svg />;
const tabs = [
  { to: "/dashboard", icon: Icon, label: "Подписки", testId: "tab-dashboard", matchPrefix: ["/dashboard"] },
  { to: "/referral", icon: Icon, label: "Рефералы", testId: "tab-referral", matchPrefix: ["/referral"] },
  { to: "/settings", icon: Icon, label: "Настройки", testId: "tab-settings", matchPrefix: ["/settings"] },
];

vi.mock("@/lib/api-client", () => ({
  reportSurface: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
vi.mock("@/lib/push", () => ({ ensurePushSubscription: vi.fn() }));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => ({
    session: { userId: "u1", telegramId: "42", webAccount: { login: "u1" } },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-user-realtime", () => ({ useUserRealtime: () => undefined }));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/hooks/use-install-prompt", () => ({ isStandalonePwa: () => false }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: brandingState.branding }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { requireTelegramWebCredentials: false } }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("react-router", () => ({
  Navigate: ({ to }: { readonly to: string }) => <span data-redirect={to} />,
  NavLink: ({
    to,
    children,
    ...rest
  }: { readonly to: string; readonly children?: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="route-content" />,
  useLocation: () => ({ pathname: "/dashboard", search: "" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("motion/react", () => ({
  domMax: {},
  LazyMotion: ({ children }: { readonly children?: ReactNode }) => <>{children}</>,
  m: {
    span: ({ layoutId: _layoutId, transition: _transition, ...props }: Record<string, unknown>) => (
      <span {...props} />
    ),
  },
}));
vi.mock("@/components/layout/use-nav-tabs", () => ({
  useNavTabs: () => tabs,
  resolveActiveTabTo: () => "/dashboard",
}));
vi.mock("@/components/layout/side-nav", () => ({ SideNav: () => null }));
// `page-transition` is deliberately NOT mocked. It is the `h-full` box every
// page is laid out in, and that fixed height is exactly what stops the
// scroller from putting its bottom padding after a long page. Stub it out and
// the tree below is no longer the tree that ships, which is the whole subject
// of the room assertion.
vi.mock("@/components/layout/route-content-boundary", () => ({
  RouteContentBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  OnboardingTourProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => <div data-testid="network-bg" /> }));
vi.mock("@/components/layout/app-background", () => ({ AppBackground: () => null }));

import StealthLayout from "@/components/layout/stealth-layout";
import { DEFAULT_BRANDING } from "@/types/branding";

/**
 * Apple HIG's minimum comfortable touch target. Nothing in the product may be a
 * smaller tap area, so it is a safe lower bound for "the pill declares a real
 * box" — and, unlike the design's own 52 px, it is not a copy of a number under
 * test.
 */
const MIN_TAP_TARGET_PX = 44;

// jsdom replaces the global `URL`, so a `new URL(…, import.meta.url)` handed to
// `node:fs` is rejected here — the neighbouring jsdom specs go through
// `fileURLToPath` for the same reason.
const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_STYLESHEET = readFileSync(join(HERE, "..", "src", "index.css"), "utf8");

/** The shipped declarations for one selector, verbatim, or a failure naming it. */
function shippedRule(selector: string): string {
  const at = SHELL_STYLESHEET.indexOf(`\n${selector} {`);
  if (at === -1) {
    throw new Error(`web/src/index.css declares no \`${selector}\` rule`);
  }
  const end = SHELL_STYLESHEET.indexOf("}", at);
  return SHELL_STYLESHEET.slice(at + 1, end + 1);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountCabinet(): void {
  document.head.innerHTML = `<style>${shippedRule(".bottom-nav-floating")}${shippedRule(
    ".bottom-nav-floating .bottom-nav-pill",
  )}</style>`;
  brandingState.branding = { ...DEFAULT_BRANDING };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<StealthLayout />);
  });
}

/** A length in px, or 0 for every keyword / absent value jsdom can answer with. */
function readPx(el: Element, property: string): number {
  const raw = window.getComputedStyle(el).getPropertyValue(property).trim();
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw);
  return match ? Number.parseFloat(match[1]!) : 0;
}

interface PillBox {
  /** The capsule's own border box. */
  readonly height: number;
  /** How far the capsule is held off the bottom edge of the shell. */
  readonly liftOffFloor: number;
  /** Everything the pill takes out of the bottom of the screen. */
  readonly occupied: number;
}

function primaryNav(): HTMLElement {
  const nav = document.querySelector<HTMLElement>('nav[aria-label="Primary"]');
  if (!nav) throw new Error("the cabinet shell rendered no primary navigation");
  return nav;
}

function pillBox(): PillBox {
  const nav = primaryNav();
  const capsule = nav.firstElementChild;
  const item = nav.querySelector("a[data-testid]");
  if (!capsule || !item) throw new Error("the navigation rendered no capsule / destination");
  const height =
    readPx(item, "min-height") +
    readPx(capsule, "padding-top") +
    readPx(capsule, "padding-bottom") +
    readPx(capsule, "border-top-width") +
    readPx(capsule, "border-bottom-width");
  const liftOffFloor = readPx(capsule, "margin-bottom");
  return { height, liftOffFloor, occupied: height + liftOffFloor };
}

/** One declared length with every run of whitespace flattened, for comparison. */
function declaredLength(style: CSSStyleDeclaration, property: string): string {
  return style.getPropertyValue(property).trim().replace(/\s+/g, "");
}

/** The room the scroller keeps below its content, as declared and as px. */
function scrollerInset(): { readonly raw: string; readonly px: number } {
  const main = document.querySelector("main");
  if (!main) throw new Error("the cabinet shell rendered no scrollable main");
  const raw = window.getComputedStyle(main).getPropertyValue("padding-bottom").trim();
  const flat = /^(-?\d+(?:\.\d+)?)px$/.exec(raw);
  // jsdom rewrites `env()` inside a calc but leaves the leading term intact.
  const summed = /^calc\(\s*(-?\d+(?:\.\d+)?)px/.exec(raw);
  const matched = flat ?? summed;
  return { raw, px: matched ? Number.parseFloat(matched[1]!) : 0 };
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  document.head.innerHTML = "";
  root = null;
  container = null;
});

describe("floating bottom navigation", () => {
  it("reserves the pill's own height at the foot of the scroller", () => {
    mountCabinet();

    const pill = pillBox();
    const inset = scrollerInset();

    // Fail closed: without these two the assertion below is satisfied by 0 >= 0.
    expect(pill.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(pill.liftOffFloor).toBeGreaterThan(0);

    expect(inset.px).toBeGreaterThanOrEqual(pill.occupied);
    // The pill sits above the home indicator, so the room must clear that too.
    expect(inset.raw).toContain("safe-area-inset-bottom");

    // The scrollport now runs UNDER the capsule, so the browser would align a
    // focused field with its bottom edge and hand it to the pill. The same
    // length has to be declared as the scrollport's own inset for that.
    const main = document.querySelector("main")!;
    expect(declaredLength(window.getComputedStyle(main), "scroll-padding-bottom")).toBe(
      declaredLength(window.getComputedStyle(main), "padding-bottom"),
    );
  });

  /**
   * THE SCROLLER'S PADDING IS ONLY HALF THE RESERVATION.
   *
   * A scroll container applies its bottom padding after its own CONTENT box.
   * `<PageTransition>` is `h-full` — a FIXED height — so every page taller than
   * the screen overflows it, and the padding lands at the fold instead of after
   * the page. Measured in Chrome on this box tree: the last card of a long page
   * came to rest 40px above the floor while the capsule occupies 78 plus the
   * home indicator, which parks the last row of /settings, /plans and the
   * devices list — their buttons with them — under the glass with no scroll
   * left to reach it. The row layout this replaced could not fail that way: the
   * scroller simply ended above the navigation.
   *
   * Only a box in the PAGE's own flow follows that overflow. This pins that it
   * exists, that it sits after the route content INSIDE that fixed-height box
   * (in `<main>` it would land at the fold again, which is the defect), and
   * that it is the same length the scroller reserved — one pill, one number.
   */
  it("takes that room again inside the page's own flow, where a long page reaches it", () => {
    mountCabinet();

    const main = document.querySelector("main");
    if (!main) throw new Error("the cabinet shell rendered no scrollable main");
    const pageBox = main.firstElementChild;
    const route = document.querySelector('[data-testid="route-content"]');
    if (!pageBox || !route) throw new Error("the shell rendered no page box / route content");

    const room = pageBox.lastElementChild;
    expect(
      room,
      "the route content is the last thing in the page box: on every page longer than the screen the scroller's padding lands at the fold and the last rows stay under the capsule",
    ).not.toBe(route);
    expect(
      room?.parentElement,
      "the room is not inside the box the page overflows, so the overflow runs straight past it",
    ).toBe(pageBox);
    expect(route.compareDocumentPosition(room!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // jsdom re-serialises `env()` with its own spacing, and it does so
    // differently for `height` than for `padding-bottom`, so the two
    // declarations are compared as lengths rather than as strings.
    expect(declaredLength(window.getComputedStyle(room!), "height")).toBe(
      declaredLength(window.getComputedStyle(main), "padding-bottom"),
    );
  });

  it("hangs the navigation over the content instead of reserving a row beside it", () => {
    mountCabinet();

    const slot = primaryNav().parentElement;
    if (!slot) throw new Error("the navigation is not mounted inside the shell");
    const slotStyle = window.getComputedStyle(slot);

    expect(slotStyle.position).toBe("absolute");
    // A full-width slot on top of the scroller would swallow every scroll
    // gesture and tap that lands beside the pill.
    expect(slotStyle.pointerEvents).toBe("none");
    expect(window.getComputedStyle(primaryNav().firstElementChild!).pointerEvents).toBe("auto");
  });

  it("paints nothing of its own around the pill", () => {
    mountCabinet();

    const nav = primaryNav();
    const slot = nav.parentElement!;
    const paint = /\b(bg-|backdrop-|shadow-|from-|via-|to-)/;

    for (const el of [slot, nav]) {
      expect(el.className).not.toMatch(paint);
      expect(el.getAttribute("style") ?? "").not.toMatch(/background|box-shadow|backdrop-filter/);
    }
    expect(shippedRule(".bottom-nav-floating")).not.toMatch(
      /background|box-shadow|backdrop-filter|border-/,
    );
  });

  it("hands the onboarding spotlight the pill, not the width of the screen", () => {
    mountCabinet();

    const ringed = document.querySelectorAll('[data-tour="bottom-nav"]');

    expect(ringed).toHaveLength(1);
    expect(ringed[0]).toBe(primaryNav().firstElementChild);
  });
});
