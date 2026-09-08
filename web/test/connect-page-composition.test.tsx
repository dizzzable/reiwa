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

  it("lays the apps out as a grid rather than a scroller", () => {
    const el = render();
    const apps = el.querySelector<HTMLElement>("[data-testid='connect-apps']");
    expect(apps, "there is no app grid").not.toBeNull();
    expect(apps?.className).toContain("grid");
    // The scroller it replaced is the reason the selected app could sit off the
    // right edge; a grid has no off-screen.
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
    const copy = el.querySelector<HTMLButtonElement>('button[aria-label="connect.copyLink"]');
    expect(copy?.disabled).toBe(true);
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
      expect(chip.className).toContain("h-9");
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

  it("stacks the apps in two columns on a phone and one row on a desktop", () => {
    const el = render();
    const apps = el.querySelector<HTMLElement>("[data-testid='connect-apps']");
    expect(apps?.className).toContain("grid-cols-2");
    expect(apps?.className).toContain("md:flex");
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

describe("a concept the operator chose", () => {
  it("paints one element and not the document", () => {
    // A token written onto `documentElement` would follow the customer back out
    // of this screen and repaint a cabinet wearing a different concept.
    const el = render();
    const themed = el.querySelector<HTMLElement>("[data-connect-theme='concept']");
    expect(themed).not.toBeNull();
    expect(themed?.style.getPropertyValue("--brand-primary")).toBe("#FF6B7A");
    expect(themed?.style.backgroundImage).toContain("linear-gradient");
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
    const copy = el.querySelector<HTMLButtonElement>('button[aria-label="connect.copyLink"]');
    expect(copy, "no control hands the link over").not.toBeNull();
    expect(copy?.disabled).toBe(false);
  });

  it("disables it when there is genuinely no link yet", () => {
    // Different from "the panel is down": here the subscription itself has no
    // url. Offering a copy button that copies nothing is worse than offering
    // none, because pressing it looks like it worked.
    subscriptionsPayload = { subscriptions: [{ ...SUBSCRIPTION, url: null }] };
    const el = render();
    const copy = el.querySelector<HTMLButtonElement>('button[aria-label="connect.copyLink"]');
    expect(copy?.disabled).toBe(true);
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
