// @vitest-environment jsdom

/**
 * Keeping the next card's renderer alive.
 *
 * The carousel gave exactly one slide a live renderer, so every swipe tore one
 * down and built the next from nothing. `card-effect-reveal-memory.test.tsx`
 * covers the half of that cost the release added — a fresh 420 ms crossfade on
 * every swipe — and removes it. This file covers the half that was always
 * there: a new GL context, a new shader compile, and the frames before either
 * produces a pixel, all while the user is already looking at the card.
 *
 * The answer is to warm the immediate neighbours, and the reason it is safe is
 * the SHARED budget. WebKit allows 16 live contexts per web-content process and
 * the seventeenth request hands an existing one an unrecoverable
 * `SyntheticLostContext`; `card-effect-budget.ts` bounds the document at six.
 * A warm card asks that same budget, so warming can only take slots from other
 * budgeted cards — it can never raise the ceiling. The selected slide asks for
 * nothing, because the queue is first-come-first-served with no revocation and
 * the one card the user is actually looking at must not be refusable.
 *
 * WHAT THIS FILE CANNOT SEE. jsdom has no WebGL and no layout: `getContext` is
 * stubbed and a stub costs nothing. What it observes is the renderer COMPONENT
 * in the DOM — the thing that owns the context in production — and the
 * `active` decision that governs it. Read every count as "renderers mounted",
 * never as "contexts alive".
 */

import {
  act,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ── the drawing components, without `ogl`/`three` ─────────────────────────── */

vi.mock("../src/components/reactbits/card-effect-manifest", async () => {
  // The REAL catalogue, so `threads` is still WebGL1 and `waves` is still
  // canvas2d. The budget reads that classification from the catalogue, and
  // faking it would make the canvas2d exemption untestable.
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

vi.mock("@/components/ui/card-watermark", () => ({
  CardWatermark: () => null,
}));

/* ── everything the carousel drags in that is not under test ──────────────── */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("motion/react", () => ({
  useReducedMotion: () => false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
}));

vi.mock("@/components/ui/custom-icon-view", () => ({
  CustomIconView: () => null,
}));
vi.mock("@/components/ui/emoji-text", () => ({ EmojiText: () => null }));

const branding = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => branding.current,
}));

vi.mock(
  "../src/features/dashboard/components/delete-subscription-dialog",
  () => ({ DeleteSubscriptionDialog: () => null }),
);

vi.mock(
  "../src/features/dashboard/components/subscription-creation-motion",
  () => ({ SubscriptionCreationMotion: () => null }),
);

vi.mock(
  "../src/features/dashboard/components/subscription-deletion-motion",
  () => ({
    SubscriptionDeletionMotion: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  }),
);

/**
 * The seam the carousel's decision lands on — WRAPPED, not replaced.
 *
 * Recording the props makes "which slides are neighbours" directly assertable,
 * which a count of renderers cannot do: the selected slide draws whether or not
 * the carousel wrongly also called it warm. Delegating to the real component
 * keeps the rest of the chain under test — card → frame → budget → layer — so
 * that dropping the forward at any link fails something. A stub in its place
 * left that whole chain unasserted, and a deleted forward survived.
 */
const cardProps = vi.hoisted(
  () => [] as Array<{ key: string; active: boolean; warm: boolean }>,
);

vi.mock("../src/features/dashboard/components/subscription-card", async () => {
  const actual = await vi.importActual<
    typeof import("../src/features/dashboard/components/subscription-card")
  >("../src/features/dashboard/components/subscription-card");
  return {
    ...actual,
    SubscriptionCard: (
      props: Parameters<typeof actual.SubscriptionCard>[0],
    ) => {
      cardProps.push({
        key: props.subscription.id,
        active: props.effectActive === true,
        warm: props.effectWarm === true,
      });
      return <actual.SubscriptionCard {...props} />;
    },
  };
});

import {
  CARD_EFFECT_CONTEXT_BUDGET,
  cardEffectBudget,
  createCardEffectBudget,
  useCardEffectWarmSlot,
} from "../src/lib/card-effect-budget";
import { SubscriptionCarousel } from "../src/features/dashboard/components/subscription-carousel";
import { SubscriptionCardFrame } from "../src/features/dashboard/components/subscription-card-frame";
import { resolveSubscriptionCardVisual } from "../src/features/dashboard/components/subscription-card-visual";
import { DEFAULT_BRANDING } from "../src/types/branding";

/* ── rendering ────────────────────────────────────────────────────────────── */

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return {
    container,
    show: (next: ReactElement) => act(() => root.render(next)),
  };
}

beforeEach(() => {
  cardProps.length = 0;
  branding.current = {
    branding: { ...DEFAULT_BRANDING, cardEffect: "threads" },
    customIcons: [],
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  // jsdom implements neither scroll-snap nor `scrollTo`; the carousel corrects
  // its own scroll position on every selection change.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: () => undefined,
    writable: true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) => {
      if (kind === "webgl" || kind === "webgl2") {
        return {
          getExtension: () => ({ loseContext: () => undefined }),
          isContextLost: () => false,
        };
      }
      // A canvas2d effect is watched by `observeCardEffectCanvases`, which
      // treats a refused 2d context as a renderer that failed to start. jsdom
      // refuses one by default, so without this every canvas2d card would fall
      // back to CSS and the exemption below would be testing nothing.
      return kind === "2d"
        ? {
            drawImage: () => undefined,
            getImageData: () => ({ data: new Uint8ClampedArray(256) }),
          }
        : null;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(() => {
  act(() => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted.splice(0)) container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ── which slides the carousel asks to be warmed ──────────────────────────── */

function items(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    kind: "subscription" as const,
    key: `subscription:sub-${index}`,
    slotIndex: index,
    subscription: {
      id: `sub-${index}`,
      status: "ACTIVE",
      profileName: `Sub ${index}`,
      userRemnaId: `remna-${index}`,
      plan: null,
      trafficUsed: null,
      trafficLimit: null,
      deviceLimit: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
      expireAt: null,
    } as never,
  }));
}

function carousel(count: number, activeIndex: number): ReactElement {
  return (
    <SubscriptionCarousel
      items={items(count)}
      activeItemKey={`subscription:sub-${activeIndex}`}
      onActiveItemKeyChange={() => undefined}
      onProvisioningComplete={() => undefined}
    />
  );
}

/** The last decision the carousel made for each card, in slide order. */
function lastDecisions(): Array<{ active: boolean; warm: boolean }> {
  const byKey = new Map<string, { active: boolean; warm: boolean }>();
  for (const entry of cardProps) {
    byKey.set(entry.key, { active: entry.active, warm: entry.warm });
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

/** Which slides ended up with a renderer, by slide key, through the real chain. */
function slidesDrawing(container: HTMLDivElement): readonly string[] {
  return [...container.querySelectorAll("[data-test-effect]")].map(
    (node) =>
      node
        .closest("[data-carousel-item-key]")
        ?.getAttribute("data-carousel-item-key") ?? "?",
  );
}

describe("which slides the carousel keeps warm", () => {
  it("has the neighbours actually drawing, all the way through the real card", () => {
    // End to end on purpose. The decision travels carousel → SubscriptionCard →
    // SubscriptionCardFrame → budget → CardEffectLayer, and every one of those
    // links has to forward it. Asserting the carousel's props alone let a
    // deleted forward halfway down survive with every test still green.
    const { container } = render(carousel(4, 1));

    expect(slidesDrawing(container)).toEqual([
      "subscription:sub-0",
      "subscription:sub-1",
      "subscription:sub-2",
    ]);
  });

  it("asks for the slide either side of the selected one", () => {
    render(carousel(4, 1));

    expect(lastDecisions()).toEqual([
      { active: false, warm: true },
      { active: true, warm: false },
      { active: false, warm: true },
      { active: false, warm: false },
    ]);
  });

  it("asks for nothing beyond the neighbours, however long the list", () => {
    // A subscriber with twenty subscriptions must not warm twenty renderers.
    // "Neighbour" is a distance from the selected slide, not a share of the
    // list, so the count does not move.
    render(carousel(20, 10));

    expect(lastDecisions().filter((decision) => decision.warm)).toHaveLength(2);
  });

  it("moves the warm pair with the selection", () => {
    const { show } = render(carousel(4, 1));
    cardProps.length = 0;

    show(carousel(4, 2));

    expect(lastDecisions()).toEqual([
      { active: false, warm: false },
      { active: false, warm: true },
      { active: true, warm: false },
      { active: false, warm: true },
    ]);
  });

  it("never asks for the selected slide, which is not the budget's to refuse", () => {
    render(carousel(3, 0));

    expect(lastDecisions()[0]).toEqual({ active: true, warm: false });
  });
});

/* ── what a warm card actually does ───────────────────────────────────────── */

function visualFor(effect: string) {
  return resolveSubscriptionCardVisual({
    ...DEFAULT_BRANDING,
    cardEffect: effect as never,
  });
}

function frames(
  effect: string,
  states: ReadonlyArray<{ active: boolean; warm: boolean }>,
): ReactElement {
  const visual = visualFor(effect);
  return (
    <>
      {states.map((state, index) => (
        <div key={index} data-card-index={index}>
          <SubscriptionCardFrame
            visual={visual}
            effectActive={state.active}
            effectWarm={state.warm}
          />
        </div>
      ))}
    </>
  );
}

const drawing = (container: HTMLDivElement): readonly string[] =>
  [...container.querySelectorAll("[data-test-effect]")].map(
    (node) =>
      node.closest("[data-card-index]")?.getAttribute("data-card-index") ?? "?",
  );

describe("a card the carousel asked to keep warm", () => {
  it("has its renderer running before the user swipes to it", () => {
    // The whole point: the swipe finds a renderer that is already up, so there
    // is no context to create, no shader to compile and nothing to fade in.
    const { container } = render(
      frames("threads", [
        { active: true, warm: false },
        { active: false, warm: true },
        { active: false, warm: false },
      ]),
    );

    expect(drawing(container)).toEqual(["0", "1"]);
  });

  it("stops drawing the moment it stops being a neighbour", () => {
    // Otherwise a warm claim outlives the card that wanted it, and the slot it
    // holds is one a visible card cannot have.
    const { container, show } = render(
      frames("threads", [
        { active: true, warm: false },
        { active: false, warm: true },
      ]),
    );
    expect(drawing(container)).toEqual(["0", "1"]);

    show(
      frames("threads", [
        { active: true, warm: false },
        { active: false, warm: false },
      ]),
    );

    expect(drawing(container)).toEqual(["0"]);
  });

  it("yields to the shared budget rather than adding to the ceiling", () => {
    // Six budgeted cards elsewhere in the document have taken every slot. The
    // warm neighbour asks, is refused, and simply does not draw — which is the
    // pre-warm behaviour, not a new failure.
    const releases = Array.from(
      { length: CARD_EFFECT_CONTEXT_BUDGET },
      () => cardEffectBudget.claim(() => undefined),
    );
    try {
      const { container } = render(
        frames("threads", [
          { active: true, warm: false },
          { active: false, warm: true },
        ]),
      );

      expect(drawing(container)).toEqual(["0"]);
    } finally {
      for (const release of releases) release();
    }
  });

  it("does not let a spent budget silence the card the user is looking at", () => {
    // The selected slide never asks, so it cannot be refused. A budget that
    // could starve it would leave the user staring at a card with no artwork
    // and no way to get it back.
    const releases = Array.from(
      { length: CARD_EFFECT_CONTEXT_BUDGET },
      () => cardEffectBudget.claim(() => undefined),
    );
    try {
      const { container } = render(
        frames("threads", [{ active: true, warm: false }]),
      );

      expect(drawing(container)).toEqual(["0"]);
    } finally {
      for (const release of releases) release();
    }
  });

  it("draws a canvas effect without spending a slot on it", () => {
    // 26 of the 54 catalogue entries are canvas2d and cost no GPU context.
    // Rationing them would trade visible animation for pressure they do not
    // create.
    const releases = Array.from(
      { length: CARD_EFFECT_CONTEXT_BUDGET },
      () => cardEffectBudget.claim(() => undefined),
    );
    try {
      const { container } = render(
        frames("waves", [
          { active: true, warm: false },
          { active: false, warm: true },
        ]),
      );

      expect(drawing(container)).toEqual(["0", "1"]);
      expect(cardEffectBudget.grantedCount).toBe(CARD_EFFECT_CONTEXT_BUDGET);
    } finally {
      for (const release of releases) release();
    }
  });

  it("gives its slot back when the card leaves the document", () => {
    const budget = createCardEffectBudget(2);
    function Warm({ wanted }: { readonly wanted: boolean }) {
      const granted = useCardEffectWarmSlot("threads", wanted, budget);
      return <span data-test-warm={granted ? "yes" : "no"} />;
    }
    const { container, show } = render(<Warm wanted />);
    expect(budget.grantedCount).toBe(1);

    show(<Warm wanted={false} />);
    expect(budget.grantedCount).toBe(0);
    expect(
      container.querySelector("[data-test-warm]")?.getAttribute("data-test-warm"),
    ).toBe("no");

    act(() => {
      for (const { root } of mounted.splice(0)) root.unmount();
    });
    expect(budget.grantedCount).toBe(0);
  });
});
