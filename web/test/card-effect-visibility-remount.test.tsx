// @vitest-environment jsdom

/**
 * Leaving the app and coming back.
 *
 * `card-effect-page-hidden.test.tsx` covers why a card gives its renderer up
 * while the user is elsewhere. This file covers the two things that turned out
 * to be wrong about doing it.
 *
 * Not every caller wants it. The app background is ONE always-mounted
 * full-screen layer behind the whole cabinet: there is no context contention to
 * relieve, nothing visible to lurch, and a Telegram mini-app is backgrounded so
 * often that unmounting it meant recompiling a shader and flashing the flat base
 * gradient several times a session. It opts out; a card cannot.
 *
 * And coming back is not the same as never having left. `shouldMount` going
 * false unmounts the CHILD — this component stays, and so does its state. The
 * readiness key was set and never cleared, so a re-show could declare the
 * presentation ready in the same commit that started rebuilding it, against a
 * renderer that had not been committed yet.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `suspend` holds the renderer out of the commit the way an unresolved
 * `React.lazy` chunk does — every effect in the real manifest is one, and the
 * layer wraps them in `<Suspense fallback={null}>` for exactly that reason. It
 * is the lever that makes the invariant observable from outside: with the
 * renderer not committed, readiness can only be true if this component
 * remembered it.
 */
const control = vi.hoisted(() => ({
  suspend: false,
  pending: new Promise<void>(() => undefined),
}));

vi.mock("../src/components/reactbits/card-effect-manifest", () => {
  const components = {
    threads: () => {
      if (control.suspend) throw control.pending;
      return <canvas data-test-effect />;
    },
  };
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

const renderer = (container: HTMLDivElement) =>
  container.querySelector("[data-test-effect]");

const ready = (container: HTMLDivElement) =>
  container
    .querySelector("[data-card-effect-ready]")
    ?.getAttribute("data-card-effect-ready");

beforeEach(() => {
  visibility = "visible";
  control.suspend = false;
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a layer that must survive the page being hidden", () => {
  it("keeps its renderer while the user is elsewhere", () => {
    const container = render(
      <CardEffectLayer effect="threads" active keepMountedWhileHidden />,
    );
    setVisibility("hidden");

    expect(renderer(container)).not.toBeNull();
  });

  it("does not tear its presentation down and build it again", () => {
    const container = render(
      <CardEffectLayer effect="threads" active keepMountedWhileHidden />,
    );
    setVisibility("hidden");
    setVisibility("visible");

    expect(ready(container)).toBe("true");
  });

  it("is opt-in: a card still gives its renderer up", () => {
    // The control. Without it the two assertions above would pass on a layer
    // that had simply stopped honouring page visibility at all.
    const container = render(<CardEffectLayer effect="threads" active />);
    setVisibility("hidden");

    expect(renderer(container)).toBeNull();
  });
});

describe("a card coming back after the page was hidden", () => {
  it("is ready in the first place, so the rest of this means something", () => {
    const container = render(<CardEffectLayer effect="threads" active />);

    expect(ready(container)).toBe("true");
    expect(renderer(container)).not.toBeNull();
  });

  it("stops being ready while it has no renderer", () => {
    const container = render(<CardEffectLayer effect="threads" active />);
    setVisibility("hidden");

    expect(ready(container)).toBe("false");
  });

  it("does not inherit the readiness it had before the page was hidden", () => {
    // The whole point. This component is never unmounted by a hide, so without
    // clearing the key the presentation it signalled BEFORE the user left is
    // still on record when they return — and it is claimed again here, while
    // the renderer that would earn it has not been committed.
    const container = render(<CardEffectLayer effect="threads" active />);
    expect(ready(container)).toBe("true");

    setVisibility("hidden");
    control.suspend = true;
    setVisibility("visible");

    expect(renderer(container)).toBeNull();
    expect(ready(container)).toBe("false");
  });

  it("becomes ready again once a renderer actually commits", () => {
    // And the fix must not simply pin readiness to false for ever after a hide.
    const container = render(<CardEffectLayer effect="threads" active />);
    setVisibility("hidden");
    setVisibility("visible");

    expect(renderer(container)).not.toBeNull();
    expect(ready(container)).toBe("true");
  });
});
