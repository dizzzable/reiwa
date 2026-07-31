import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const INDEX_CSS = readFileSync(
  new URL("../../web/src/index.css", import.meta.url),
  "utf8",
);
const EFFECT_LAYER_SOURCE = readFileSync(
  new URL(
    "../../web/src/components/reactbits/card-effect-layer.tsx",
    import.meta.url,
  ),
  "utf8",
);

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = INDEX_CSS.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `missing CSS block for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("animated card CSS opacity contract", () => {
  it("keeps the selected effect opaque over the theme placeholder", () => {
    const fallback = cssBlock(".card-effect-layer__css-fallback");
    const opacityDeclarations =
      fallback.match(/\bopacity\s*:\s*[^;]+;/g) ?? [];

    expect(opacityDeclarations).toEqual(["opacity: 1;"]);
    expect(EFFECT_LAYER_SOURCE).toContain(
      "opacity: presentationReady ? 1 : 0",
    );
    expect(EFFECT_LAYER_SOURCE).toContain(
      "data-card-effect-palette-surface",
    );
    expect(EFFECT_LAYER_SOURCE).toContain(
      "style={{ opacity: configuredOpacity }}",
    );
    expect(EFFECT_LAYER_SOURCE).toContain('contain: "paint"');
    expect(EFFECT_LAYER_SOURCE).toContain('overflow: "hidden"');
    expect(EFFECT_LAYER_SOURCE).toContain(
      "const shouldAnimate = shouldMount && !prefersReducedMotion",
    );
    expect(EFFECT_LAYER_SOURCE).toContain(
      'mode: "css-fallback" as const',
    );
  });
});

describe("semantic glass contrast CSS", () => {
  it("does not compound alpha on validated secondary text tokens", () => {
    expect(cssBlock(".glass-input::placeholder")).toContain(
      "color: var(--brand-muted-foreground);",
    );
    expect(cssBlock(".theme-subtle")).toContain(
      "color: var(--brand-muted-foreground);",
    );
  });

  it("keeps keyboard focus visible on glass icon buttons", () => {
    const focus = cssBlock(".glass-icon-btn:focus-visible");

    expect(focus).toContain(
      "outline: 2px solid var(--brand-foreground);",
    );
    expect(focus).toContain("outline-offset: 2px;");
    expect(focus).toContain(
      "border-color: var(--color-border-strong);",
    );
  });
});

describe("cold concept background parity", () => {
  it("uses the bootstrap texture blend mode before React mounts", () => {
    expect(cssBlock("body")).toContain(
      "background-blend-mode: var(--bootstrap-app-background-blend, normal);",
    );
  });
});
