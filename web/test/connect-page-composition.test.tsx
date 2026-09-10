// @vitest-environment jsdom

/**
 * THE SCREEN IS THE CONCEPT BOOK'S ARRANGEMENT, NOT A STACK OF CARDS.
 *
 * The first version of this screen put every step in its own bordered card, the
 * apps in a horizontal scroller, and nothing that said which subscription was
 * being installed. The operator's report was simply that it "looks nothing like
 * the concepts" — and it did not: all 104 concepts in `subscription.pen` share
 * one arrangement, and that arrangement is the opposite of a stack of cards.
 *
 * These are structural properties, not pixels. A test cannot see that the
 * spacing is right, and pretending otherwise with a snapshot would only lock in
 * whatever was rendered the day it was written. What it CAN see is the shape
 * the concepts are actually made of, and each of these is a thing that was
 * wrong before:
 *
 *   - the steps live in ONE container, separated by rules, not in N containers;
 *   - the apps are a grid, so all of them are visible without scrolling;
 *   - the steps are numbered, because doing them out of order does not work;
 *   - the screen names the subscription it is about;
 *   - a concept paints ONE element, so it cannot follow the customer back out
 *     into a cabinet wearing a different one;
 *   - the link still works when the catalog does not.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The smallest app the catalog reader will actually keep. */
function koalaLike(id: string, name: string) {
  return {
    id,
    name,
    iconKey: null,
    featured: false,
    steps: [
      {
        title: { ru: "Добавьте подписку" },
        body: null,
        iconKey: null,
        buttons: [{ kind: "copyLink", label: { ru: "Скопировать" } }],
      },
    ],
  };
}

const CATALOG = {
  platforms: [
    {
      id: "windows",
      title: { ru: "Windows", en: "Windows" },
      apps: [
        {
          id: "flclashx",
          name: "FlClashX",
          iconKey: "flclashx",
          featured: true,
          steps: [
            {
              title: { ru: "Установка приложения" },
              body: { ru: "Скачайте версию для своего устройства." },
              iconKey: "download",
              buttons: [{ kind: "external", label: { ru: "Windows · x64" }, url: "https://e.test/x64" }],
            },
            {
              title: { ru: "Добавление подписки" },
              body: { ru: "Нажмите кнопку ниже." },
              iconKey: null,
              buttons: [
                { kind: "deepLink", label: { ru: "Добавить" }, template: "happ://add/{{SUBSCRIPTION_LINK}}", encode: "raw" },
              ],
            },
            { title: { ru: "Если не добавилась" }, body: null, iconKey: null, buttons: [] },
            { title: { ru: "Подключение" }, body: null, iconKey: null, buttons: [] },
          ],
        },
        // Real apps, not stubs: `connect-catalog` drops an app whose steps
        // cannot hand the subscription over, so an app with `steps: []` never
        // reaches the grid at all — which is what an earlier draft of this
        // fixture got wrong, and what made the grid look absent when it was
        // simply down to one app.
        koalaLike("koala", "Koala"),
        koalaLike("prizrak", "Prizrak"),
        koalaLike("happ", "Happ"),
      ],
    },
  ],
  icons: { flclashx: "<svg viewBox='0 0 1 1'></svg>", download: "<svg viewBox='0 0 1 1'></svg>" },
  connectScreenEnabled: true,
  theme: {
    presetId: "concept-ba",
    tokens: { "brand-primary": "#FF6B7A", "color-surface-high": "#151224D9" },
    backgroundImage: "linear-gradient(145deg, #05070D 0%, #0B0610 100%)",
    backgroundColor: "#05070D",
    rail: "#FF6B7A",
  },
};

const SUBSCRIPTION = {
  id: "sub-1",
  status: "ACTIVE",
  isTrial: false,
  profileName: "dizzable",
  url: "https://sub.example.test/abc",
  expiresAt: "2100-02-28T00:00:00.000Z",
  trafficUsed: 351,
  trafficLimit: null,
  deviceLimit: null,
  userRemnaId: null,
  plan: { id: null, name: null, type: null },
};

/** What each render's `/connect-page` read answers. Set per test. */
let catalogPayload: unknown = CATALOG;
let subscriptionsPayload: unknown = { subscriptions: [SUBSCRIPTION] };
/** The query string the dashboard handed over. */
let searchParams = new URLSearchParams();
/** Whether the operator uploaded a logo of their own. */
let brandingLogoUrl: string | null = null;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [searchParams, vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: queryKey[0] === "connect-page" ? catalogPayload : subscriptionsPayload,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client", () => ({ getAllSubscriptions: vi.fn(), getConnectPage: vi.fn() }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({
    branding: {
      brandName: "d3MVpn",
      logoUrl: brandingLogoUrl,
      navItems: [{ id: "support", visible: true }],
    },
    customIcons: {},
  }),
}));
vi.mock("@/components/ui/back-button", () => ({
  BackButton: () => <button type="button">back</button>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: ConnectPage } = await import("../src/features/connect/connect-page");
const { usePageBackdropStore } = await import("../src/stores/page-backdrop.store");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<ConnectPage />));
  return host;
}

beforeEach(() => {
  catalogPayload = CATALOG;
  subscriptionsPayload = { subscriptions: [SUBSCRIPTION] };
  searchParams = new URLSearchParams();
  brandingLogoUrl = null;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  usePageBackdropStore.setState({ backdrop: null });
});

describe("the arrangement the concepts share", () => {
  it("puts every step in one container, divided by rules", () => {
    const el = render();
    const timeline = el.querySelector<HTMLElement>("[data-testid='connect-timeline']");
    expect(timeline, "there is no single steps container").not.toBeNull();
    // Four steps, three rules: a card per step would have four containers and
    // no rules at all, which is exactly what shipped and was reported.
    expect(timeline?.querySelectorAll("[data-connect-step]")).toHaveLength(4);
    expect(timeline?.querySelectorAll("[data-connect-step-rule]")).toHaveLength(3);
  });

  it("numbers the steps in order, because they are a sequence", () => {
    const el = render();
    const numbers = [...el.querySelectorAll("[data-connect-step-number]")].map(
      (node) => node.textContent,
    );
    expect(numbers).toEqual(["01", "02", "03", "04"]);
  });

  it("wraps the apps instead of scrolling them", () => {
    const el = render();
    const apps = el.querySelector<HTMLElement>("[data-testid='connect-apps']");
    expect(apps, "there is no app row").not.toBeNull();
    // Wrapping, measured off the page this screen replaces. It beats both of
    // the things it replaced: a horizontal scroller could hide the selected app
    // off the right edge, and a fixed two-column grid needed a breakpoint to
    // decide what four apps do — this needs none, and a fifth app added later
    // simply takes a new line.
    expect(apps?.className).toContain("flex-wrap");
    expect(apps?.className).not.toContain("overflow-x-auto");
    expect(apps?.querySelectorAll("button")).toHaveLength(4);
  });

  it("says which subscription is being installed", () => {
    // The four facts also appear on the card this screen was opened from, and
    // that is the point: the tap leaves the card behind, and a customer holding
    // several subscriptions otherwise cannot tell which one this is.
    const el = render();
    const facts = el.querySelector<HTMLElement>("[data-testid='connect-facts']");
    expect(facts?.textContent).toContain("dizzable");
    expect(facts?.textContent).toContain("card.activeStatus");
  });
});

describe("whose subscription this screen is about", () => {
  /**
   * The dashboard hands the id over in the query string, and until this screen
   * grew the fact tiles a wrong answer cost only the key. Now the screen STATES
   * whose subscription it is — name, status, expiry, traffic — so substituting
   * a different one turns a quiet bug into a confident lie, under a key that
   * belongs to somebody else's plan.
   */
  const OTHER = {
    ...SUBSCRIPTION,
    id: "sub-2",
    profileName: "someone-else",
    url: "https://sub.example.test/other",
  };

  it("does not claim zero traffic when usage is unknown", () => {
    // `trafficUsed` is null when the figure is UNAVAILABLE, which is not zero.
    // "0 / 100 GB" tells a customer who may have spent their quota that they
    // have spent none, on the one screen whose job is to state facts.
    subscriptionsPayload = {
      subscriptions: [{ ...SUBSCRIPTION, trafficUsed: null, trafficLimit: 100 }],
    };
    const el = render();
    const facts = el.querySelector("[data-testid='connect-facts']")?.textContent ?? "";
    expect(facts).not.toContain("0 / 100");
    expect(facts).toContain("— / 100");
  });

  it("names it the way every other screen in the cabinet names it", () => {
    // The profile name is what the customer is being asked to recognise: it is
    // what this screen is about to install, and what their VPN client shows
    // them afterwards. The plan name cannot be the primary answer — two
    // subscriptions on one plan share it.
    subscriptionsPayload = {
      subscriptions: [{ ...SUBSCRIPTION, profileName: "rz_dizzable_sub", plan: { id: null, name: "Премиум", type: null } }],
    };
    const el = render();
    const facts = el.querySelector("[data-testid='connect-facts']");
    expect(facts?.textContent).toContain("rz_dizzable_sub");
    expect(facts?.textContent).not.toContain("Премиум");
  });

  it("falls back to the plan, then to the id, and never to a blank", () => {
    // `||`, not `??`: an empty profile name is not a name, and letting one
    // through renders a tile with no answer in it at all.
    subscriptionsPayload = {
      subscriptions: [{ ...SUBSCRIPTION, profileName: "", plan: { id: null, name: "Премиум", type: null } }],
    };
    expect(render().querySelector("[data-testid='connect-facts']")?.textContent).toContain("Премиум");

    act(() => root?.unmount());
    host?.remove();
    subscriptionsPayload = {
      subscriptions: [{ ...SUBSCRIPTION, profileName: null, plan: { id: null, name: null, type: null } }],
    };
    expect(render().querySelector("[data-testid='connect-facts']")?.textContent).toContain("sub-1");
  });

  it("lets a long profile name take a second line rather than losing its tail", () => {
    // Truncating `rz_dizzable_premium_sub` to `rz_dizzable_pre…` fails the only
    // job this tile has. The other three values are short by nature.
    subscriptionsPayload = {
      subscriptions: [{ ...SUBSCRIPTION, profileName: "rz_dizzable_premium_sub" }],
    };
    const el = render();
    const value = [...el.querySelectorAll("[data-testid='connect-facts'] span")].find(
      (node) => node.textContent === "rz_dizzable_premium_sub",
    );
    expect(value, "the profile name is not rendered").toBeDefined();
    expect(value?.className).not.toContain("truncate");
    expect(value?.className).toContain("line-clamp-2");
    // …and the whole string is reachable even when two lines are not enough.
    expect(value?.getAttribute("title")).toBe("rz_dizzable_premium_sub");
  });

  it("shows the subscription that was asked for, not the first one", () => {
    // `sub-2` is first in the list AND the first with a url — the two things the
    // old fallback preferred. Asking for `sub-1` has to beat both.
    subscriptionsPayload = { subscriptions: [OTHER, SUBSCRIPTION] };
    searchParams = new URLSearchParams("subscriptionId=sub-1");
    const el = render();
    expect(el.querySelector("[data-testid='connect-facts']")?.textContent).toContain("dizzable");
    expect(el.querySelector("[data-testid='connect-facts']")?.textContent).not.toContain(
      "someone-else",
    );
  });

  it("refuses to substitute when the id asked for is not there", () => {
    // A stale link, a subscription cancelled in another tab, an id from an
    // account this session is no longer on. Showing another subscription's
    // figures under another subscription's key is the harm.
    subscriptionsPayload = { subscriptions: [OTHER] };
    searchParams = new URLSearchParams("subscriptionId=sub-1");
    const el = render();
    expect(el.querySelector("[data-testid='connect-subscription-missing']")).not.toBeNull();
    expect(el.querySelector("[data-testid='connect-facts']")).toBeNull();
    expect(el.textContent).not.toContain("someone-else");
    // And nothing hands over a key that is not theirs.
    const handOver = el.querySelector<HTMLButtonElement>(
      'button[aria-label="connect.linkSheetOpen"]',
    );
    expect(handOver?.disabled).toBe(true);
  });

  it("still picks something sensible when nothing was asked for", () => {
    // The dashboard links here without an id when there is no active card. That
    // is not the same as asking for one that does not exist, and it must not
    // produce the notice.
    subscriptionsPayload = { subscriptions: [{ ...OTHER, url: null }, SUBSCRIPTION] };
    searchParams = new URLSearchParams();
    const el = render();
    expect(el.querySelector("[data-testid='connect-subscription-missing']")).toBeNull();
    // The one that can actually be installed wins over the one that cannot.
    expect(el.querySelector("[data-testid='connect-facts']")?.textContent).toContain("dizzable");
  });
});

describe("the mark in the header", () => {
  it("is the operator's own when they configured one", () => {
    brandingLogoUrl = "https://cdn.example.test/logo.svg";
    const el = render();
    const img = el.querySelector<HTMLImageElement>("header img[data-brand-logo='image']");
    expect(img?.getAttribute("src")).toBe("https://cdn.example.test/logo.svg");
  });

  it("falls back to the stock mark when they did not", () => {
    // Not a blank space and not a letter: a white-labelled deployment that has
    // not uploaded a logo yet still gets a mark, tinted with the brand colour.
    brandingLogoUrl = null;
    const el = render();
    expect(el.querySelector("header img[data-brand-logo='image']")).toBeNull();
    expect(el.querySelector("header svg"), "no mark at all in the header").not.toBeNull();
  });
});

describe("an operator editing the catalog", () => {
  // The catalog is edited in the panel and reaches the cabinet through a cache
  // invalidation, so every one of these states arrives at a screen that is
  // already open. None of them may leave it broken.

  it("shows an app that was just added, in the operator's order", () => {
    const platform = CATALOG.platforms[0];
    catalogPayload = {
      ...CATALOG,
      platforms: [{ ...platform, apps: [...platform.apps, koalaLike("throne", "Throne")] }],
    };
    const el = render();
    const names = [...el.querySelectorAll("[data-connect-app]")].map((n) => n.textContent);
    expect(names.some((name) => name?.includes("Throne"))).toBe(true);
    // Order is operator content — which app is offered first is a decision.
    expect(names[0]).toContain("FlClashX");
  });

  it("keeps working when the app the customer was on is deleted", () => {
    // `chooseApp` falls back featured → first, so the steps below describe an
    // app that still exists. The failure this prevents is a screen with a
    // selected chip and no steps under it, which reads as "it broke".
    const platform = CATALOG.platforms[0];
    catalogPayload = {
      ...CATALOG,
      platforms: [{ ...platform, apps: platform.apps.filter((a) => a.id !== "flclashx") }],
    };
    const el = render();
    const pressed = el.querySelector("[data-connect-app][aria-pressed='true']");
    expect(pressed, "nothing is selected after the selected app was deleted").not.toBeNull();
    expect(el.querySelectorAll("[data-connect-step]").length).toBeGreaterThan(0);
  });

  it("does not leave a hole when an odd number of apps is left", () => {
    // Three apps in a two-column grid. The row simply ends — what must not
    // happen is a stretched last chip or a gap that reads as a missing one.
    const platform = CATALOG.platforms[0];
    catalogPayload = {
      ...CATALOG,
      platforms: [{ ...platform, apps: platform.apps.slice(0, 3) }],
    };
    const el = render();
    const apps = el.querySelector<HTMLElement>("[data-testid='connect-apps']");
    expect(apps?.querySelectorAll("[data-connect-app]")).toHaveLength(3);
    // Every chip is the same fixed height, so a short row cannot stretch one.
    for (const chip of apps?.querySelectorAll("[data-connect-app]") ?? []) {
      expect(chip.className).toContain("h-12");
    }
  });

  it("hides the picker entirely when only one app is left", () => {
    // A chooser with one option is a decoration that asks for a decision.
    const platform = CATALOG.platforms[0];
    catalogPayload = {
      ...CATALOG,
      platforms: [{ ...platform, apps: platform.apps.slice(0, 1) }],
    };
    const el = render();
    expect(el.querySelector("[data-testid='connect-apps']")).toBeNull();
    // …and the steps for that one app are still there.
    expect(el.querySelectorAll("[data-connect-step]").length).toBeGreaterThan(0);
  });

  it("puts the app mark behind the label, pinned to the right edge", () => {
    // The page this screen replaces draws the logo as a watermark running off
    // the chip's right edge, not as a small icon beside the name. Pinned to the
    // RIGHT because the chip narrows as the row wraps: a left offset that lands
    // correctly on a desktop lands in the middle of the label on a phone.
    const el = render();
    const mark = el.querySelector<HTMLElement>("[data-connect-app-mark]");
    expect(mark, "the app has no mark on it").not.toBeNull();
    expect(mark?.className).toContain("absolute");
    expect(mark?.className).toMatch(/-right-/);
    expect(mark?.className, "the mark is anchored from the left").not.toMatch(/left-/);
    // Behind the label, which carries its own stacking context above it.
    const label = [...el.querySelectorAll("[data-connect-app] span")].find((n) =>
      n.textContent === "FlClashX",
    );
    expect(label?.className).toContain("z-10");
  });

  it("marks the app the operator recommends", () => {
    const el = render();
    const featured = el.querySelectorAll("[data-connect-featured]");
    expect(featured).toHaveLength(1);
    expect(featured[0].closest("[data-connect-app]")?.getAttribute("data-connect-app")).toBe(
      "flclashx",
    );
  });
});

describe("the same arrangement on a phone and on a desktop", () => {
  // The concept book has both artboards and they are the SAME vertical stack —
  // 393 wide with 18px gutters and a 2×2 app grid, 960 wide with 60px gutters
  // and the apps in one row. So the difference is breakpoints on one tree, not
  // a second layout, and these check that the phone case is the base and the
  // desktop case is the modifier rather than the other way round.

  it("gutters and grid are the phone's, widened at the breakpoint", () => {
    const el = render();
    const shell = el.querySelector<HTMLElement>("[data-connect-theme] > div");
    expect(shell?.className).toContain("px-[18px]");
    expect(shell?.className).toContain("md:px-[60px]");
    // Never wider than the desktop artboard: a full-bleed row of apps across a
    // 27-inch monitor was the last thing reported about a screen in here.
    expect(shell?.className).toContain("max-w-[60rem]");
  });

  it("lets the apps decide their own rows, with no breakpoint involved", () => {
    // The live page does the same and it is why the mark looks "shifted" on a
    // phone: nothing about the chip changes between widths except how many fit
    // on a line, so a breakpoint here would be inventing a difference the
    // original does not have.
    const el = render();
    const apps = el.querySelector<HTMLElement>("[data-testid='connect-apps']");
    expect(apps?.className).toContain("flex-wrap");
    expect(apps?.className, "a breakpoint decides the app layout").not.toMatch(/md:(flex|grid)/);
  });

  it("keeps the section subtitle off the phone, where there is no room", () => {
    const el = render();
    const hint = [...el.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("connect.installHint"),
    );
    expect(hint, "the desktop subtitle is missing").toBeDefined();
    expect(hint?.className).toContain("hidden");
    expect(hint?.className).toContain("md:block");
  });
});

describe("what colour an icon takes", () => {
  /**
   * The default is the theme, and that is what makes ONE catalog look right on
   * all 104 concepts: the step glyphs are drawn on `currentColor`, so the ring
   * hands them whatever accent is in force.
   *
   * The override exists because the page this screen replaces carries a colour
   * per step (`svgIconColor`), and an operator who used it would otherwise lose
   * it on the way across.
   */
  it("follows the theme when the operator set nothing", () => {
    const el = render();
    const ring = el.querySelector<HTMLElement>("[data-connect-step] span");
    expect(ring?.style.color).toBe("var(--brand-primary)");
  });

  it("uses the operator's colour when they set one", () => {
    const platform = CATALOG.platforms[0];
    const app = platform.apps[0];
    catalogPayload = {
      ...CATALOG,
      platforms: [
        {
          ...platform,
          apps: [
            { ...app, steps: [{ ...app.steps[0], iconColor: "#4FC4DD" }, ...app.steps.slice(1)] },
            ...platform.apps.slice(1),
          ],
        },
      ],
    };
    const el = render();
    const ring = el.querySelector<HTMLElement>("[data-connect-step] span");
    expect(ring?.style.color).toBe("rgb(79, 196, 221)");
  });

  it("ignores anything that is not a colour", () => {
    // The value lands in a `style` attribute. The panel refuses everything but
    // a hex literal at save time, and the cabinet refuses it again — the two
    // ship as separate images and this side is where it becomes CSS.
    const platform = CATALOG.platforms[0];
    const app = platform.apps[0];
    for (const bad of ["var(--admin-token)", "red", "url(https://evil.test)", ""]) {
      catalogPayload = {
        ...CATALOG,
        platforms: [
          {
            ...platform,
            apps: [
              { ...app, steps: [{ ...app.steps[0], iconColor: bad }, ...app.steps.slice(1)] },
              ...platform.apps.slice(1),
            ],
          },
        ],
      };
      const el = render();
      expect(
        el.querySelector<HTMLElement>("[data-connect-step] span")?.style.color,
        bad,
      ).toBe("var(--brand-primary)");
      act(() => root?.unmount());
      host?.remove();
    }
  });
});

describe("a concept the operator chose", () => {
  it("scopes its tokens to one element, not to the document", () => {
    // A token written onto `documentElement` would follow the customer back out
    // of this screen and repaint a cabinet wearing a different concept.
    const el = render();
    const themed = el.querySelector<HTMLElement>("[data-connect-theme='concept']");
    expect(themed).not.toBeNull();
    expect(themed?.style.getPropertyValue("--brand-primary")).toBe("#FF6B7A");
    // The GROUND is not here — it goes to the shell, which paints `<main>`.
    // Painted here it covers only this route's own column and leaves the
    // cabinet's black down both sides: "что за обрубки по бокам".
    expect(themed?.style.backgroundImage).toBe("");
    expect(themed?.style.backgroundColor).toBe("");
    expect(document.documentElement.style.getPropertyValue("--brand-primary")).toBe("");
  });

  it("paints its own text colour, not the one it inherited", () => {
    // The bug this replaces: the element declared `--brand-foreground` and no
    // `color`. Custom properties substitute where the DECLARATION is, and the
    // cabinet's `color` was already computed on `body` and on the layout shell
    // — both ancestors. So the override could not reach the text, and 44 of the
    // 104 concepts (the light-backgrounded ones) painted the cabinet's near
    // white body text onto their own near white ground.
    //
    // Asserted on `color` rather than on a rendered pixel because jsdom does
    // not cascade: what has to be true is that the element which DECLARES the
    // token also declares the property that reads it.
    const el = render();
    const themed = el.querySelector<HTMLElement>("[data-connect-theme='concept']");
    expect(themed?.style.color, "the concept cannot reach the text").toContain(
      "--brand-foreground",
    );
  });

  it("falls back to the cabinet's own appearance when there is no concept", () => {
    catalogPayload = { ...CATALOG, theme: undefined };
    const el = render();
    const themed = el.querySelector<HTMLElement>("[data-connect-theme='inherit']");
    expect(themed, "the screen did not fall back to the cabinet's theme").not.toBeNull();
    expect(themed?.style.backgroundImage).toBe("");
  });

  it("leaves the text alone when there is no concept", () => {
    // With nothing to apply the screen must inherit, not pin a colour of its
    // own — otherwise a cabinet whose customer switched to light mode would be
    // overridden by a screen that had no opinion.
    catalogPayload = { ...CATALOG, theme: undefined };
    const el = render();
    expect(el.querySelector<HTMLElement>("[data-connect-theme='inherit']")?.style.color).toBe("");
  });

  it("keeps the concept when the catalog is empty", () => {
    // The appearance and the app list fail independently. An operator who
    // emptied the catalog still has a screen with a header, the facts and the
    // link on it, and it should still be wearing what they picked.
    catalogPayload = { platforms: [], icons: {}, theme: CATALOG.theme };
    const el = render();
    expect(el.querySelector("[data-connect-theme='concept']")).not.toBeNull();
    expect(el.textContent).toContain("connect.catalogUnavailable");
  });
});

describe("what still works when the panel does not", () => {
  // The catalog is fetched from the panel and the panel can be down. The
  // subscription link is NOT — it arrives with the card this screen was opened
  // from. So there is always a working control that hands the link over, and it
  // is the concept's own round button rather than an extra card above the
  // workspace (that card existed for a while and was removed as not being in
  // the book; this is the property it was there to guarantee).
  it("can still hand the link over with no catalog at all", () => {
    catalogPayload = undefined;
    const el = render();
    const handOver = el.querySelector<HTMLButtonElement>(
      'button[aria-label="connect.linkSheetOpen"]',
    );
    expect(handOver, "no control hands the link over").not.toBeNull();
    expect(handOver?.disabled).toBe(false);
  });

  it("disables it when there is genuinely no link yet", () => {
    // Different from "the panel is down": here the subscription itself has no
    // url. Offering a control that hands over nothing is worse than offering
    // none, because pressing it looks like it worked.
    subscriptionsPayload = { subscriptions: [{ ...SUBSCRIPTION, url: null }] };
    const el = render();
    const handOver = el.querySelector<HTMLButtonElement>(
      'button[aria-label="connect.linkSheetOpen"]',
    );
    expect(handOver?.disabled).toBe(true);
  });

  it("does not announce the brand twice", () => {
    // The mark carries the brand name as its accessible title and the text
    // beside it carries the same string, so a screen reader read it twice in a
    // row. The mark is decoration here — the name is right next to it.
    //
    // Asserted on the attribute rather than on `textContent`, which cannot
    // answer this: `textContent` walks the DOM and reports the SVG `<title>`
    // whether or not the subtree is hidden from assistive technology. A count
    // over it would have passed for the wrong reason.
    const el = render();
    const mark = el.querySelector("header [data-brand-logo], header svg");
    expect(mark, "no brand mark in the header").not.toBeNull();
    expect(mark?.closest('[aria-hidden="true"]'), "the mark is announced").not.toBeNull();
    // And the name itself is still there to be read, exactly once.
    expect(el.querySelector("header")?.textContent).toContain("d3MVpn");
  });
});

describe("the link sheet behind the header control", () => {
  /**
   * The control used to copy outright. It now opens a sheet with a QR code in
   * it, because copying only works on the device that is already holding the
   * link — and the devices that most need a subscription added are the ones
   * that are not: a TV box, a router, a desktop client. The page this screen
   * replaces puts the code behind this same control, and it was missing here.
   */
  /**
   * QUERIED FROM THE DOCUMENT, not from the render container.
   *
   * The sheet portals to the body, so `el.querySelector` finds nothing — and
   * the danger is not the two cases that go red, it is the one that goes GREEN:
   * "closes on Escape" asserts the sheet is absent from `el`, which a portalled
   * sheet satisfies whether Escape works or not. A helper both halves share is
   * what stops that pair drifting apart again.
   */
  function sheet(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>("[data-testid='connect-link-dialog']");
  }

  function open(): HTMLDivElement {
    const el = render();
    const control = el.querySelector<HTMLButtonElement>(
      'button[aria-label="connect.linkSheetOpen"]',
    );
    act(() => control?.click());
    return el;
  }

  it("opens the sheet instead of copying silently", () => {
    open();
    expect(sheet()).not.toBeNull();
  });

  it("still offers copy, inside the sheet", () => {
    // Copy did not go away, it moved. On the device the client is installed on
    // it is still the right answer, so both live in one place.
    open();
    expect(sheet()?.textContent).toContain("connect.copyLink");
  });

  it("closes on Escape", () => {
    open();
    const opened = sheet();
    expect(opened, "the sheet never opened, so closing it proves nothing").not.toBeNull();
    act(() => {
      opened?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(sheet()).toBeNull();
  });

  it("carries the concept's tokens, though it opens outside the themed element", () => {
    // The sheet has to escape TWO things at once and they pull opposite ways.
    //
    // Rendered inside the themed element it inherited the concept correctly and
    // could not escape the shell's stacking: `<main>` is `relative z-10` and the
    // floating navigation is its `z-20` SIBLING, so `z-50` inside `<main>` lost
    // to the pill every time — which painted lit and clickable over the sheet's
    // own copy button.
    //
    // Portalled bare it would clear the navigation and lose the palette, which
    // is the defect the native platform list had, in a bigger box. So it
    // portals AND carries the tokens on the overlay itself.
    open();
    const overlay = sheet();

    expect(overlay?.closest("[data-connect-theme='concept']"), 'still inside the page').toBeNull();
    // The concept's own accent, verbatim — the same token the case above pins
    // on the themed element itself, so the two say the tokens arrive in both
    // places rather than in one.
    expect(overlay?.style.getPropertyValue('--brand-primary')).toBe('#FF6B7A');
  });
});

describe("the platform list is ours, not the operating system's", () => {
  const TWO_PLATFORMS = {
    ...CATALOG,
    platforms: [
      CATALOG.platforms[0],
      {
        id: "android",
        title: { ru: "Android", en: "Android" },
        apps: [koalaLike("v2raytun", "v2RayTun")],
      },
    ],
  };

  function openList(): HTMLDivElement {
    catalogPayload = TWO_PLATFORMS;
    const el = render();
    act(() =>
      el.querySelector<HTMLButtonElement>("[data-testid='connect-platform-trigger']")?.click(),
    );
    return el;
  }

  it("draws no native select at all", () => {
    // A `<select>`'s open list is painted by the platform, and the highlighted
    // row takes the platform's own selection colour — on Windows a solid opaque
    // blue over the label. `color-scheme` fixed the sheet being white; it
    // cannot fix the row you are standing on being unreadable.
    catalogPayload = TWO_PLATFORMS;
    const el = render();
    expect(el.querySelector("select")).toBeNull();
    expect(el.querySelector("[data-testid='connect-platform-trigger']")).not.toBeNull();
  });

  it("marks the chosen row with a tint that does not cover it", () => {
    const el = openList();
    const chosen = el.querySelector<HTMLElement>("[data-connect-platform][data-selected]");
    expect(chosen, "nothing marks the chosen platform").not.toBeNull();
    const tint = chosen?.querySelector<HTMLElement>("[data-connect-platform-tint]");
    expect(tint, "the mark is not a tint").not.toBeNull();
    // The two halves of "does not cover it": the fill is translucent, and the
    // label sits above it rather than under it.
    expect(tint?.className).toMatch(/opacity-[0-9]+/);
    expect(tint?.className).toContain("pointer-events-none");
    expect(chosen?.querySelector("span.z-10")?.textContent).toBe("Windows");
  });

  it("wears the concept, because it is inside the themed element", () => {
    const el = openList();
    const list = el.querySelector("[data-testid='connect-platform-list']");
    expect(list?.closest("[data-connect-theme='concept']")).not.toBeNull();
  });

  it("switches platform when a row is chosen", () => {
    const el = openList();
    act(() => el.querySelector<HTMLButtonElement>("[data-connect-platform='android']")?.click());
    expect(el.querySelector("[data-testid='connect-platform-list']")).toBeNull();
    expect(el.querySelector("[data-testid='connect-platform-trigger']")?.textContent).toContain(
      "Android",
    );
  });

  it("opens and moves on the keyboard", () => {
    catalogPayload = TWO_PLATFORMS;
    const el = render();
    const trigger = el.querySelector<HTMLElement>("[data-testid='connect-platform-trigger']");
    act(() => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const list = el.querySelector<HTMLElement>("[data-testid='connect-platform-list']");
    expect(list, "the list did not open on ArrowDown").not.toBeNull();
    // Two renders, not one batch: within a single `act` the second handler
    // would still read the pre-render `active`, and Enter would pick the row
    // ArrowDown had just left. A person pressing two keys gets two tasks.
    act(() => {
      list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    act(() => {
      el.querySelector<HTMLElement>("[data-testid='connect-platform-list']")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(el.querySelector("[data-testid='connect-platform-trigger']")?.textContent).toContain(
      "Android",
    );
  });
});

describe("the recommendation dot", () => {
  /** What the browser makes of a colour, so the assertion is not about spelling. */
  function asRendered(colour: string): string {
    const probe = document.createElement("div");
    probe.style.background = colour;
    return probe.style.background;
  }

  it("is amber by default, not the accent", () => {
    // Drawn in the accent it vanished on the chosen chip — that chip is FILLED
    // with the accent — and read as punctuation on the others. The page this
    // screen replaces marks its recommended app in yellow for the same reason:
    // the mark is an annotation ON the catalog, not one more thing wearing the
    // brand colour.
    const el = render();
    const dot = el.querySelector<HTMLElement>("[data-connect-featured]");
    expect(dot, "nothing marks the recommended app").not.toBeNull();
    expect(dot?.style.background).toBe(asRendered("#FACC15"));
  });

  it("sits in the top-left corner, clear of the label and the mark", () => {
    const el = render();
    const dot = el.querySelector<HTMLElement>("[data-connect-featured]");
    // The mark bleeds off the top RIGHT, and the label is centred against the
    // left padding. That corner is the one place nothing else is.
    expect(dot?.className).toContain("absolute");
    expect(dot?.className).toMatch(/left-\[/);
    expect(dot?.className).toMatch(/top-\[/);
    expect(dot?.className).not.toContain("ml-auto");
  });

  it("takes the operator's colour when they set one", () => {
    catalogPayload = { ...CATALOG, featuredColor: "#00FF7F" };
    const el = render();
    const dot = el.querySelector<HTMLElement>("[data-connect-featured]");
    expect(dot?.style.background).toBe(asRendered("#00FF7F"));
  });

  it("falls back to amber for a panel that never heard of the field", () => {
    // The panel and the cabinet ship as separate images. A cabinet running
    // ahead of its panel gets no field at all, and must not draw a dot with no
    // colour — which renders as nothing and reads as "the mark disappeared".
    catalogPayload = { ...CATALOG, featuredColor: undefined };
    const el = render();
    expect(el.querySelector<HTMLElement>("[data-connect-featured]")?.style.background).toBe(
      asRendered("#FACC15"),
    );
  });
});

describe("the ground the screen hands to the shell", () => {
  /**
   * The concept is a palette AND a ground, and they land in different places.
   * The palette is declared on this screen's own element so it cannot follow
   * the customer back out. The ground cannot live there at all: the screen is
   * rendered inside `<main>`'s centred column, so a background painted here is
   * a themed rectangle with the cabinet's black down both sides — reported from
   * a desktop as "что за обрубки по бокам".
   */
  it("publishes it while the screen is open", () => {
    render();
    const backdrop = usePageBackdropStore.getState().backdrop;
    expect(backdrop?.backgroundImage).toContain("linear-gradient");
    expect(backdrop?.backgroundColor).toBe("#05070D");
    expect(backdrop?.rail).toBe("#FF6B7A");
  });

  it("takes it back on the way out", () => {
    // A concept that followed the customer to the dashboard would be a cabinet
    // wearing two themes at once.
    render();
    expect(usePageBackdropStore.getState().backdrop).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    expect(usePageBackdropStore.getState().backdrop).toBeNull();
  });

  it("asks for nothing when the operator picked no concept", () => {
    catalogPayload = { ...CATALOG, theme: undefined };
    render();
    expect(usePageBackdropStore.getState().backdrop).toBeNull();
  });
});

describe("the chosen app keeps its logo", () => {
  /**
   * THE CHIP WAS FILLED WITH THE ACCENT, AND THAT COVERED THE ONE THING IT IS
   * FOR.
   *
   * Most vendor marks are a light glyph, the mark is drawn at a quarter
   * opacity, and a light glyph at 25% over a near-white accent is nothing at
   * all — so the app the customer had chosen was the single chip on the screen
   * with no logo on it. Reported as "баг с кнопкой остался, что теряется лого".
   *
   * The chip now keeps the sunken surface and its mark, and the choice is said
   * with the accent border and an 18% wash of the accent over the whole chip.
   */
  const chosen = (el: HTMLElement) =>
    el.querySelector<HTMLElement>("[data-connect-app][aria-pressed='true']");

  it("does not fill the chosen chip with the accent", () => {
    const el = render();
    const chip = chosen(el);
    expect(chip, "nothing is marked as chosen").not.toBeNull();
    expect(chip?.className).not.toContain("bg-[color:var(--brand-primary)]");
    expect(chip?.className).toContain("bg-[color:var(--color-surface)]");
  });

  it("says the choice with a wash over the chip, and frosts it", () => {
    const el = render();
    const chip = chosen(el);
    const tint = chip?.querySelector<HTMLElement>("[data-connect-app-tint]");
    expect(tint, "the choice is not a wash").not.toBeNull();
    expect(tint?.className).toMatch(/opacity-\[0?\.\d+\]/);
    expect(tint?.className).toContain("pointer-events-none");
    // The frosting the concept's own blur provides.
    expect(chip?.className).toContain("backdrop-blur-[var(--glass-blur)]");
    // And the border still carries it for anyone the wash is too subtle for.
    expect(chip?.className).toContain("border-[color:var(--brand-primary)]");
  });

  it("keeps the mark on the chosen chip, at the same weight as the others", () => {
    const el = render();
    const chip = chosen(el);
    const mark = chip?.querySelector<HTMLElement>("[data-connect-app-mark]");
    expect(mark, "the chosen app lost its logo").not.toBeNull();
    expect(mark?.className).toContain("opacity-25");
  });

  it("puts the wash above the mark and below the label", () => {
    // Frosting sits over what it frosts. Under the mark it would not frost it;
    // over the label it would dim the name.
    const el = render();
    const chip = chosen(el);
    const order = [...(chip?.children ?? [])].map((node) =>
      node.hasAttribute("data-connect-app-mark")
        ? "mark"
        : node.hasAttribute("data-connect-app-tint")
          ? "tint"
          : node.hasAttribute("data-connect-featured")
            ? "dot"
            : "label",
    );
    expect(order.indexOf("tint")).toBeGreaterThan(order.indexOf("mark"));
    expect(order.indexOf("tint")).toBeLessThan(order.indexOf("label"));
  });
});
