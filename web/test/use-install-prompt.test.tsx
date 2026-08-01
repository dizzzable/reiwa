// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { isStandalonePwa } from "../src/hooks/use-install-prompt";

describe("isStandalonePwa", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window.navigator as Navigator & { standalone?: boolean }).standalone;
  });

  it("reads standalone status without registering an install-event listener", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);

    expect(isStandalonePwa()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(display-mode: standalone)");
  });

  it("recognises the iOS standalone flag when display-mode is unavailable", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    Object.defineProperty(window.navigator, "standalone", {
      configurable: true,
      value: true,
    });

    expect(isStandalonePwa()).toBe(true);
  });
});
