import { describe, expect, it } from "vitest";

import { buildTextureCss } from "../../web/src/lib/app-texture.js";
import type { AppBackgroundTexture } from "../../web/src/types/branding.js";

const PATTERNS: readonly AppBackgroundTexture[] = [
  "dots",
  "grid",
  "diagonal",
  "cross",
  "waves",
  "carbon",
  "triangles",
  "noise",
];

describe("app background textures", () => {
  it.each(PATTERNS)("builds a valid CSS tile for %s", (pattern) => {
    const css = buildTextureCss({
      pattern,
      color: "#63f0e0",
      background: "#040b0e",
      scale: 28,
      opacity: 0.17,
    });

    expect(css.backgroundColor).toBe("#040b0e");
    expect(css.backgroundImage).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(css.backgroundSize).toBe("28px 28px");
  });

  it("bakes the configured opacity into the noise texture", () => {
    const css = buildTextureCss({
      pattern: "noise",
      color: "#ffffff",
      background: "#000000",
      scale: 40,
      opacity: 0.23,
    });

    expect(decodeURIComponent(css.backgroundImage)).toContain(
      'flood-opacity="0.23"',
    );
  });
});
