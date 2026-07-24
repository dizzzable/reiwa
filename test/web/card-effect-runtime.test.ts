import { describe, expect, it } from "vitest";

import {
  requiresWebGL,
  requiresWebGL2,
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
});
