import { describe, expect, it } from "vitest";

import {
  requiresWebGL,
  requiresWebGL2,
  resolveCardEffectColors,
  resolveCardEffectOutputColors,
  resolveCardEffectRuntime,
} from "../../web/src/components/reactbits/card-effect-runtime.js";

const WEBGL2 = { webgl: true, webgl2: true } as const;
const WEBGL1 = { webgl: true, webgl2: false } as const;
const NO_WEBGL = { webgl: false, webgl2: false } as const;

describe("card effect runtime policy", () => {
  it("keeps a Paper shader when WebGL2 is actually available", () => {
    expect(
      resolveCardEffectRuntime({
        effect: "paperWarp",
        props: { colors: ["#120", "#9470ff", "#8838ff"] },
        capabilities: WEBGL2,
      }),
    ).toMatchObject({ effect: "paperWarp", mode: "native" });
  });

  it("uses a themed WebGL1 Aurora fallback for Paper effects", () => {
    expect(
      resolveCardEffectRuntime({
        effect: "paperGrain",
        props: {
          colors: ["#4c06a2", "#723a83", "#03759b", "#18047c"],
          speed: 2,
        },
        capabilities: WEBGL1,
      }),
    ).toMatchObject({
      effect: "aurora",
      mode: "webgl1-fallback",
      props: {
        colorStops: ["#4c06a2", "#723a83", "#18047c"],
        speed: 1.25,
      },
    });
  });

  it("uses a CSS colour-field fallback when no GPU context is available", () => {
    expect(
      resolveCardEffectRuntime({
        effect: "paperWarp",
        props: { colors: ["#121212", "#9470ff", "#8838ff"] },
        capabilities: NO_WEBGL,
      }),
    ).toMatchObject({
      effect: "NONE",
      mode: "css-fallback",
      cssColors: ["#121212", "#9470ff", "#8838ff"],
    });
  });

  it("falls back after a live WebGL context is lost", () => {
    expect(
      resolveCardEffectRuntime({
        effect: "threads",
        props: { color: "#8b5cf6" },
        capabilities: WEBGL1,
        failed: true,
      }),
    ).toMatchObject({ effect: "aurora", mode: "webgl1-fallback" });

    expect(
      resolveCardEffectRuntime({
        effect: "aurora",
        props: {},
        capabilities: WEBGL1,
        failed: true,
      }),
    ).toMatchObject({ effect: "NONE", mode: "css-fallback" });
  });

  it("does not require WebGL for the Canvas 2D waves effect", () => {
    expect(requiresWebGL("waves")).toBe(false);
    expect(requiresWebGL2("paperGrain")).toBe(true);
    expect(requiresWebGL2("aurora")).toBe(false);
    expect(
      resolveCardEffectRuntime({
        effect: "waves",
        props: { waveSpeedX: 0.02 },
        capabilities: NO_WEBGL,
      }),
    ).toMatchObject({ effect: "waves", mode: "native" });
  });

  it("extracts every effect-specific palette shape used by concept cards", () => {
    expect(
      resolveCardEffectColors("rippleGrid", { gridColor: "#e6ff58" }),
    ).toEqual(["#e6ff58"]);
    expect(
      resolveCardEffectColors("liquidChrome", {
        baseColor: [0.1, 0.5, 1],
      }),
    ).toEqual(["#1a80ff", "#000000", "#ffffff"]);
    expect(
      resolveCardEffectColors("dither", {
        waveColor: [0.5, 0.25, 0],
      }),
    ).toEqual(["#804000", "#000000"]);
    expect(
      resolveCardEffectColors("paperDither", {
        colorBack: "#101820",
        colorFront: "#00b2ff",
      }),
    ).toEqual(["#101820", "#00b2ff"]);
    expect(
      resolveCardEffectColors("galaxy", { hueShift: 212 }),
    ).toEqual(["#ffffff", "#000000"]);
    expect(
      resolveCardEffectColors("galaxy", {
        hueShift: 212,
        saturation: 0.8,
      }),
    ).toEqual(["hsl(212 80% 60%)", "#ffffff", "#000000"]);
  });

  it("models the full output gamut of additive and contrast-expanding shaders", () => {
    expect(
      resolveCardEffectOutputColors("lineWaves", {
        color1: "#9A6A24",
        color2: "#553A15",
        color3: "#000000",
      }),
    ).toEqual([
      "#9A6A24",
      "#553A15",
      "#000000",
      "#ffffff",
    ]);

    for (const [effect, props] of [
      ["softAurora", { color1: "#ff1744", color2: "#651fff" }],
      ["rippleGrid", { gridColor: "#ef4444" }],
      ["radar", { color: "#9f29ff" }],
      ["particles", { particleColors: ["#f59e0b", "#2563eb"] }],
      ["grainient", { color1: "#ff9ffc", color2: "#5227ff", color3: "#b497cf" }],
      ["balatro", { color1: "#de443b", color2: "#006bb4", color3: "#162325" }],
    ] as const) {
      expect(resolveCardEffectOutputColors(effect, props)).toEqual(
        expect.arrayContaining(["#000000", "#ffffff"]),
      );
    }
  });
});
