// @vitest-environment jsdom

/**
 * A lost context that CAN come back must come back.
 *
 * WHAT WENT WRONG. `observeCardEffectCanvases` treated every `webglcontextlost`
 * as permanent. It never called `event.preventDefault()` — and per the WebGL
 * spec that is the only thing that asks the user agent to restore a context, so
 * without it `webglcontextrestored` can never fire at all — and it never
 * listened for the restore either. The loss went straight to `markRuntimeFailed`,
 * `resolveCardEffectRuntime` turns any failure count above zero into
 * `css-fallback`, and the scope's failure state is keyed by effect + props, so
 * it never cleared. One transient GPU event — sleep/wake, a driver reset, a tab
 * restored from the background, WebKit recycling a context under its cap — left
 * the card a static gradient until the page was reloaded. That is the permanent
 * half of "анимации карт пропадают на статическую карту".
 *
 * WHY THE FAILURE HAD TO BECOME DEFERRED RATHER THAN WITHDRAWN. Reporting the
 * failure first and undoing it on restore is not available: `css-fallback`
 * unmounts the effect, which takes the canvas — and with it the only thing that
 * could ever hear `webglcontextrestored` — out of the document. So the loss is
 * held for `CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS` and only then counted.
 *
 * WHAT MUST STILL HOLD, and is asserted below beside the recovery:
 *  - a loss that never comes back still reaches `css-fallback`. The backstop was
 *    not softened, only delayed;
 *  - a restore is not free. The rebuild budget is spent, and a device that keeps
 *    losing and restoring falls back instead of rebuilding for ever — each turn
 *    of such a loop allocates another context under WebKit's sixteen;
 *  - this app's OWN `loseContext()` teardown is not mistaken for a fault. Every
 *    effect ends its cleanup by destroying its context, the event arrives one
 *    task later, and a canvas that has left the document must neither be
 *    `preventDefault`ed (that would ask the browser to restore a slot we are
 *    deliberately giving up) nor reported.
 *
 * WHAT IS NOT COVERED. Whether a real browser fires `webglcontextrestored` after
 * `preventDefault()` — that is the spec's contract and jsdom has no WebGL, so
 * the event is dispatched by hand here. And whether the components that carry
 * their own restore handling (`Plasma`, `Grainient`, `CosmicOrb`, the three
 * fiber effects) survive being remounted underneath their own recovery: they are
 * discarded wholesale by the key change, which is safe by construction rather
 * than by test.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/reactbits/card-effect-manifest", () => {
  const components = {
    threads: () => <canvas data-test-effect />,
  };
  const defaults: Record<string, Record<string, unknown>> = { threads: {} };
  return {
    CARD_EFFECT_COMPONENTS: components,
    CARD_EFFECT_DEFAULTS: defaults,
    isKnownCardEffect: (id: string) => Object.hasOwn(components, id),
    cardEffectDefaults: (id: string) =>
      Object.hasOwn(defaults, id) ? defaults[id] : {},
  };
});

import { CardEffectLayer } from "../src/components/reactbits/card-effect-layer";
import {
  CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS,
  observeCardEffectCanvases,
} from "../src/components/reactbits/card-effect-layer-utils";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function renderIntoDom(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

function runtimeMode(container: HTMLElement): string | null | undefined {
  return container
    .querySelector("[data-card-effect-source]")
    ?.getAttribute("data-card-effect-runtime");
}

function effectCanvas(container: HTMLElement): HTMLCanvasElement | null {
  return container.querySelector<HTMLCanvasElement>("[data-test-effect]");
}

/** A `webglcontextlost`/`restored` pair shaped like the browser's: cancelable. */
function dispatch(target: EventTarget, type: string): Event {
  const event = new Event(type, { cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }),
    isContextLost: () => false,
  } as unknown as WebGL2RenderingContext);
  // Only the clock the grace window runs on. Vitest's fake timers otherwise
  // take over `requestAnimationFrame` as well, displacing the synchronous stub
  // the layer's capability probe needs to get past.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a restorable context loss", () => {
  it("is preventDefault-ed, which is what lets the browser restore it", () => {
    const container = renderIntoDom(<CardEffectLayer effect="threads" active />);
    const canvas = effectCanvas(container);
    expect(canvas).not.toBeNull();

    const lost = dispatch(canvas!, "webglcontextlost");

    expect(
      lost.defaultPrevented,
      "the loss was not preventDefault-ed. Per the WebGL spec the user agent " +
        "then never restores the context and never fires " +
        "`webglcontextrestored`, so the card is static for the rest of the " +
        "session no matter what else listens",
    ).toBe(true);
  });

  it("does not fail the card while the restore is still possible", () => {
    const container = renderIntoDom(<CardEffectLayer effect="threads" active />);
    dispatch(effectCanvas(container)!, "webglcontextlost");

    expect(runtimeMode(container)).toBe("native");

    act(() =>
      vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS - 1),
    );
    expect(runtimeMode(container)).toBe("native");
  });

  it("rebuilds the renderer when the context comes back", () => {
    const container = renderIntoDom(<CardEffectLayer effect="threads" active />);
    const before = effectCanvas(container);

    dispatch(before!, "webglcontextlost");
    dispatch(before!, "webglcontextrestored");

    // Past the window the loss would have failed in — nothing is left pending.
    act(() =>
      vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 2),
    );

    expect(
      runtimeMode(container),
      "the card fell back although the context was restored — a restorable " +
        "loss is being counted as a permanent failure",
    ).toBe("native");

    const after = effectCanvas(container);
    expect(after).not.toBeNull();
    expect(
      after === before,
      "the renderer was not rebuilt. A restored context is not the one the " +
        "effect was drawing with: every GL handle it holds was detached by the " +
        "loss, so re-rendering the same instance leaves a live context over a " +
        "dead scene",
    ).toBe(false);
  });

  it("still reaches the CSS fallback when nothing comes back", () => {
    const container = renderIntoDom(<CardEffectLayer effect="threads" active />);
    dispatch(effectCanvas(container)!, "webglcontextlost");

    act(() => vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS));

    expect(
      runtimeMode(container),
      "an unrecoverable loss — WebKit's SyntheticLostContext, which its own " +
        "source marks unrecoverable — no longer reaches the fallback at all",
    ).toBe("css-fallback");
  });

  it("stops rebuilding once the budget is spent", () => {
    const container = renderIntoDom(<CardEffectLayer effect="threads" active />);

    // Two restores are granted; the third loss/restore pair must fall back
    // rather than allocate another context on a device that is thrashing.
    for (let round = 0; round < 2; round += 1) {
      const canvas = effectCanvas(container);
      expect(canvas, `round ${round} lost its renderer early`).not.toBeNull();
      dispatch(canvas!, "webglcontextlost");
      dispatch(canvas!, "webglcontextrestored");
      expect(runtimeMode(container)).toBe("native");
    }

    const canvas = effectCanvas(container);
    expect(canvas).not.toBeNull();
    dispatch(canvas!, "webglcontextlost");
    dispatch(canvas!, "webglcontextrestored");

    expect(
      runtimeMode(container),
      "the rebuild budget is not bounded — a GPU that keeps losing and " +
        "restoring drives an unbounded rebuild loop, each turn allocating " +
        "another context under WebKit's sixteen",
    ).toBe("css-fallback");
  });
});

describe("the app's own context teardown", () => {
  /**
   * Every effect ends its cleanup with `loseContext()`, and the browser
   * dispatches the resulting `webglcontextlost` one task later — by which time
   * the canvas has left the document. Treating that as a fault would make a
   * remount report a failure against the presentation that replaced it.
   */
  it("is not mistaken for a fault", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const canvas = document.createElement("canvas");
    root.append(canvas);

    const onFailure = vi.fn();
    const onRestored = vi.fn(() => true);
    const stop = observeCardEffectCanvases(
      root,
      onFailure,
      1_200,
      undefined,
      onRestored,
    );

    canvas.remove();
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 2);

    expect(
      lost.defaultPrevented,
      "a teardown loss was preventDefault-ed, asking the browser to restore a " +
        "context this app is deliberately handing back under a ceiling of 16",
    ).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();

    stop();
    root.remove();
  });

  it("cancels a pending loss when the observer is torn down", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const canvas = document.createElement("canvas");
    root.append(canvas);

    const onFailure = vi.fn();
    const stop = observeCardEffectCanvases(root, onFailure, 1_200, undefined, () => true);

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    stop();
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 2);

    expect(
      onFailure,
      "a grace timer outlived the observer and reported a failure against " +
        "whatever presentation replaced it",
    ).not.toHaveBeenCalled();

    root.remove();
  });
});
