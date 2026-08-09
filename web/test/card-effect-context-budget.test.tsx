// @vitest-environment jsdom

/**
 * How many card renderers a LIST is allowed to have running at once.
 *
 * `CardEffectLayer` mounts an effect only while the card is on screen, and left
 * without an `active` prop it works that out itself with an
 * IntersectionObserver. That is a real bound and it is why a catalogue of forty
 * tariffs is not forty WebGL contexts. What it is NOT is a ceiling: it says "as
 * many as fit on this device", and the subscription picker's tiles are ~112 px
 * tall and every one of them draws the operator's single global effect
 * (`aurora` by default, WebGL1). Seven or eight fit on a phone, twelve on a
 * tablet — against WebKit's pool of 16 per web-content process, shared with the
 * always-mounted app background, and with each card briefly holding a SECOND
 * context while its capability probe drains. The card that loses at the limit
 * gets an unrecoverable `SyntheticLostContext` and stays blank.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. jsdom has no WebGL and no layout, so
 * nothing here proves a GL context was created or destroyed — `getContext` is
 * stubbed, and a stub costs nothing. What it observes is the renderer COMPONENT
 * being committed to and removed from the DOM, which is the thing that owns the
 * context in production, and the `active` decision that governs it. Read every
 * count below as "renderers mounted", never as "contexts alive".
 *
 * Both call sites are exercised separately, because they are wired separately
 * and deleting the wiring from one is exactly the regression that would
 * otherwise survive — and then TOGETHER, because a per-list budget passes both
 * of the separate cases while the process still runs out of contexts.
 */

import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BRANDING } from "../src/types/branding";

/**
 * The real manifest pulls `ogl` and `three` in. This keeps the REAL layer, the
 * real catalogue (so `threads` is still WebGL1 and `waves` is still canvas2d —
 * the budget reads that classification from the catalogue, and faking it would
 * make the exemption below untestable) and swaps only the drawing components.
 */
vi.mock("../src/components/reactbits/card-effect-manifest", async () => {
  const catalog = await vi.importActual<
    typeof import("../src/components/reactbits/card-effect-catalog")
  >("../src/components/reactbits/card-effect-catalog");
  const renderer = () => <canvas data-test-effect />;
  return {
    CARD_EFFECT_COMPONENTS: new Proxy(
      {},
      { get: (_target, key) => (typeof key === "string" ? renderer : undefined) },
    ),
    isKnownCardEffect: catalog.isKnownCardEffect,
    cardEffectDefaults: catalog.cardEffectDefaults,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("motion/react", () => ({
  motion: {
    button: ({ children, ...props }: ComponentProps<"button">) => (
      <button {...props}>{children}</button>
    ),
  },
}));

vi.mock("@/components/ui/card-watermark", () => ({
  CardWatermark: () => null,
}));
vi.mock("@/components/ui/custom-icon-view", () => ({
  CustomIconView: () => null,
}));
vi.mock("@/components/ui/emoji-text", () => ({
  EmojiText: () => null,
}));

const branding = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => branding.current,
}));

import {
  CARD_EFFECT_CONTEXT_BUDGET,
  cardEffectBudget,
  useCardEffectSlot,
} from "../src/lib/card-effect-budget";
import { SubscriptionSelectCard } from "../src/components/subscription/subscription-select-card";
import { TariffCard } from "../src/features/plans/tariff-card";

/* ── a driveable IntersectionObserver ─────────────────────────────────────── */

interface FakeEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
}

const observers = new Set<FakeObserver>();

class FakeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: (entries: FakeEntry[]) => void) {
    observers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }
  /** The layer and the budget both read `([entry]) => …`, so one per call. */
  fire(onScreen: (target: Element) => boolean): void {
    for (const target of [...this.targets]) {
      this.callback([{ target, isIntersecting: onScreen(target) }]);
    }
  }
}

/**
 * Report which cards are on screen. Every observer currently watching anything
 * is told about its own targets, so this drives the budget's observer on the
 * card root AND the layer's own observer on the inner element — the second is
 * the one still in charge for canvas2d effects.
 */
function onScreenCards(...indexes: readonly (number | string)[]): void {
  const visible = new Set(indexes.map(String));
  act(() => {
    for (const observer of [...observers]) {
      observer.fire((target) =>
        visible.has(
          target.closest("[data-card-index]")?.getAttribute("data-card-index") ??
            "",
        ),
      );
    }
  });
  // A grant arrives through a listener during an effect, so the commit that
  // mounts the renderer is the NEXT one. Flush it.
  act(() => undefined);
}

/* ── rendering ────────────────────────────────────────────────────────────── */

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

const renderers = (container: HTMLDivElement): readonly string[] =>
  [...container.querySelectorAll("[data-test-effect]")].map(
    (node) =>
      node.closest("[data-card-index]")?.getAttribute("data-card-index") ?? "?",
  );

/**
 * `prefix` only labels the DOM, never the plan id — branding still keys off
 * `plan-N`. It exists so two lists can be told apart in one document, which is
 * the shape the renewal route actually has.
 */
function planCards(count: number, effect: string, prefix = ""): ReactElement {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} data-card-index={`${prefix}${index}`}>
          <TariffCard
            plan={
              {
                id: `plan-${index}`,
                name: `Plan ${index}`,
                durations: [],
                displayPrices: [],
                icon: null,
                type: null,
                description: null,
                trafficLimit: null,
                deviceLimit: null,
                isTrial: false,
              } as never
            }
            index={index}
            onClick={() => undefined}
          />
        </div>
      ))}
    </>
  );
}

function subscriptionCards(count: number, prefix = ""): ReactElement {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} data-card-index={`${prefix}${index}`}>
          <SubscriptionSelectCard
            subscription={
              {
                id: `sub-${index}`,
                status: "ACTIVE",
                profileName: `Sub ${index}`,
                plan: null,
                trafficUsed: null,
                trafficLimit: null,
                deviceLimit: null,
                expiresAt: null,
                expireAt: null,
              } as never
            }
            selected={false}
            onSelect={() => undefined}
          />
        </div>
      ))}
    </>
  );
}

/** Every plan gets the same effect, so the count is about the budget only. */
function withPlanEffect(effect: string, planCount: number): void {
  const planCardStyles: Record<string, { cardEffect: string }> = {};
  for (let index = 0; index < planCount; index += 1) {
    planCardStyles[`plan-${index}`] = { cardEffect: effect };
  }
  branding.current = {
    branding: { ...DEFAULT_BRANDING, planCardStyles },
    defaultCurrency: "USD",
    customIcons: [],
  };
}

function withGlobalEffect(effect: string): void {
  branding.current = {
    branding: { ...DEFAULT_BRANDING, cardEffect: effect },
    defaultCurrency: "USD",
    customIcons: [],
  };
}

/**
 * Backgrounding the tab. `visibilityState` is a prototype getter in jsdom, so
 * it is shadowed with an own property and deleted again in `afterEach`.
 *
 * Deliberately does NOT re-fire any IntersectionObserver: a real observer does
 * not re-deliver an entry because the page came back, and the point of the test
 * below is that nothing needs it to.
 */
function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  act(() => undefined);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  // jsdom draws nothing, so every context here is a stub — see the header. The
  // `2d` one is not optional: `observeCardEffectCanvases` treats a canvas2d
  // effect whose canvas has no 2d context as a runtime FAILURE and swaps the
  // whole layer for the CSS fallback, which would make the canvas2d cases below
  // report zero renderers for a reason that has nothing to do with the budget.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) => {
      if (kind === "webgl" || kind === "webgl2") {
        return {
          getExtension: () => ({ loseContext: () => undefined }),
          isContextLost: () => false,
        };
      }
      if (kind === "2d") {
        return {
          drawImage: () => undefined,
          getImageData: () => ({ data: new Uint8ClampedArray(0) }),
        };
      }
      return null;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(() => {
  act(() => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted.splice(0)) container.remove();
  observers.clear();
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ── the ceiling ──────────────────────────────────────────────────────────── */

describe("a screenful of tariff cards", () => {
  it("caps how many WebGL renderers run at once, however many are on screen", () => {
    const on = CARD_EFFECT_CONTEXT_BUDGET + 4;
    withPlanEffect("threads", on);
    const container = render(planCards(on, "threads"));

    onScreenCards(...Array.from({ length: on }, (_, index) => index));

    expect(
      renderers(container).length,
      `${on} tariff cards were on screen at once and ${renderers(container).length} ` +
        `WebGL renderers mounted. The budget is ${CARD_EFFECT_CONTEXT_BUDGET}: past ` +
        `that, WebKit's 16-context pool starts evicting, and an evicted context is ` +
        `handed an unrecoverable SyntheticLostContext — the card never comes back.`,
    ).toBe(CARD_EFFECT_CONTEXT_BUDGET);
  });

  it("gives the slots to the cards nearest the top of the list", () => {
    // Not merely "six of them". Which six is the difference between a stable
    // list and one that reshuffles which cards animate on every scroll frame.
    const on = CARD_EFFECT_CONTEXT_BUDGET + 4;
    withPlanEffect("threads", on);
    const container = render(planCards(on, "threads"));

    onScreenCards(...Array.from({ length: on }, (_, index) => index));

    expect(
      renderers(container),
      "the slots did not go to the first cards in the list. Which six draw is " +
        "not cosmetic: a rule that re-ranks by anything a scroll changes tears " +
        "down a renderer that was drawing correctly and builds another, trading " +
        "a bounded number of live contexts for an unbounded number of context " +
        "CREATIONS — the more expensive half of the problem on iOS",
    ).toEqual(
      Array.from({ length: CARD_EFFECT_CONTEXT_BUDGET }, (_, i) => String(i)),
    );
  });

  it("still draws the card the user is actually looking at", () => {
    // The control, and it is a weak one on its own: with every line of gating
    // deleted this still passes. Its job is the other direction — a cap that
    // starved a lone visible card would be a worse bug than the one being
    // fixed, and this is what fails when the gating is inverted or when the
    // visibility signal never arrives.
    withPlanEffect("threads", 1);
    const container = render(planCards(1, "threads"));

    onScreenCards(0);

    expect(
      renderers(container),
      "a tariff card that is on screen and within budget did not mount its " +
        "effect at all — the card shows a bare gradient where the operator " +
        "configured artwork",
    ).toEqual(["0"]);
  });

  it("draws nothing for a card that is off screen", () => {
    withPlanEffect("threads", 2);
    const container = render(planCards(2, "threads"));

    onScreenCards(1);

    expect(
      renderers(container),
      "a card that is NOT on screen mounted a renderer. Being within the cap is " +
        "only half the rule — a long list under the budget would otherwise hold " +
        "a live context for every card in it, on screen or not",
    ).toEqual(["1"]);
  });
});

describe("scrolling a list longer than the budget", () => {
  it("hands a slot on to a card scrolled INTO view", () => {
    const on = CARD_EFFECT_CONTEXT_BUDGET + 2;
    withPlanEffect("threads", on);
    const container = render(planCards(on, "threads"));
    const all = Array.from({ length: on }, (_, index) => index);

    onScreenCards(...all);
    expect(
      renderers(container),
      "precondition: the bottom card must start WITHOUT a slot, or the promotion " +
        "below would be proved by nothing happening",
    ).not.toContain(String(on - 1));

    // The first two scroll off the top; the last two arrive at the bottom.
    onScreenCards(...all.slice(2));

    expect(
      renderers(container),
      "a card scrolled into view was refused a slot that a scrolled-away card " +
        "was no longer using — released claims are not returning to the budget, " +
        "so the bottom of every long list is permanently unanimated",
    ).toEqual(
      Array.from({ length: CARD_EFFECT_CONTEXT_BUDGET }, (_, i) => String(i + 2)),
    );
  });

  it("gives a card its effect back when it is scrolled to again", () => {
    const on = CARD_EFFECT_CONTEXT_BUDGET + 2;
    withPlanEffect("threads", on);
    const container = render(planCards(on, "threads"));
    const all = Array.from({ length: on }, (_, index) => index);

    onScreenCards(...all);
    onScreenCards(...all.slice(2));
    expect(
      renderers(container),
      "precondition: the card must actually have LOST its renderer first, or " +
        "the recovery below is proved by it never having gone away",
    ).not.toContain("0");

    onScreenCards(...all.slice(0, CARD_EFFECT_CONTEXT_BUDGET));

    expect(
      renderers(container),
      "a card that was scrolled away and back never got its effect again — " +
        "the cap has turned into a permanent blank card, which is the failure " +
        "it exists to prevent",
    ).toContain("0");
  });

  it("returns every slot to the budget when the screen goes away", () => {
    const on = CARD_EFFECT_CONTEXT_BUDGET;
    withPlanEffect("threads", on);
    render(planCards(on, "threads"));
    onScreenCards(...Array.from({ length: on }, (_, index) => index));
    expect(cardEffectBudget.grantedCount).toBe(CARD_EFFECT_CONTEXT_BUDGET);

    act(() => {
      for (const { root } of mounted.splice(0)) root.unmount();
    });

    expect(
      cardEffectBudget.grantedCount,
      "navigating away left claims behind — the next screen's cards inherit a " +
        "budget that is already spent and none of them animate",
    ).toBe(0);
  });
});

describe("a plan whose effect is suppressed by its own artwork", () => {
  it("does not hold a slot it is never going to draw with", () => {
    // `tariff-card` renders NO layer when the plan has an uploaded image: the
    // image is the deliberate art and the two would fight. A slot claimed by
    // that card is a context nobody spends, taken from a card that would.
    const on = CARD_EFFECT_CONTEXT_BUDGET + 1;
    const planCardStyles: Record<string, Record<string, unknown>> = {
      "plan-0": { cardEffect: "threads", textureUrl: "https://example.test/a.png" },
    };
    for (let index = 1; index < on; index += 1) {
      planCardStyles[`plan-${index}`] = { cardEffect: "threads" };
    }
    branding.current = {
      branding: { ...DEFAULT_BRANDING, planCardStyles },
      defaultCurrency: "USD",
      customIcons: [],
    };
    const container = render(planCards(on, "threads"));

    onScreenCards(...Array.from({ length: on }, (_, index) => index));

    expect(
      renderers(container),
      "a card that renders no effect layer at all still consumed a slot from " +
        "the context budget, starving a card that had artwork to draw",
    ).toEqual(
      Array.from({ length: CARD_EFFECT_CONTEXT_BUDGET }, (_, i) => String(i + 1)),
    );
  });
});

/* ── what is deliberately NOT rationed ────────────────────────────────────── */

describe("effects that need no GPU context", () => {
  it("lets every visible canvas2d card draw, budget or no budget", () => {
    // 26 of the 54 catalogue effects are canvas2d. They consume nothing from
    // WebKit's WebGL pool, so rationing them would cost visible animation to
    // relieve pressure they do not create.
    const on = CARD_EFFECT_CONTEXT_BUDGET + 4;
    withPlanEffect("waves", on);
    const container = render(planCards(on, "waves"));

    onScreenCards(...Array.from({ length: on }, (_, index) => index));

    expect(
      renderers(container).length,
      `${on} canvas2d cards were on screen and only ${renderers(container).length} ` +
        "drew. Canvas effects hold no WebGL context and must not be counted " +
        "against the context budget.",
    ).toBe(on);
  });

  it("still stops a canvas2d card that is off screen", () => {
    // The exemption hands the decision back to the layer's own observer; it
    // must not become "always on", which would leave every off-screen card in
    // a long list animating.
    const on = 4;
    withPlanEffect("waves", on);
    const container = render(planCards(on, "waves"));

    onScreenCards(0, 1);

    expect(
      renderers(container),
      "an off-screen canvas2d card drew. Exempting an effect from the WebGL " +
        "budget must hand the decision BACK to the layer's own observer, not " +
        "override it with `active={true}` — that is every card in a long list " +
        "animating a canvas off screen, which costs main-thread paint on exactly " +
        "the low-capability devices canvas2d effects were chosen for",
    ).toEqual(["0", "1"]);
  });
});

/* ── the commit in between ────────────────────────────────────────────────── */

/**
 * Everything above reads the DOM after React has settled, which cannot see a
 * commit that was immediately replaced. Releasing a slot happens in an effect
 * CLEANUP, one commit after the card stopped being visible, so between the two
 * there is a render where the card is off screen and still holds a grant. If
 * `active` were read from the grant alone, that render would tell the layer to
 * keep its renderer — a whole commit of extra live context per card, on every
 * scroll, on the screens that have the least context to spare.
 *
 * So this one records what the hook returned on EVERY render instead.
 *
 * `react-doctor/no-ref-current-in-render`'s sibling rule
 * `no-prop-callback-in-render` fires on the `record(...)` call below, and it is
 * right about the shape: a prop callback invoked during render. It is also the
 * only way to observe the thing under test. A render-phase value cannot be read
 * from an effect — by then the commit has already happened and the question
 * ("did it stop asking in the SAME commit?") has been answered off-screen. The
 * rule is reported against test files but does not block, so this stays as is;
 * do not "fix" it by moving the call into an effect, which would silently turn
 * every assertion below into one about the following commit.
 */
function SlotProbe({
  effect,
  record,
}: {
  readonly effect: string;
  readonly record: (active: boolean | undefined) => void;
}) {
  const slot = useCardEffectSlot(effect);
  record(slot.active);
  return <div ref={slot.ref} data-card-index="0" />;
}

describe("a card leaving the screen", () => {
  it("stops asking for a renderer in the same commit, not the one after", () => {
    const seen: Array<boolean | undefined> = [];
    render(<SlotProbe effect="threads" record={(active) => seen.push(active)} />);

    onScreenCards(0);
    expect(seen.at(-1), "precondition: the card must be drawing first").toBe(true);

    seen.length = 0;
    onScreenCards();

    expect(
      seen,
      "after the card left the screen the hook still reported active=true for a " +
        "commit — the layer keeps its WebGL context for that commit, so a fast " +
        "scroll holds more live contexts than the budget allows",
    ).not.toContain(true);
  });

  it("does not carry an old observer's answer into a new one", () => {
    // The operator's `cardEffect` can change under a mounted card, and a
    // canvas2d value in between tears the observer down — canvas2d is not
    // rationed, so it needs none. Coming back to a WebGL effect builds a fresh
    // observer that has not reported anything yet. Claiming a slot on the
    // previous observer's last word takes it from a card that can prove it is
    // on screen and gives it to one that cannot.
    const seen: Array<boolean | undefined> = [];
    const record = (active: boolean | undefined) => seen.push(active);
    const container = render(<SlotProbe effect="threads" record={record} />);
    onScreenCards(0);
    expect(seen.at(-1), "precondition: the card must be drawing first").toBe(true);

    const root = mounted.at(-1)!.root;
    act(() => root.render(<SlotProbe effect="waves" record={record} />));
    seen.length = 0;
    act(() => root.render(<SlotProbe effect="threads" record={record} />));

    expect(container.isConnected).toBe(true);
    expect(
      seen.at(-1),
      "a card claimed a context slot on a visibility answer from an observer " +
        "that had already been disconnected — nothing currently watching the " +
        "card had said it was on screen",
    ).toBe(false);
  });
});

/* ── the second call site ─────────────────────────────────────────────────── */

describe("the subscription picker", () => {
  it("caps its renderers too — these tiles are the worst case, not the plans", () => {
    const on = CARD_EFFECT_CONTEXT_BUDGET + 6;
    withGlobalEffect("threads");
    const container = render(subscriptionCards(on));

    onScreenCards(...Array.from({ length: on }, (_, index) => index));

    expect(
      renderers(container).length,
      `${on} subscription tiles were on screen and ${renderers(container).length} ` +
        `WebGL renderers mounted. Every tile draws the operator's ONE global ` +
        `cardEffect, so unlike the tariff catalogue there is no per-card opt-out ` +
        `— the whole list is contexts. Budget is ${CARD_EFFECT_CONTEXT_BUDGET}.`,
    ).toBe(CARD_EFFECT_CONTEXT_BUDGET);
  });

  it("still draws the tile the user is looking at", () => {
    withGlobalEffect("threads");
    const container = render(subscriptionCards(1));

    onScreenCards(0);

    expect(
      renderers(container),
      "a visible subscription tile did not mount its effect — the picker no " +
        "longer mirrors the dashboard card it advertises itself as mirroring",
    ).toEqual(["0"]);
  });
});

describe("a render target with no IntersectionObserver", () => {
  it("still draws, rather than treating 'cannot ask' as 'not visible'", () => {
    // The hook's observer REPLACES the layer's for rationed effects, so if it
    // has no observer to build and defaults to "not visible", every WebGL card
    // on such a target is blank — a stricter outcome than the pre-budget code,
    // which is not an acceptable thing for a cap to do. The budget still caps;
    // it just starts from the pre-budget answer.
    vi.stubGlobal("IntersectionObserver", undefined);
    withPlanEffect("threads", 1);

    const container = render(planCards(1, "threads"));
    act(() => undefined);

    expect(
      renderers(container),
      "with no IntersectionObserver to consult, the card was treated as off " +
        "screen and drew nothing at all — 'we cannot tell' was turned into " +
        "'no', which blanks every WebGL card on that target",
    ).toEqual(["0"]);
  });
});

/* ── both surfaces at once ────────────────────────────────────────────────── */

describe("a subscription picker and a tariff catalogue in one document", () => {
  it("spends ONE budget between them, because WebKit counts per process", () => {
    // Not hypothetical: `renewal-page.tsx` owns both, and a route transition
    // can have an outgoing screen's cards mounted alongside an incoming
    // screen's. Two budgets of six would each be within their means while the
    // web-content process was asked for twelve contexts — which is the failure
    // this whole mechanism exists to prevent, reintroduced by bookkeeping.
    const each = CARD_EFFECT_CONTEXT_BUDGET;
    const planCardStyles: Record<string, { cardEffect: string }> = {};
    for (let index = 0; index < each; index += 1) {
      planCardStyles[`plan-${index}`] = { cardEffect: "threads" };
    }
    branding.current = {
      branding: { ...DEFAULT_BRANDING, cardEffect: "threads", planCardStyles },
      defaultCurrency: "USD",
      customIcons: [],
    };
    const container = render(
      <>
        {planCards(each, "threads", "p")}
        {subscriptionCards(each, "s")}
      </>,
    );

    const keys = [
      ...Array.from({ length: each }, (_, index) => `p${index}`),
      ...Array.from({ length: each }, (_, index) => `s${index}`),
    ];
    onScreenCards(...keys);
    expect(
      renderers(container).length,
      "precondition: both lists must be on screen and asking",
    ).toBeGreaterThan(0);

    expect(
      renderers(container).length,
      `${each} tariff cards and ${each} subscription tiles were on screen ` +
        `together and ${renderers(container).length} WebGL renderers mounted. ` +
        `The budget is ${CARD_EFFECT_CONTEXT_BUDGET} for the whole document — a ` +
        `per-list budget lets each surface stay within its means while the ` +
        `web-content process runs out of contexts.`,
    ).toBe(CARD_EFFECT_CONTEXT_BUDGET);
  });
});

/* ── the app being switched away from ─────────────────────────────────────── */

/**
 * A Telegram mini-app is backgrounded constantly, so this is the most-travelled
 * path here, not an edge case.
 *
 * The LAYER unmounts on hide — its own decision, and the right one: it hands
 * the GPU context back for as long as the user is elsewhere. The BUDGET
 * deliberately does not follow it. The slot is held across the absence, so the
 * card returns to the one it already had; nothing else could have used it
 * meanwhile because every other card is hidden too.
 *
 * What that buys is stated by the second test. An IntersectionObserver does not
 * re-deliver an entry because the page came back, so a hook that cleared its own
 * visibility on hide would then be waiting for a callback that never arrives.
 */
describe("the page being hidden and shown again", () => {
  function drawnCardWithHiddenPage(): HTMLDivElement {
    withPlanEffect("threads", 1);
    const container = render(planCards(1, "threads"));
    onScreenCards(0);
    expect(renderers(container), "precondition: the card must be drawing").toEqual(["0"]);

    setPageHidden(true);
    expect(
      renderers(container),
      "precondition: hiding the page must tear the renderer down, or neither " +
        "test below is about a card that went away",
    ).toEqual([]);
    return container;
  }

  it("keeps the slot while the page is hidden", () => {
    drawnCardWithHiddenPage();

    expect(
      cardEffectBudget.grantedCount,
      "the slot was given up while the page was hidden. Nothing can spend it " +
        "while the app is in the background, and on return the card has to " +
        "re-queue behind every card that did not give one up",
    ).toBe(1);
  });

  it("gives the renderer back without the observer having to speak again", () => {
    const container = drawnCardWithHiddenPage();

    setPageHidden(false);

    expect(
      renderers(container),
      "a card that was drawing before the user switched away never drew again " +
        "on return. One background/foreground cycle blanks it permanently — " +
        "no IntersectionObserver will re-deliver an entry to un-blank it",
    ).toEqual(["0"]);
  });
});
