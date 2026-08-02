// @vitest-environment jsdom

import { act, lazy, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/reactbits/registry", () => ({
  CARD_EFFECT_COMPONENTS: {
    paperWarp: () => <canvas data-test-native-card-effect />,
    threads: () => <canvas data-test-native-card-effect />,
    aurora: () => <canvas data-test-aurora-card-effect />,
    waves: lazy(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          delayedEffect.resolve = () =>
            resolve({
              default: () => <canvas data-test-delayed-card-effect />,
            });
        }),
    ),
  },
  CARD_EFFECT_DEFAULTS: {
    paperWarp: {},
    threads: {},
    aurora: {},
    waves: {},
  },
}));

const delayedEffect = vi.hoisted(() => ({
  resolve: undefined as undefined | (() => void),
}));

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ customIcons: [] }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  CardEffectLayer,
} from "../src/components/reactbits/card-effect-layer";
import {
  observeCardEffectCanvases,
  resolveCardEffectOverlayOpacity,
} from "../src/components/reactbits/card-effect-layer-utils";
import { SubscriptionCardFrame } from "../src/features/dashboard/components/subscription-card-frame";
import { SubscriptionCardContent } from "../src/features/dashboard/components/subscription-card";
import { resolveSubscriptionCardVisual } from "../src/features/dashboard/components/subscription-card-visual";
import { DEFAULT_BRANDING } from "../src/types/branding";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function renderIntoDom(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return container;
}

function allowMotion(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

function animatedVisual() {
  return resolveSubscriptionCardVisual({
    ...DEFAULT_BRANDING,
    cardEffect: "paperWarp",
    cardEffectProps: {
      colors: ["#121212", "#9470ff", "#8838ff"],
    },
  });
}

describe("CardEffectLayer reduced-motion renderer ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }),
    } as unknown as WebGL2RenderingContext);
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the operator-selected artwork live when the OS requests reduced motion", () => {
    const container = renderIntoDom(
      <CardEffectLayer effect="paperWarp" active />,
    );

    expect(container.querySelectorAll("[data-card-effect-renderer]")).toHaveLength(1);
    expect(
      container
        .querySelector("[data-card-effect-runtime]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("native");
  });

  it("keeps the active dashboard card live when the OS requests reduced motion", () => {
    const container = renderIntoDom(
      <SubscriptionCardFrame visual={animatedVisual()} effectActive>
        <span>Active subscription</span>
      </SubscriptionCardFrame>,
    );

    expect(container.querySelectorAll("[data-card-effect-renderer]")).toHaveLength(1);
    expect(
      container
        .querySelector("[data-card-effect-runtime]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("native");
  });

  it("mounts no renderer for an inactive dashboard card", () => {
    const container = renderIntoDom(
      <SubscriptionCardFrame visual={animatedVisual()} effectActive={false}>
        <span>Inactive subscription</span>
      </SubscriptionCardFrame>,
    );

    expect(container.querySelectorAll("[data-card-effect-renderer]")).toHaveLength(0);
  });

  it("keeps one live renderer across several cards when reduced motion is requested", () => {
    const visual = animatedVisual();
    const container = renderIntoDom(
      <>
        <SubscriptionCardFrame visual={visual} effectActive={false} />
        <SubscriptionCardFrame visual={visual} effectActive />
        <SubscriptionCardFrame visual={visual} effectActive={false} />
      </>,
    );

    expect(container.querySelectorAll("[data-card-effect-renderer]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-test-native-card-effect]")).toHaveLength(1);
  });

  it("keeps exactly one live renderer across multiple cards when motion is allowed", () => {
    allowMotion();
    const visual = animatedVisual();
    const container = renderIntoDom(
      <>
        <SubscriptionCardFrame visual={visual} effectActive={false} />
        <SubscriptionCardFrame visual={visual} effectActive />
        <SubscriptionCardFrame visual={visual} effectActive={false} />
      </>,
    );

    expect(container.querySelectorAll("[data-card-effect-renderer]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-test-native-card-effect]")).toHaveLength(1);
  });

  it("reveals the mounted renderer on the active card", () => {
    allowMotion();
    const container = renderIntoDom(
      <SubscriptionCardFrame visual={animatedVisual()} effectActive />,
    );

    const layer = container.querySelector("[data-card-effect-source]");
    expect(layer).not.toBeNull();
    expect(layer?.getAttribute("data-card-effect-runtime")).toBe("native");
    expect(layer?.getAttribute("data-card-effect-ready")).toBe("true");
    expect((layer as HTMLElement).style.opacity).toBe("1");
  });

  it("uses the native artwork at the exact opacity the operator selected", () => {
    allowMotion();
    const container = renderIntoDom(
      <CardEffectLayer effect="paperWarp" active opacity={1} />,
    );

    const layer = container.querySelector("[data-card-effect-source]") as HTMLElement | null;
    const renderer = container.querySelector(
      "[data-card-effect-renderer]",
    ) as HTMLElement | null;

    expect(layer?.getAttribute("data-card-effect-runtime")).toBe("native");
    expect(layer?.style.opacity).toBe("1");
    expect(layer?.style.mixBlendMode).toBe("screen");
    expect(renderer?.style.opacity).toBe("1");
    expect(renderer?.style.mixBlendMode).toBe("");
  });

  it("preserves an operator-selected native effect opacity and clamps only invalid values", () => {
    allowMotion();
    const container = renderIntoDom(
      <CardEffectLayer effect="paperWarp" active opacity={0.42} />,
    );

    const renderer = container.querySelector(
      "[data-card-effect-renderer]",
    ) as HTMLElement | null;

    expect(renderer?.style.opacity).toBe("0.42");
    expect(resolveCardEffectOverlayOpacity(0.42)).toBe(0.42);
    expect(resolveCardEffectOverlayOpacity(1)).toBe(1);
    expect(resolveCardEffectOverlayOpacity(4)).toBe(1);
    expect(resolveCardEffectOverlayOpacity(0)).toBe(0.05);
  });

  it("reports a renderer that silently fails to create its canvas", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const onFailure = vi.fn();
    const stop = observeCardEffectCanvases(root, onFailure, 25);

    vi.advanceTimersByTime(25);
    expect(onFailure).toHaveBeenCalledOnce();

    stop();
    vi.useRealTimers();
  });

  it("starts the missing-canvas watchdog only after a lazy renderer commits", async () => {
    vi.useFakeTimers();
    const container = renderIntoDom(
      <CardEffectLayer effect="waves" active />,
    );

    expect(delayedEffect.resolve).toBeTypeOf("function");
    act(() => vi.advanceTimersByTime(2_000));
    expect(
      container
        .querySelector("[data-card-effect-source]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("native");
    expect(container.querySelector("[data-card-effect-artwork]")).toBeNull();

    await act(async () => {
      delayedEffect.resolve?.();
      await Promise.resolve();
    });
    expect(container.querySelector("[data-test-delayed-card-effect]"))
      .not.toBeNull();

    act(() => vi.advanceTimersByTime(2_000));
    expect(
      container
        .querySelector("[data-card-effect-source]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("native");
    expect(container.querySelector("[data-card-effect-artwork]")).toBeNull();
  });

  it("finishes native to Aurora to CSS after two distinct runtime failures", () => {
    const container = renderIntoDom(
      <CardEffectLayer
        effect="threads"
        props={{ color: "#8b5cf6" }}
        active
      />,
    );

    const native = container.querySelector(
      "[data-test-native-card-effect]",
    );
    expect(native).not.toBeNull();
    act(() => native?.dispatchEvent(new Event("webglcontextlost")));

    expect(
      container
        .querySelector("[data-card-effect-source]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("webgl1-fallback");
    const aurora = container.querySelector("[data-test-aurora-card-effect]");
    expect(aurora).not.toBeNull();
    act(() => aurora?.dispatchEvent(new Event("webglcontextlost")));

    expect(
      container
        .querySelector("[data-card-effect-source]")
        ?.getAttribute("data-card-effect-runtime"),
    ).toBe("css-fallback");
    expect(container.querySelector("[data-card-effect-renderer]")).toBeNull();
    expect(container.querySelector("[data-card-effect-artwork]")).not.toBeNull();
  });

  it("keeps a Paper card's own palette on a WebGL1-only Telegram WebView", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      ((contextId: string) =>
        contextId === "webgl"
          ? ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)
          : null) as typeof HTMLCanvasElement.prototype.getContext,
    );

    const container = renderIntoDom(
      <CardEffectLayer
        effect="paperWarp"
        props={{ colors: ["#121212", "#9470ff", "#8838ff"] }}
        active
      />,
    );

    const layer = container.querySelector("[data-card-effect-source]") as HTMLElement | null;
    expect(layer?.getAttribute("data-card-effect-runtime")).toBe("css-fallback");
    expect(layer?.getAttribute("data-card-effect-ready")).toBe("true");
    expect(layer?.style.opacity).toBe("1");
    expect(container.querySelector("[data-card-effect-renderer]")).toBeNull();
    expect(container.querySelector("[data-card-effect-artwork]")).not.toBeNull();
    const fallback = container.querySelector("[data-card-effect-artwork]");
    expect(fallback?.getAttribute("style") ?? "").not.toContain("background-color");
  });

  it("keeps a custom subscription gradient and pattern below the CSS fallback", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      ((contextId: string) =>
        contextId === "webgl"
          ? ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)
          : null) as typeof HTMLCanvasElement.prototype.getContext,
    );
    const gradient = "linear-gradient(135deg, #052e16, #0f766e)";
    const pattern = "linear-gradient(90deg, #ffffff22 1px, transparent 1px)";
    const visual = resolveSubscriptionCardVisual({
      ...DEFAULT_BRANDING,
      cardGradient: gradient,
      cardPattern: pattern,
      cardEffect: "paperWarp",
      cardEffectProps: { colors: ["#121212", "#9470ff", "#8838ff"] },
      cardEffectOpacity: 0.68,
    });

    const container = renderIntoDom(
      <SubscriptionCardFrame visual={visual} effectActive />,
    );

    const gradientLayer = container.querySelector(
      '[data-subscription-card-layer="gradient"]',
    ) as HTMLElement | null;
    const patternLayer = container.querySelector(
      '[data-subscription-card-layer="pattern"]',
    ) as HTMLElement | null;
    const fallback = container.querySelector("[data-card-effect-artwork]") as HTMLElement | null;
    // jsdom normalizes hex stops to rgb() in a CSS declaration.
    expect(gradientLayer?.style.backgroundImage).toContain("rgb(5, 46, 22)");
    expect(gradientLayer?.style.backgroundImage).toContain("rgb(15, 118, 110)");
    expect(patternLayer?.style.backgroundImage).toContain("linear-gradient");
    expect(fallback?.style.backgroundColor).toBe("");
    expect(fallback?.style.opacity).toBe("0.68");
    expect(fallback?.style.mixBlendMode).toBe("");
    expect(
      (container.querySelector("[data-card-effect-source]") as HTMLElement | null)
        ?.style.mixBlendMode,
    ).toBe("screen");
  });

  it("uses the literal saved opacity for the CSS fallback while retaining the foundation layer", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      ((contextId: string) =>
        contextId === "webgl"
          ? ({ getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }) } as unknown as WebGLRenderingContext)
          : null) as typeof HTMLCanvasElement.prototype.getContext,
    );
    const visual = resolveSubscriptionCardVisual({
      ...DEFAULT_BRANDING,
      cardGradient: "linear-gradient(135deg, #052e16, #0f766e)",
      cardEffect: "paperWarp",
      cardEffectProps: { colors: ["#121212", "#9470ff", "#8838ff"] },
      cardEffectOpacity: 1,
    });

    const container = renderIntoDom(
      <SubscriptionCardFrame visual={visual} effectActive />,
    );
    const fallback = container.querySelector(
      "[data-card-effect-artwork]",
    ) as HTMLElement | null;
    expect(fallback?.style.opacity).toBe("1");
    expect(fallback?.style.mixBlendMode).toBe("");
    expect(
      (container.querySelector("[data-card-effect-source]") as HTMLElement | null)
        ?.style.mixBlendMode,
    ).toBe("screen");
    expect(fallback?.style.backgroundImage).not.toContain("linear-gradient");
    expect(
      container.querySelector('[data-subscription-card-layer="gradient"]'),
    ).not.toBeNull();
  });

  it("leaves the live artwork uncovered and the copy unoutlined", () => {
    allowMotion();
    const container = renderIntoDom(
      <SubscriptionCardFrame visual={animatedVisual()} effectActive>
        <SubscriptionCardContent
          subscription={{
            id: "sub-uncovered-artwork",
            userRemnaId: "usr_fallback",
            profileName: "usr_profile",
            status: "ACTIVE",
            isTrial: false,
            trafficLimit: null,
            trafficUsed: null,
            deviceLimit: null,
            expiresAt: "2030-01-01T00:00:00.000Z",
            url: null,
            plan: { id: "plan", name: "Unlimited", type: "PAID" },
            createdAt: "2026-01-01T00:00:00.000Z",
          }}
        />
      </SubscriptionCardFrame>,
    );

    const card = container.querySelector(
      '[data-subscription-card-artwork="animated"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.style.textShadow).toBe("");
    expect(
      container.querySelector('[data-subscription-card-layer="vignette"]'),
    ).toBeNull();
    expect(
      container.querySelector("[data-subscription-card-readability]"),
    ).toBeNull();
    expect(container.querySelector("[data-subscription-card-copy-band]"))
      .toBeNull();
    expect(container.querySelector("[data-subscription-card-local-support]"))
      .toBeNull();
    expect(container.querySelector("[data-subscription-card-profile-support]"))
      .toBeNull();
  });
});
