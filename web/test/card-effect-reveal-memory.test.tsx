// @vitest-environment jsdom

/**
 * Swiping the subscription carousel.
 *
 * The reveal fade — `CARD_EFFECT_REVEAL_MS` in `card-effect-layer.tsx` — was
 * built for the FIRST time a card shows its artwork: the complaint was that the
 * effect arrived between two frames 50 ms apart, with nothing in between. What it
 * actually did was fire on every activation — and the carousel deactivates the
 * slide you swipe away from and activates the one you swipe to, so both cards
 * paid it, both ways, for ever.
 *
 * Measured on the shipped code, with the lazy chunk already in the module cache
 * and the capability snapshot already taken (which is the state every swipe
 * after the first is in): one frame to schedule the reveal, then the whole
 * 420 ms transition from opacity 0. Nothing else contributed — the renderer was
 * committed and `data-card-effect-ready` was already `true` in the same commit
 * the slide became active. So the reveal was not part of the gap, it WAS the
 * gap, and the card showed the operator's flat gradient and watermark for all
 * of it. That is the report: "the animation disappears to a static card".
 *
 * The fix is a memory, not a deletion. A presentation that was on screen a
 * moment ago comes back with no transition at all; one the user has not seen —
 * or has not seen for a long time, or that the operator has changed since —
 * still fades. Both halves are asserted here, because a fix that snapped
 * everything in would restore the original complaint instead.
 *
 * WHAT THIS FILE CANNOT SEE. jsdom runs no transitions and has no WebGL. What
 * it observes is the inline style React committed — the opacity the browser is
 * being told to paint, and whether there is a `transition` for it to animate
 * along — plus whether the renderer component is in the DOM. Read every
 * assertion as "what the browser was told", never as "what was painted".
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `suspend` holds the renderer out of the commit the way an unresolved
 * `React.lazy` chunk does. It is the lever that separates "the reveal was
 * shortened" from "the readiness handshake was skipped".
 */
const control = vi.hoisted(() => ({
  suspend: false,
  pending: new Promise<void>(() => undefined),
  mounts: 0,
}));

vi.mock("../src/components/reactbits/card-effect-manifest", async () => {
  // The real catalogue, so `threads` is still a WebGL1 effect and the
  // capability probe below is genuinely on the path. Only the drawing
  // component is swapped — the real one pulls `ogl` in.
  const catalog = await vi.importActual<
    typeof import("../src/components/reactbits/card-effect-catalog")
  >("../src/components/reactbits/card-effect-catalog");
  const renderer = () => {
    if (control.suspend) throw control.pending;
    control.mounts += 1;
    return <canvas data-test-effect />;
  };
  return {
    CARD_EFFECT_COMPONENTS: new Proxy(
      {},
      { get: (_target, key) => (typeof key === "string" ? renderer : undefined) },
    ),
    isKnownCardEffect: catalog.isKnownCardEffect,
    cardEffectDefaults: catalog.cardEffectDefaults,
  };
});

import {
  CARD_EFFECT_REVEAL_MEMORY_MS,
  CARD_EFFECT_REVEAL_MS,
  CardEffectLayer,
} from "../src/components/reactbits/card-effect-layer";

/* ── a driveable animation frame and clock ────────────────────────────────── */

let clock = 0;
let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

/** Run every frame queued so far. Frames queued BY them wait for the next call. */
function flushFrame(): void {
  const queued = [...frames.entries()];
  frames = new Map();
  clock += 16;
  act(() => {
    for (const [, callback] of queued) callback(clock);
  });
}

/** Everything settles: the probe frame, the reveal frame, and their commits. */
function settle(): void {
  for (let round = 0; round < 4; round += 1) flushFrame();
}

/* ── rendering ────────────────────────────────────────────────────────────── */

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
let webglContexts = 0;

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

const wrapper = (container: HTMLDivElement): HTMLElement | null =>
  container.querySelector<HTMLElement>("[data-card-effect-source]");

/** What the browser has been told to paint the effect layer at, right now. */
const opacity = (container: HTMLDivElement): string | undefined =>
  wrapper(container)?.style.opacity;

/** Whether there is anything for the browser to animate along. */
const transition = (container: HTMLDivElement): string | undefined =>
  wrapper(container)?.style.transition;

const phase = (container: HTMLDivElement): string | null | undefined =>
  wrapper(container)?.getAttribute("data-card-effect-reveal");

const renderer = (container: HTMLDivElement): Element | null =>
  container.querySelector("[data-test-effect]");

const ready = (container: HTMLDivElement): string | null | undefined =>
  wrapper(container)?.getAttribute("data-card-effect-ready");

beforeEach(() => {
  clock = 0;
  nextFrameId = 1;
  frames = new Map();
  webglContexts = 0;
  control.suspend = false;
  control.mounts = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) => {
      if (kind !== "webgl" && kind !== "webgl2") return null;
      webglContexts += 1;
      return {
        getExtension: () => ({ loseContext: () => undefined }),
        isContextLost: () => false,
      };
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(() => {
  act(() => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted.splice(0)) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a card the user is seeing for the first time", () => {
  it("is transparent until a renderer has committed", () => {
    const { container } = render(<CardEffectLayer effect="threads" active />);

    expect(opacity(container)).toBe("0");
  });

  it("fades in rather than appearing between two frames", () => {
    const { container } = render(<CardEffectLayer effect="threads" active />);
    settle();

    expect(opacity(container)).toBe("1");
    expect(phase(container)).toBe("fade");
    expect(transition(container)).toContain(`${CARD_EFFECT_REVEAL_MS}ms`);
  });
});

/**
 * How long a real swipe takes before the incoming slide is declared active:
 * a flick, its momentum, `scrollend` or the 120 ms idle debounce behind it.
 * One second is generous rather than pessimistic, and it is here so the memory
 * window cannot be tuned down to something no real swipe fits inside while the
 * tests stay green.
 */
const SWIPE_MS = 1_000;

describe("a card the user swipes back to", () => {
  /** Reveal the card, then swipe away — the state every swipe-back starts from. */
  function revealThenLeave(props: Record<string, unknown> = {}) {
    const handle = render(
      <CardEffectLayer effect="threads" props={props} active />,
    );
    settle();
    expect(opacity(handle.container)).toBe("1");
    handle.show(<CardEffectLayer effect="threads" props={props} active={false} />);
    expect(renderer(handle.container)).toBeNull();
    clock += SWIPE_MS;
    return handle;
  }

  it("is already drawing when the swipe lands, with no static gap to sit through", () => {
    const { container, show } = revealThenLeave();

    show(<CardEffectLayer effect="threads" active />);

    // No frame is flushed on purpose: this is the commit the swipe produces.
    // A card that needs a frame here is a card showing the operator's flat
    // gradient while the browser gets round to starting the fade.
    expect(renderer(container)).not.toBeNull();
    expect(opacity(container)).toBe("1");
    expect(phase(container)).toBe("instant");
  });

  it("has nothing left for the browser to animate along", () => {
    // Separate from the assertion above, and not redundant with it. The layer
    // really did paint at opacity 0 while it was torn down, so leaving the
    // 420 ms transition in place would run the whole fade anyway — the
    // committed opacity would read "1" the entire time and the user would
    // still watch the static card.
    const { container, show } = revealThenLeave();

    show(<CardEffectLayer effect="threads" active />);

    expect(transition(container)).toBe("none");
  });

  it("still waits for a renderer to commit: the memory shortens the reveal, not the handshake", () => {
    // The trap the readiness key was cleared to avoid, approached from the
    // other side. Skipping the fade must not become skipping the evidence:
    // with the chunk held out of the commit there is nothing on the card, and
    // declaring it revealed would fade in an empty layer.
    const { container, show } = revealThenLeave();
    control.suspend = true;

    show(<CardEffectLayer effect="threads" active />);

    expect(renderer(container)).toBeNull();
    expect(ready(container)).toBe("false");
    expect(opacity(container)).toBe("0");
  });

  it("does not buy a new GPU context for every swipe", () => {
    // The probe opens a real `webgl2` context and WebKit frees it
    // asynchronously. Re-asking on every activation spends one of sixteen per
    // swipe on a question already answered.
    const { show } = revealThenLeave();
    const afterFirst = webglContexts;

    for (let swipe = 0; swipe < 5; swipe += 1) {
      show(<CardEffectLayer effect="threads" active />);
      settle();
      show(<CardEffectLayer effect="threads" active={false} />);
      settle();
    }

    expect(webglContexts - afterFirst).toBe(0);
  });

  it("still gets a renderer after being swiped past before its probe landed", () => {
    // The probe's frame is cancellable. A "already probed" flag set before it
    // fired would leave this card without capabilities for ever, and a card
    // with no capabilities never resolves a runtime — permanently no effect.
    const { container, show } = render(
      <CardEffectLayer effect="threads" active={false} />,
    );
    show(<CardEffectLayer effect="threads" active />);
    show(<CardEffectLayer effect="threads" active={false} />);
    flushFrame();

    show(<CardEffectLayer effect="threads" active />);
    settle();

    expect(renderer(container)).not.toBeNull();
    expect(opacity(container)).toBe("1");
  });
});

describe("a reveal the card has not earned", () => {
  it("fades again after a long absence, because the artwork is new again", () => {
    const handle = render(<CardEffectLayer effect="threads" active />);
    settle();
    handle.show(<CardEffectLayer effect="threads" active={false} />);
    clock += CARD_EFFECT_REVEAL_MEMORY_MS + 1;

    handle.show(<CardEffectLayer effect="threads" active />);

    expect(phase(handle.container)).toBe("hidden");
    expect(opacity(handle.container)).toBe("0");
    flushFrame();
    expect(phase(handle.container)).toBe("fade");
  });

  it("fades when the operator changed the artwork while the card was away", () => {
    const handle = render(
      <CardEffectLayer effect="threads" props={{ amplitude: 1 }} active />,
    );
    settle();
    handle.show(
      <CardEffectLayer effect="threads" props={{ amplitude: 1 }} active={false} />,
    );

    handle.show(
      <CardEffectLayer effect="threads" props={{ amplitude: 3 }} active />,
    );

    expect(opacity(handle.container)).toBe("0");
    flushFrame();
    expect(phase(handle.container)).toBe("fade");
  });

  it("does not remember a presentation that was never actually shown", () => {
    // Ready for one commit and gone again — a slide swiped straight past.
    // Nothing was on screen, so the next time this card is reached it is still
    // a first appearance and still fades.
    const { container, show } = render(
      <CardEffectLayer effect="threads" active={false} />,
    );
    show(<CardEffectLayer effect="threads" active />);
    flushFrame(); // capability snapshot; the renderer commits, the reveal does not
    expect(ready(container)).toBe("true");
    expect(phase(container)).toBe("hidden");
    show(<CardEffectLayer effect="threads" active={false} />);

    show(<CardEffectLayer effect="threads" active />);

    expect(opacity(container)).toBe("0");
    flushFrame();
    expect(phase(container)).toBe("fade");
  });
});
