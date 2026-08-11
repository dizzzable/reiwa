// @vitest-environment jsdom

/**
 * A card that did not start, and coming back to it.
 *
 * WHAT WENT WRONG, and why the two green suites next door
 * (`card-effect-page-hidden`, `card-effect-visibility-remount`) never saw any of
 * it: both mock `getContext` to succeed, so every renderer they build works on
 * the first try. Under that mock the layer has nothing to recover FROM, and all
 * four defects below live entirely on the failure path.
 *
 *  1. The context-failure listeners were attached only once the renderer had
 *     signalled readiness — which happens after it has mounted and asked for its
 *     context. `webglcontextcreationerror` is dispatched from inside
 *     `getContext()`, so the one event that says "this device would not give me
 *     a context" was structurally unhearable, and a card that never started was
 *     indistinguishable from one still loading.
 *  2. Nothing ever tried again. One failure resolved the layer to the CSS
 *     fallback for the lifetime of the page; the only cure a user had was F5.
 *  3. The rebuild budget was spent for ever and refunded by nothing, so it
 *     counted failures EVER rather than failures in a row — "после третьего
 *     возврата перестало совсем", where the three returns were hours apart.
 *  4. The restore grace window was a plain timer, and a hidden tab freezes
 *     timers. It was therefore spent while nobody was looking and delivered
 *     expired on return, reporting a permanent failure at the exact moment the
 *     browser was about to restore the context. The app background is the layer
 *     that shows it, because it is the one that stays mounted while hidden.
 *  5. `visibilitychange` was the only page-lifecycle event the front end
 *     listened to at all. A back/forward-cache thaw does not have to produce
 *     one, and the context is dead after it far more often than not.
 *
 * These tests drive the layer through a renderer that can be made to FAIL, which
 * is the whole difference.
 */

import { act, useEffect, useRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** Make the next renderer fail the way a device out of contexts does. */
  failContextCreation: false,
  /** How many renderers have been built. A rebuild that did not happen shows up here. */
  mounts: 0,
}));

vi.mock("../src/components/reactbits/card-effect-manifest", () => {
  const components = {
    threads: () => {
      const ref = useRef<HTMLCanvasElement>(null);
      useEffect(() => {
        control.mounts += 1;
        if (!control.failContextCreation) return;
        // What the browser does when `getContext()` is refused, at the moment it
        // does it: inside the renderer's own mount effect, on a canvas that is
        // already in the document. Nothing about this is dispatched later or
        // from somewhere else, which is exactly why a listener that waits for
        // the renderer to announce itself can never receive it.
        ref.current?.dispatchEvent(new Event("webglcontextcreationerror"));
      }, []);
      return <canvas data-test-effect ref={ref} />;
    },
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

import {
  CARD_EFFECT_RECOVERY_CREDIT_MS,
  CardEffectLayer,
  MAX_RETURN_RESTARTS,
} from "../src/components/reactbits/card-effect-layer";
import {
  CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS,
  observeCardEffectCanvases,
} from "../src/components/reactbits/card-effect-layer-utils";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
let visibility: DocumentVisibilityState = "visible";

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** `pageshow` carries `persisted`, and jsdom has no `PageTransitionEvent`. */
function pageShow(persisted: boolean): void {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  act(() => {
    window.dispatchEvent(event);
  });
}

function pageHide(): void {
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
}

function dispatch(target: EventTarget, type: string): Event {
  const event = new Event(type, { cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const renderer = (container: HTMLDivElement) =>
  container.querySelector("[data-test-effect]");

const runtimeMode = (container: HTMLDivElement) =>
  container
    .querySelector("[data-card-effect-source]")
    ?.getAttribute("data-card-effect-runtime");

beforeEach(() => {
  visibility = "visible";
  control.failContextCreation = false;
  control.mounts = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  // The capability probe still succeeds: what fails here is the RENDERER's own
  // context, which is the case a probe cannot predict — it is answered one
  // context earlier and on a canvas of its own.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "webgl" || kind === "webgl2"
        ? {
            getExtension: () => ({ loseContext: () => undefined }),
            isContextLost: () => false,
          }
        : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(() => {
  act(() => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted.splice(0)) container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a renderer whose context is refused", () => {
  it("is heard, although the refusal happens before the renderer exists", () => {
    control.failContextCreation = true;
    const container = render(<CardEffectLayer effect="threads" active />);

    expect(
      runtimeMode(container),
      "`webglcontextcreationerror` was not heard. The listeners are attached " +
        "after the renderer announces itself, so they miss the only event that " +
        "reports a context the device would not create — and a card that never " +
        "started is then indistinguishable from one still loading",
    ).toBe("css-fallback");
    expect(renderer(container)).toBeNull();
  });

  it("still shows the artwork when the renderer starts normally", () => {
    // The control. Without it every assertion above is satisfied by a layer
    // that fell back for some entirely unrelated reason.
    const container = render(<CardEffectLayer effect="threads" active />);

    expect(runtimeMode(container)).toBe("native");
    expect(renderer(container)).not.toBeNull();
  });
});

describe("coming back to a card that is not running", () => {
  it("tries again, instead of waiting for a reload", () => {
    control.failContextCreation = true;
    const container = render(<CardEffectLayer effect="threads" active />);
    expect(runtimeMode(container)).toBe("css-fallback");

    // The GPU is no longer refusing — which is the ordinary case, since the
    // refusal happens under exactly the memory pressure an app-switch creates.
    control.failContextCreation = false;
    setVisibility("hidden");
    setVisibility("visible");

    expect(
      runtimeMode(container),
      "the layer never retried. One failure resolved it to the CSS fallback " +
        "for the lifetime of the page, and F5 was the only cure",
    ).toBe("native");
    expect(renderer(container)).not.toBeNull();
  });

  it("gives up after a bounded number of attempts", () => {
    // A device that genuinely cannot run the effect must not spend the session
    // building contexts: each attempt allocates another one under WebKit's
    // sixteen and recompiles a shader.
    control.failContextCreation = true;
    render(<CardEffectLayer effect="threads" active />);
    expect(control.mounts).toBe(1);

    for (let attempt = 1; attempt <= MAX_RETURN_RESTARTS; attempt += 1) {
      setVisibility("hidden");
      setVisibility("visible");
      expect(control.mounts, `attempt ${attempt} did not happen`).toBe(
        attempt + 1,
      );
    }

    setVisibility("hidden");
    setVisibility("visible");

    expect(
      control.mounts,
      "the retry is unbounded — a device that cannot create a context at all " +
        "rebuilds on every app-switch for the rest of the session",
    ).toBe(MAX_RETURN_RESTARTS + 1);
  });

  it("does not disturb a card that is running", () => {
    const container = render(<CardEffectLayer effect="threads" active />);
    setVisibility("hidden");
    setVisibility("visible");

    expect(control.mounts, "a healthy card was rebuilt for no reason").toBe(2);
    expect(runtimeMode(container)).toBe("native");
  });
});

describe("returning through the back/forward cache", () => {
  /**
   * `pagehide`/`pageshow` were the events no one listened for. A bfcache thaw
   * need not produce a `visibilitychange` at all — the document did not become
   * hidden, it stopped running — and the GPU context does not survive it.
   *
   * `keepMountedWhileHidden` is what makes this observable: the app background
   * does not tear its renderer down when the page goes away, so the canvas can
   * only change identity if something rebuilt it deliberately.
   */
  it("rebuilds the renderer, which visibilitychange never asked for", () => {
    const container = render(
      <CardEffectLayer effect="threads" active keepMountedWhileHidden />,
    );
    const before = renderer(container);
    expect(before).not.toBeNull();

    pageHide();
    expect(renderer(container), "the layer gave its renderer up").toBe(before);

    pageShow(true);

    expect(
      renderer(container) === before,
      "the renderer survived a back/forward-cache return untouched. Its GL " +
        "handles did not: after a thaw the context is dead more often than " +
        "not, and nothing in this layer can detect that from the outside",
    ).toBe(false);
  });

  it("leaves an ordinary load alone", () => {
    // `pageshow` fires for every navigation, not only a restored one. Treating
    // the non-persisted one as a return would rebuild every renderer at boot.
    const container = render(
      <CardEffectLayer effect="threads" active keepMountedWhileHidden />,
    );
    const before = renderer(container);

    pageShow(false);

    expect(renderer(container)).toBe(before);
    expect(control.mounts).toBe(1);
  });
});

describe("the rebuild budget", () => {
  beforeEach(() => {
    // Only the clock the budgets and the grace window run on. Vitest's fake
    // timers otherwise take over `requestAnimationFrame` too, displacing the
    // synchronous stub the capability probe needs to get past.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  const loseAndRestore = (container: HTMLDivElement) => {
    const canvas = renderer(container);
    expect(canvas).not.toBeNull();
    dispatch(canvas!, "webglcontextlost");
    dispatch(canvas!, "webglcontextrestored");
  };

  it("is returned by a presentation that actually ran", () => {
    const container = render(<CardEffectLayer effect="threads" active />);

    // Spend it: two restorable losses are all one presentation may be rebuilt
    // through before the next is treated as permanent.
    loseAndRestore(container);
    loseAndRestore(container);
    expect(runtimeMode(container)).toBe("native");

    // …and then the card runs, in front of the user, for long enough that the
    // earlier losses were plainly transient rather than a thrashing GPU.
    act(() => vi.advanceTimersByTime(CARD_EFFECT_RECOVERY_CREDIT_MS));

    loseAndRestore(container);
    loseAndRestore(container);

    expect(
      runtimeMode(container),
      "the budget is a ratchet: it counts losses EVER rather than losses in a " +
        "row, so two transient GPU events hours apart leave the third — the " +
        "first one the user would have minded — with nothing left to spend",
    ).toBe("native");
  });

  it("is not returned by a presentation that keeps dying", () => {
    // The other half, and the reason the refund is delayed rather than granted
    // on readiness: lose → rebuild → ready → refund → lose is the unbounded
    // rebuild loop the budget exists to prevent.
    const container = render(<CardEffectLayer effect="threads" active />);

    loseAndRestore(container);
    loseAndRestore(container);
    loseAndRestore(container);

    expect(runtimeMode(container)).toBe("css-fallback");
  });
});

describe("the restore grace window while the page is hidden", () => {
  let root: HTMLDivElement;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    root = document.createElement("div");
    document.body.append(root);
    canvas = document.createElement("canvas");
    root.append(canvas);
  });

  afterEach(() => {
    root.remove();
  });

  it("does not spend the window in a tab nobody is looking at", () => {
    const onFailure = vi.fn();
    const stop = observeCardEffectCanvases(
      root,
      onFailure,
      null,
      undefined,
      () => true,
    );

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    setVisibility("hidden");
    // A long absence — an app-switch, a locked phone. A frozen timer does not
    // run here; a real one would, and would then be delivered expired below.
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 10);
    expect(onFailure).not.toHaveBeenCalled();

    setVisibility("visible");
    // Comfortably inside the window rather than one tick short of it: the
    // window is spent in real time while the page is visible, and this suite
    // fakes only `setTimeout`.
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS / 2);
    expect(
      onFailure,
      "the grace window was counted against a tab that was hidden, so the " +
        "failure lands the instant the user returns — before the browser has " +
        "had a single millisecond in which to restore the context",
    ).not.toHaveBeenCalled();

    canvas.dispatchEvent(new Event("webglcontextrestored"));
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 10);
    expect(onFailure).not.toHaveBeenCalled();

    stop();
  });

  it("still fails a context that does not come back once the user is looking", () => {
    // The backstop is delayed by an absence, never removed by one.
    const onFailure = vi.fn();
    const stop = observeCardEffectCanvases(
      root,
      onFailure,
      null,
      undefined,
      () => true,
    );

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    setVisibility("hidden");
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 10);
    setVisibility("visible");
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS);

    expect(onFailure).toHaveBeenCalledOnce();

    stop();
  });

  it("hears a loss that arrives while the page is already hidden", () => {
    // The app background's case: it keeps its context while the user is away,
    // so its losses happen there. Nothing may be timed until they are back.
    const onFailure = vi.fn();
    const stop = observeCardEffectCanvases(
      root,
      onFailure,
      null,
      undefined,
      () => true,
    );

    setVisibility("hidden");
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(
      lost.defaultPrevented,
      "the loss was not preventDefault-ed, so the browser will never restore " +
        "it and `webglcontextrestored` can never fire",
    ).toBe(true);

    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 10);
    expect(onFailure).not.toHaveBeenCalled();

    setVisibility("visible");
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    vi.advanceTimersByTime(CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS * 10);

    expect(
      onFailure,
      "a loss that happened while the page was hidden was already expired " +
        "when the page came back, so the restore that followed it was ignored",
    ).not.toHaveBeenCalled();

    stop();
  });
});
