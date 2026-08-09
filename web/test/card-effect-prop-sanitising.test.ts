import { describe, expect, it } from "vitest";

import { sanitizeCardEffectProps } from "../src/components/reactbits/card-effect-layer-utils";

/**
 * Operator JSON must not become React's reserved props.
 *
 * `cardEffectProps` is authored in the branding form and saved as free-form
 * JSON. The backend constrains its SHAPE — depth, key count, string length —
 * but not its key NAMES, and the layer spreads the record onto the chosen
 * effect, most of which forward whatever they do not recognise to a real
 * `<div>`. That is a path from a settings field to `dangerouslySetInnerHTML`,
 * to an inline `style` (including `cssText`, which replaces the entire
 * declaration), and to event handlers.
 *
 * An operator is trusted to run the service, not to execute code in a
 * subscriber's browser — the cabinet is served from the operator's own domain
 * to their paying users. The deployment's CSP blocks inline script today, but a
 * defence that lives entirely in a header set somewhere else is not a defence
 * of this code, and the CSP does not stop arbitrary markup or a full-page
 * overlay.
 */

describe("card effect prop sanitising", () => {
  it("passes an ordinary effect configuration through untouched", () => {
    // Anchors the rest: a filter that stripped everything would satisfy every
    // "removes X" case below.
    const props = { speed: 1.5, colors: ["#ffffff", "#000000"], shape: "checks" };

    expect(sanitizeCardEffectProps(props)).toEqual(props);
  });

  it("returns the very same object when there is nothing to remove", () => {
    // Referential equality matters: the result feeds memoised children.
    const props = { speed: 1 };

    expect(sanitizeCardEffectProps(props)).toBe(props);
  });

  it.each([
    "dangerouslySetInnerHTML",
    "style",
    "className",
    "class",
    "children",
    "ref",
    "key",
  ])("removes %s", (key) => {
    const result = sanitizeCardEffectProps({ speed: 1, [key]: { __html: "<img src=x>" } });

    expect(Object.hasOwn(result, key)).toBe(false);
    expect(result["speed"]).toBe(1);
  });

  it.each(["onClick", "onError", "onLoad", "onPointerDown"])(
    "removes the event handler %s",
    (key) => {
      const result = sanitizeCardEffectProps({ speed: 1, [key]: "alert(1)" });

      expect(Object.hasOwn(result, key)).toBe(false);
    },
  );

  it("keeps props that merely start with the letters on", () => {
    // The rule is React's — `on` followed by a capital. `once` and `onset` are
    // ordinary names an effect could legitimately use.
    const props = { once: true, onset: 3, only: "x" };

    expect(sanitizeCardEffectProps(props)).toEqual(props);
  });

  it("does not mutate the record it was given", () => {
    const props: Record<string, unknown> = { speed: 1, style: { position: "fixed" } };

    sanitizeCardEffectProps(props);

    expect(Object.hasOwn(props, "style")).toBe(true);
  });
});
