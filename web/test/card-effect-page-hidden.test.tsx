// @vitest-environment jsdom

/**
 * What happens to a card animation while the user is somewhere else.
 *
 * WebKit does not slow `requestAnimationFrame` down for a hidden page, it stops
 * it. The first callback after the user returns carries a timestamp that jumped
 * by however long they were away, so any effect integrating its motion from
 * that delta plays its whole absence in a single frame. Whether a given effect
 * lurches or clamps is a per-component accident, and the layer has no way to
 * police thirty of them.
 *
 * So the layer unmounts instead, which fixes both halves at once: the clock
 * starts from zero on return, and the GPU context goes back to the browser for
 * the duration. On a phone the second half is the more valuable one — a
 * Telegram mini-app is backgrounded constantly, and iOS reclaims memory from
 * whatever is not in front of the user.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/reactbits/card-effect-manifest", () => {
  const components = { threads: () => <canvas data-test-effect /> };
  const defaults: Record<string, Record<string, unknown>> = { threads: {} };
  return {
    CARD_EFFECT_COMPONENTS: components,
    CARD_EFFECT_DEFAULTS: defaults,
    isKnownCardEffect: (id: string) => Object.hasOwn(components, id),
    cardEffectDefaults: (id: string) => (Object.hasOwn(defaults, id) ? defaults[id] : {}),
  };
});

import { CardEffectLayer } from "../src/components/reactbits/card-effect-layer";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

beforeEach(() => {
  visibility = "visible";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "webgl" || kind === "webgl2"
        ? { getExtension: () => ({ loseContext: () => undefined }) }
        : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
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

const renderer = (container: HTMLDivElement) =>
  container.querySelector("[data-test-effect]");

describe("card effect while the page is hidden", () => {
  it("runs an active card when the page is in front of the user", () => {
    // Anchors everything below: without it, an effect that never mounted at all
    // would satisfy every "does not run" assertion.
    const container = render(<CardEffectLayer effect="threads" active />);

    expect(renderer(container)).not.toBeNull();
  });

  it("gives up the renderer when the user leaves", () => {
    const container = render(<CardEffectLayer effect="threads" active />);
    setVisibility("hidden");

    expect(renderer(container)).toBeNull();
  });

  it("brings it back when the user returns", () => {
    const container = render(<CardEffectLayer effect="threads" active />);
    setVisibility("hidden");
    setVisibility("visible");

    expect(renderer(container)).not.toBeNull();
  });

  it("does not run a card that was already hidden when the page went away", () => {
    // Two independent reasons not to run must not cancel each other out.
    const container = render(<CardEffectLayer effect="threads" active={false} />);
    setVisibility("hidden");
    setVisibility("visible");

    expect(renderer(container)).toBeNull();
  });

  it("starts with nothing running when mounted onto an already-hidden page", () => {
    visibility = "hidden";
    const container = render(<CardEffectLayer effect="threads" active />);

    expect(renderer(container)).toBeNull();
  });
});
