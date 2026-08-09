// @vitest-environment jsdom

/**
 * Every ogl-backed effect: cap the BUFFER, leave the CSS box alone, and do not
 * reallocate for a box that did not move.
 *
 * WHY IT IS IN THIS REPOSITORY TOO. These ten components are kept byte-identical
 * with `rezeis-admin/web/src/components/reactbits/`, which has the same cases in
 * `glass-background-resize-guard.test.tsx` and `LiquidChrome.test.tsx`. Until
 * now only that copy was tested — and this is the copy that runs in the Telegram
 * cabinet, which is the iOS surface the resize guard was written for in the
 * first place. A guard tested in one repository and shipped in two is a guard
 * that can be removed from the shipping one and stay green.
 *
 * WHAT THE TWO PROPERTIES ARE:
 *  - the CSS numbers handed to `setSize` are the container's, untouched. This is
 *    the line that separates the device-pixel budget from the `transform:
 *    scale()` governor it replaced: that one shrank the box every effect derives
 *    its FEATURES from, so a 10 px lattice became 33 px and the counts fell by
 *    the square of the scale;
 *  - `renderer.dpr` — which ogl multiplies ONLY into `canvas.width/height` —
 *    is what moves, and only for boxes over the budget.
 *
 * NOT ASSERTED, because jsdom has no WebGL: that the driver allocates what ogl
 * asked for. The ogl stub mirrors the real `setSize` (node_modules/ogl/src/core/
 * Renderer.js) closely enough that the guards compare against real values;
 * stubbing that away would make every case here vacuous.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setSizeSpy = vi.hoisted(() => vi.fn());
const rendererRef = vi.hoisted(() => ({ current: null as { dpr: number } | null }));

vi.mock("ogl", () => {
  class Renderer {
    width = 0;
    height = 0;
    /** ogl's own default, and the value the device-pixel budget replaces. */
    dpr = 1;
    gl: Record<string, unknown> & { canvas: HTMLCanvasElement };

    constructor(options?: { dpr?: number }) {
      const canvas = document.createElement("canvas");
      if (typeof options?.dpr === "number") this.dpr = options.dpr;
      this.gl = {
        canvas,
        POINTS: 0,
        clearColor: () => {},
        getExtension: () => null,
        enable: () => {},
        disable: () => {},
        blendFunc: () => {},
      };
      this.setSize(300, 150);
      rendererRef.current = this;
    }

    setSize(width: number, height: number): void {
      setSizeSpy(width, height);
      this.width = width;
      this.height = height;
      this.gl.canvas.width = width * this.dpr;
      this.gl.canvas.height = height * this.dpr;
    }

    render(): void {}
  }

  class Vec3 {
    x = 0;
    y = 0;
    z = 0;
    set(x: number, y: number, z: number): this {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }

  class Color {
    r: number;
    g: number;
    b: number;
    constructor(r: number | string = 0, g = 0, b = 0) {
      this.r = typeof r === "number" ? r : 0;
      this.g = g;
      this.b = b;
    }
  }

  class Camera {
    position = new Vec3();
    perspective(): this {
      return this;
    }
  }

  class Program {
    uniforms: Record<string, { value: unknown }>;
    constructor(_gl: unknown, options: { uniforms?: Record<string, { value: unknown }> }) {
      this.uniforms = options.uniforms ?? {};
    }
    remove(): void {}
  }

  class Geometry {
    remove(): void {}
  }

  class Mesh {
    position = new Vec3();
    rotation = new Vec3();
    remove(): void {}
  }

  class Triangle {}

  return { Renderer, Program, Mesh, Triangle, Color, Camera, Geometry, Vec3 };
});

import Balatro from "../src/components/reactbits/Balatro";
import Galaxy from "../src/components/reactbits/Galaxy";
import Iridescence from "../src/components/reactbits/Iridescence";
import LineWaves from "../src/components/reactbits/LineWaves";
import { LiquidChrome } from "../src/components/reactbits/LiquidChrome";
import Particles from "../src/components/reactbits/Particles";
import Radar from "../src/components/reactbits/Radar";
import RippleGrid from "../src/components/reactbits/RippleGrid";
import SoftAurora from "../src/components/reactbits/SoftAurora";
import Threads from "../src/components/reactbits/Threads";

const BACKGROUNDS: Array<[string, () => ReactElement]> = [
  ["Balatro", () => <Balatro />],
  ["Galaxy", () => <Galaxy />],
  ["Iridescence", () => <Iridescence />],
  ["LineWaves", () => <LineWaves />],
  ["LiquidChrome", () => <LiquidChrome />],
  ["Particles", () => <Particles />],
  ["Radar", () => <Radar />],
  ["RippleGrid", () => <RippleGrid />],
  ["SoftAurora", () => <SoftAurora />],
  ["Threads", () => <Threads />],
];

/** jsdom reports 0 for every layout dimension; make them scriptable. */
const box = { width: 390, height: 844 };
let root: Root | null = null;
let host: HTMLDivElement | null = null;
// `undefined` where jsdom defines the accessor further up the chain
// (`clientWidth` lives on Element, not HTMLElement) — those are deleted rather
// than redefined on the way out.
let sizeDescriptors: Array<[string, PropertyDescriptor | undefined]> = [];

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  box.width = 390;
  box.height = 844;
  rendererRef.current = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  // Both spellings: these ten are split between `offsetWidth` and
  // `clientWidth`, and a stub covering only one would let half of them measure
  // 0×0 and pass every case below without ever reaching a guard.
  sizeDescriptors = (
    ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight"] as const
  ).map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
  for (const [prop, key] of [
    ["offsetWidth", "width"],
    ["offsetHeight", "height"],
    ["clientWidth", "width"],
    ["clientHeight", "height"],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === "CANVAS" ? 0 : box[key];
      },
    });
  }
  // Freeze the render loop; these cases are about sizing, not frames.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  setSizeSpy.mockClear();
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const [name, descriptor] of sizeDescriptors) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    } else {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(element: ReactElement): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(element));
}

function fireResize(): void {
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe.each(BACKGROUNDS)("%s", (name, make) => {
  it("sizes the drawing buffer to the container on mount", () => {
    mount(make());

    // Anchors every case below: a component that measured 0×0, or never
    // reached its own resize handler, would satisfy "does not reallocate"
    // while guarding nothing at all.
    expect(
      setSizeSpy,
      `${name} never sized its buffer to the container — the cases below would pass vacuously`,
    ).toHaveBeenLastCalledWith(390, 844);
  });

  it("ignores the iOS address-bar resize storm (dimensions unchanged)", () => {
    mount(make());
    setSizeSpy.mockClear();

    for (let i = 0; i < 8; i++) fireResize();

    expect(
      setSizeSpy,
      `${name} reallocated its WebGL drawing buffer for a box that did not move`,
    ).not.toHaveBeenCalled();
  });

  it("reallocates when only ONE dimension changes", () => {
    // A soft keyboard moves height alone; a window drag moves width alone.
    // Joined with `&&` where it needs `||` (or the reverse, for the
    // early-return form) the guard passes both cases above — a rotation moves
    // both axes, and so does the mount — and then freezes the buffer for
    // exactly these two. That mutation was run and survived in the sibling
    // repository before this case existed.
    mount(make());
    setSizeSpy.mockClear();

    box.height = 700;
    fireResize();
    expect(
      setSizeSpy,
      `${name} ignored a height-only resize — the guard is comparing the wrong thing`,
    ).toHaveBeenCalledWith(390, 700);

    box.width = 500;
    fireResize();
    expect(
      setSizeSpy,
      `${name} ignored a width-only resize — the guard is comparing the wrong thing`,
    ).toHaveBeenCalledWith(500, 700);
  });

  it("leaves the pixel ratio at ogl's own for a box inside the budget", () => {
    // A phone-sized full-screen mount, and every card, must be bit-identical to
    // what they rendered before the budget existed. Exactly 1, not
    // approximately: 0.975 would resample every card in the product and look
    // entirely plausible in a screenshot.
    mount(make());

    expect(
      rendererRef.current!.dpr,
      `${name} resampled a 390×844 box that is well inside the budget`,
    ).toBe(1);
  });

  it("lowers the pixel ratio — and NOT the CSS size — over the budget", () => {
    box.width = 2560;
    box.height = 1440;
    mount(make());
    const renderer = rendererRef.current!;

    expect(
      setSizeSpy,
      `${name} shrank the CSS box instead of the drawing buffer`,
    ).toHaveBeenLastCalledWith(2560, 1440);
    // 2560×1440 at 0.75 is 1920×1080 — the budget, exactly.
    expect(renderer.dpr).toBe(0.75);
    expect(2560 * 1440 * renderer.dpr ** 2).toBe(1920 * 1080);
  });
});
