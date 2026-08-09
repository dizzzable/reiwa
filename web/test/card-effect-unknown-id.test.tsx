// @vitest-environment jsdom

/**
 * What the cabinet does with an effect name it does not know.
 *
 * The published config no longer restricts `cardEffect` to a closed list, so a
 * panel one release ahead cannot freeze this cabinet's configuration — the
 * reasoning is written out in `test/web/card-effect-open-vocabulary.test.ts`.
 * That tolerance moves the problem here: the id arriving in this module is now
 * arbitrary text, and it is used to look up a component, a set of default
 * props, and a palette.
 *
 * Two things must hold. An unknown name must draw nothing, leaving the
 * operator's gradient in view rather than an error. And a name that happens to
 * match something every object inherits — `toString`, `constructor` — must not
 * be mistaken for an effect, because `"toString" in CARD_EFFECT_COMPONENTS` is
 * `true` and the lookup after it would hand `Object.prototype.toString` to
 * React as a component.
 *
 * Deliberately runs against the REAL registry. A mocked one would prove only
 * that the mock behaves.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardEffectLayer } from "../src/components/reactbits/card-effect-layer";
import {
  CARD_EFFECT_COMPONENTS,
  cardEffectDefaults,
  isKnownCardEffect,
} from "../src/components/reactbits/card-effect-manifest";
import { resolveCardEffectColors } from "../src/components/reactbits/card-effect-runtime";

const INHERITED_NAMES = ["toString", "constructor", "valueOf", "hasOwnProperty"];

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom throws "Not implemented" out of `getContext`, which vitest reports as
  // an unhandled error and warns may be producing false passes. Returning null
  // is also the honest answer for a headless run: no GPU here. The layer treats
  // it as a device without WebGL, which is a path worth exercising anyway.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("card effect with an unrecognised id", () => {
  it("recognises an effect this build does ship", () => {
    // Without this the rest of the file would pass even if `isKnownCardEffect`
    // simply always returned false.
    expect(isKnownCardEffect("aurora")).toBe(true);
    expect(Object.keys(CARD_EFFECT_COMPONENTS).length).toBeGreaterThan(1);
  });

  it("does not recognise a name from a future panel release", () => {
    expect(isKnownCardEffect("effectFromAFuturePanelRelease")).toBe(false);
  });

  it.each(INHERITED_NAMES)("does not mistake the inherited %s for an effect", (name) => {
    expect(isKnownCardEffect(name)).toBe(false);
  });

  it.each(INHERITED_NAMES)("returns no default props for the inherited %s", (name) => {
    expect(cardEffectDefaults(name)).toEqual({});
  });

  it.each(INHERITED_NAMES)("returns a real palette, not a function, for %s", (name) => {
    const colors = resolveCardEffectColors(name, {});

    expect(Array.isArray(colors)).toBe(true);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(typeof color).toBe("string");
  });

  it("draws nothing at all for an unknown effect", () => {
    const container = render(
      <CardEffectLayer effect="effectFromAFuturePanelRelease" active />,
    );

    expect(container.querySelector("[data-card-effect-renderer]")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it.each(INHERITED_NAMES)("draws nothing and does not throw for %s", (name) => {
    const container = render(<CardEffectLayer effect={name} active />);

    expect(container.innerHTML).toBe("");
  });

  it("still draws a real effect, so 'nothing' is not the answer to everything", () => {
    const container = render(<CardEffectLayer effect="aurora" active />);

    expect(container.innerHTML).not.toBe("");
  });
});
