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
const EFFECT_LAYER_UTILS_SOURCE = readFileSync(
  new URL(
    "../../web/src/components/reactbits/card-effect-layer-utils.ts",
    import.meta.url,
  ),
  "utf8",
);
const CARD_FRAME_SOURCE = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-card-frame.tsx",
    import.meta.url,
  ),
  "utf8",
);
const CARD_CONTENT_SOURCE = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-card.tsx",
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
  it("keeps the selected effect as alpha artwork over the theme foundation", () => {
    const fallback = cssBlock(".card-effect-layer__css-fallback");
    const opacityDeclarations =
      fallback.match(/\bopacity\s*:\s*[^;]+;/g) ?? [];

    expect(opacityDeclarations).toEqual(["opacity: 1;"]);
    expect(EFFECT_LAYER_SOURCE).toContain("runtime?.mode === \"css-fallback\"");
    expect(EFFECT_LAYER_SOURCE).toContain(
      "data-card-effect-palette-surface",
    );
    expect(EFFECT_LAYER_SOURCE).toContain("data-card-effect-artwork");
    expect(EFFECT_LAYER_SOURCE).not.toContain("backgroundColor: first");
    expect(EFFECT_LAYER_SOURCE).toContain("opacity: configuredOpacity,");
    expect(EFFECT_LAYER_SOURCE).toContain('mixBlendMode: "screen"');
    expect(EFFECT_LAYER_SOURCE).not.toContain(
      "linear-gradient(135deg, ${first}, ${middle}, ${last})",
    );
    expect(EFFECT_LAYER_SOURCE).toContain(
      "const configuredOpacity = resolveCardEffectOverlayOpacity(opacity)",
    );
    expect(EFFECT_LAYER_UTILS_SOURCE).toContain(
      "return Math.min(Math.max(opacity, 0.05), 1)",
    );
    expect(EFFECT_LAYER_SOURCE).not.toContain("CARD_EFFECT_MAX_OVERLAY_OPACITY");
    expect(EFFECT_LAYER_SOURCE).not.toContain('isolation: "isolate"');
    expect(EFFECT_LAYER_SOURCE).not.toContain('contain: "paint"');
    expect(EFFECT_LAYER_SOURCE).toContain('overflow: "hidden"');
    expect(EFFECT_LAYER_SOURCE).toContain(
      "const shouldAnimate = shouldMount",
    );
    expect(EFFECT_LAYER_SOURCE).not.toContain("prefersReducedMotion");
    expect(EFFECT_LAYER_SOURCE).toContain("opacity: 1,");
    expect(EFFECT_LAYER_SOURCE).not.toContain('transition: "opacity 450ms ease"');
  });
});

describe("subscription card artwork contract", () => {
  it("films static artwork only, never the live shader", () => {
    expect(CARD_FRAME_SOURCE).toContain(
      "{(creationPresentation || !animatedArtwork) && (",
    );
    expect(CARD_FRAME_SOURCE).toContain("staticArtworkVeil(contrast)");
  });

  it("keeps the card copy free of outlines and capsules", () => {
    for (const source of [CARD_FRAME_SOURCE, CARD_CONTENT_SOURCE]) {
      expect(source).not.toContain("textShadow");
      expect(source).not.toContain("WebkitTextStroke");
      expect(source).not.toContain("paintOrder");
      expect(source).not.toContain("supportBackground");
      expect(source).not.toContain("localReadability");
    }
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
