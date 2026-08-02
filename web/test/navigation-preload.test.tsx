import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const bottomNavSource = readFileSync(
  new URL("../src/components/layout/bottom-nav.tsx", import.meta.url),
  "utf8",
);
const sideNavSource = readFileSync(
  new URL("../src/components/layout/side-nav.tsx", import.meta.url),
  "utf8",
);

describe("navigation route loading", () => {
  it("does not import a destination chunk before the navigation click", () => {
    for (const source of [bottomNavSource, sideNavSource]) {
      expect(source).not.toContain("preloadNavigationRoute");
      expect(source).not.toContain("onPointerDown=");
      expect(source).not.toContain("onPointerEnter=");
    }
  });
});
