// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Branding } from "../src/types/branding";

const state = vi.hoisted(() => ({ branding: null as Branding | null }));
const resolveReadability = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: state.branding }),
}));
vi.mock("@/lib/app-background-contrast", () => ({
  resolveAppBackgroundReadability: resolveReadability,
}));
vi.mock("@/components/reactbits/card-effect-layer", () => ({
  CardEffectLayer: () => null,
}));

import { AppBackground } from "../src/components/layout/app-background";
import { DEFAULT_BRANDING } from "../src/types/branding";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state.branding = null;
  resolveReadability.mockClear();
});

describe("AppBackground route rerenders", () => {
  it("does not repeat the expensive readability sampling for stable branding", () => {
    state.branding = DEFAULT_BRANDING;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => root?.render(<AppBackground />));
    act(() => root?.render(<AppBackground />));

    expect(resolveReadability).toHaveBeenCalledTimes(1);

    state.branding = { ...DEFAULT_BRANDING, brandName: "Updated" };
    act(() => root?.render(<AppBackground />));

    expect(resolveReadability).toHaveBeenCalledTimes(2);
  });
});
