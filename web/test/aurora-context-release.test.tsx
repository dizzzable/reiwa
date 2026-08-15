// @vitest-environment jsdom

/**
 * The cabinet's own Aurora hands its WebGL context back.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ONE EFFECT GETS A FILE OF ITS OWN. Every other card effect in this
 * repository is a byte-frozen copy of the panel's — `card-effects.manifest.json`
 * and `card-effect-components-freeze.test.ts` are what say so — and the panel is
 * where they are actually RUN, because it is the tree whose lockfile carries
 * `ogl`, `three` and `@react-three/fiber`.
 *
 * `aurora` is the deliberate exception. The manifest's `excluded` block records
 * it: the cabinet draws this effect from `components/ui/aurora`, eagerly rather
 * than lazily, because it is the DEFAULT card effect and splitting it would put
 * a round trip in front of the commonest card in the product. So the file below
 * is not a copy of anything, no freeze covers it, and until this suite nothing
 * anywhere ever mounted it — the panel's lifecycle and context-release suites
 * guard the panel's `reactbits/Aurora.tsx`, which is a different file.
 *
 * WHAT IS PINNED. That the effect's cleanup DESTROYS the context rather than
 * dropping the reference to it, and that three mount → unmount rounds over the
 * same host leave the live-context count where it started. WebKit gives a
 * web-content process 16 live contexts and then recycles the oldest into an
 * unrecoverable SyntheticLostContext; a dropped reference returns no slot, and
 * a subscriber who opens and closes the card a dozen times is not doing
 * anything unusual.
 *
 * WHY THE STUB IS SHAPED LIKE THIS. jsdom has no canvas backend, so `getContext`
 * returns null and OGL never starts. The obvious fix — a fresh happy-path object
 * per call — is the one that must not be used: under it every setup gets a
 * pristine context however the last one was left, and a component that renders a
 * permanently dead canvas passes exactly as happily as one that works. So this
 * models the two properties of the platform the question turns on — one context
 * per canvas ELEMENT handed back to every later call, and a lost context that
 * stays lost — and answers OGL's several-hundred-call long tail through a Proxy
 * rather than transcribing it. Same construction, and same reasoning, as the
 * panel's `gl-stub.ts`; it is not imported because it lives in the other
 * checkout.
 *
 * NOT OBSERVABLE HERE, so not claimed: no fragment is ever shaded. This pins
 * ownership, lifetime and counts, and says nothing about the picture.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Aurora } from "../src/components/ui/aurora";

/* ─────────────────────────────── the browser ────────────────────────────── */

const enumNames = new Map<number, string>();
const enumValues = new Map<string, number>();
let nextEnum = 0x1000;
const glEnum = (name: string): number => {
  let value = enumValues.get(name);
  if (value === undefined) {
    value = nextEnum++;
    enumValues.set(name, value);
    enumNames.set(value, name);
  }
  return value;
};

interface StubContext {
  lost: boolean;
  loseCalls: number;
  /**
   * COUNTED UNCONDITIONALLY — a draw issued against a lost context still
   * increments this. It used to read `if (!state.lost) state.draws += 1`, which
   * sounds careful and is not: unmount releases the context, so after unmount
   * the count could not move for ANY implementation, and
   * `stops its frame loop on unmount` below was true by construction rather
   * than by behaviour. The panel's equivalent harness carried the same shape
   * and hid a real defect behind it — `PixelBlast`'s render loop outlived
   * unmount and kept drawing into a released context for the whole session,
   * invisible until the counter was repaired (measured: removing the loop stop
   * from three components produced zero failures before, exactly three after).
   * Real WebGL silently no-ops such a draw; it does not refuse to have been
   * called. The stub models the call, not the pixel.
   */
  draws: number;
  /** The subset of `draws` issued while `isContextLost()` was true. */
  drawsWhileLost: number;
  isContextLost(): boolean;
  [key: string]: unknown;
}

const contexts: StubContext[] = [];
const contextOf = new WeakMap<HTMLCanvasElement, StubContext>();
const liveContexts = () => contexts.filter((context) => !context.isContextLost());

function createContext(canvas: HTMLCanvasElement): StubContext {
  const state = { lost: false, loseCalls: 0, draws: 0, drawsWhileLost: 0 };
  // A lost context creates nothing — which is exactly how this failure class
  // stays SILENT: the caller gets null and bails out of its own setup.
  const alive = <T,>(value: T): T | null => (state.lost ? null : value);

  const own: Record<string, unknown> = {
    canvas,
    isContextLost: () => state.lost,
    createShader: () => alive({}),
    createProgram: () => alive({}),
    createBuffer: () => alive({}),
    createTexture: () => alive({}),
    createVertexArray: () => alive({}),
    getShaderParameter: () => !state.lost,
    getProgramParameter: (_program: unknown, pname: number) => {
      const name = enumNames.get(pname) ?? "";
      if (name === "LINK_STATUS" || name === "VALIDATE_STATUS") return !state.lost;
      // Zero active uniforms and attributes: OGL walks those counts to build
      // its location maps, and zero makes the walk a no-op rather than a
      // source of fabricated locations.
      return 0;
    },
    getShaderInfoLog: () => alive(""),
    getProgramInfoLog: () => alive(""),
    getAttribLocation: () => 0,
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    getParameter: (pname: number) => {
      const name = enumNames.get(pname) ?? "";
      if (name === "VERSION") return "WebGL 2.0 (stub)";
      if (name === "MAX_TEXTURE_SIZE" || name === "MAX_RENDERBUFFER_SIZE") return 16384;
      if (name === "MAX_VERTEX_ATTRIBS" || name === "MAX_TEXTURE_IMAGE_UNITS") return 32;
      if (name === "VIEWPORT" || name === "SCISSOR_BOX") return new Int32Array([0, 0, 1, 1]);
      return 0;
    },
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getSupportedExtensions: () => ["WEBGL_lose_context"],
    getError: () => 0,
    getExtension: (name: string) =>
      name === "WEBGL_lose_context"
        ? {
            loseContext: () => {
              state.loseCalls += 1;
              state.lost = true;
            },
            restoreContext: () => {
              state.lost = false;
            },
          }
        : null,
    drawArrays: () => {
      state.draws += 1;
      if (state.lost) state.drawsWhileLost += 1;
    },
    drawElements: () => {
      state.draws += 1;
      if (state.lost) state.drawsWhileLost += 1;
    },
  };

  for (const key of ["lost", "loseCalls", "draws", "drawsWhileLost"] as const) {
    Object.defineProperty(own, key, { get: () => state[key], enumerable: true });
  }
  Object.defineProperty(own, "drawingBufferWidth", { get: () => canvas.width });
  Object.defineProperty(own, "drawingBufferHeight", { get: () => canvas.height });

  const extras: Record<string, unknown> = {};
  return new Proxy(own as unknown as StubContext, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (property in target) return Reflect.get(target, property, receiver);
      if (property in extras) return extras[property];
      // `MAX_TEXTURE_SIZE`, `TRIANGLES`, `COMPILE_STATUS`, … — every GL enum.
      if (/^[A-Z][A-Z0-9_]*$/.test(property)) return glEnum(property);
      const noop = () => undefined;
      extras[property] = noop;
      return noop;
    },
    set(target, property, value, receiver) {
      // OGL writes `gl.renderer = this` onto the context object.
      if (typeof property === "string" && !(property in target)) {
        extras[property] = value;
        return true;
      }
      return Reflect.set(target, property, value, receiver);
    },
    has(target, property) {
      return (
        Reflect.has(target, property) ||
        (typeof property === "string" && property in extras)
      );
    },
  });
}

/* ─────────────────────────────── the harness ────────────────────────────── */

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let clock = 0;

function runFrames(count: number): void {
  for (let i = 0; i < count; i += 1) {
    clock += 16;
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(clock);
  }
}

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];

function mountInto(host: HTMLDivElement): Root {
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(<Aurora />));
  return root;
}

function unmountRoot(root: Root): void {
  const index = mounted.findIndex((entry) => entry.root === root);
  if (index >= 0) mounted.splice(index, 1);
  act(() => root.unmount());
}

beforeEach(() => {
  contexts.length = 0;
  frames = new Map();
  nextFrame = 1;
  clock = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  // jsdom lays everything out at 0×0, and this component measures its
  // container with `offsetWidth`/`offsetHeight`.
  for (const property of ["offsetWidth", "clientWidth"] as const) {
    vi.spyOn(HTMLElement.prototype, property, "get").mockReturnValue(390);
  }
  for (const property of ["offsetHeight", "clientHeight"] as const) {
    vi.spyOn(HTMLElement.prototype, property, "get").mockReturnValue(220);
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind !== "webgl" && kind !== "webgl2") return null;
    // THE CONTRACT: one context per canvas ELEMENT, for its whole life, handed
    // back to every later caller — lost or not.
    let context = contextOf.get(this);
    if (context === undefined) {
      context = createContext(this);
      contextOf.set(this, context);
      contexts.push(context);
    }
    return context;
  } as never);
});

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ──────────────────────────────── the cases ─────────────────────────────── */

describe("the cabinet's Aurora", () => {
  it("opens exactly one context and reaches its render loop", () => {
    const host = document.createElement("div");
    document.body.append(host);
    mountInto(host);
    runFrames(2);

    // The premise: everything below is vacuous against a component that never
    // built a renderer, and under a stub that is an easy state to be in.
    expect(contexts.length, "Aurora opened no WebGL context").toBe(1);
    expect(contexts[0]!.draws, "Aurora never reached its render loop").toBeGreaterThan(0);
    expect(host.querySelector("canvas"), "no canvas was presented").not.toBeNull();
  });

  it("destroys the context on unmount rather than dropping the reference", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = mountInto(host);
    runFrames(2);
    const context = contexts[0]!;
    expect(context.loseCalls, "the context was released before unmount").toBe(0);

    unmountRoot(root);
    host.remove();

    expect(
      context.loseCalls,
      "Aurora dropped its context reference without destroying it. A dropped " +
        "reference frees nothing: WebKit returns the slot only when the context " +
        "object is destroyed, and it caps a web-content process at 16 before it " +
        "starts recycling the oldest into an unrecoverable SyntheticLostContext",
    ).toBeGreaterThanOrEqual(1);
    expect(context.isContextLost()).toBe(true);
    expect(liveContexts(), "a context outlived the component").toEqual([]);
  });

  it("stops its frame loop on unmount", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = mountInto(host);
    runFrames(2);
    const drewBefore = contexts[0]!.draws;
    // The premise. Without it a component that never reached its loop at all
    // satisfies the assertion below for the wrong reason — 0 frames after
    // unmount is trivially equal to 0 frames before it.
    expect(drewBefore, "Aurora never reached its render loop").toBeGreaterThan(0);

    unmountRoot(root);
    runFrames(3);
    host.remove();

    expect(
      contexts[0]!.draws,
      "the render loop outlived the component and is drawing into a released context",
    ).toBe(drewBefore);
    expect(
      contexts[0]!.drawsWhileLost,
      "frames were rendered into a context that had already been handed back",
    ).toBe(0);
  });

  it("does not accumulate contexts over three mount/unmount rounds", () => {
    // The same host element every round — the card is opened, closed and
    // opened again in one slot, and React keeps the DOM. A leak of one context
    // per mount is invisible to a single-round test, which cannot tell it apart
    // from "the one that is still mounted".
    const host = document.createElement("div");
    document.body.append(host);

    for (const round of [1, 2, 3]) {
      const root = mountInto(host);
      runFrames(2);
      expect(
        liveContexts().length,
        `Aurora held ${liveContexts().length} live contexts while mounted on round ${round}`,
      ).toBe(1);

      unmountRoot(root);

      expect(
        liveContexts().length,
        `Aurora left ${liveContexts().length} contexts alive after round ${round} ` +
          "of mount → unmount. This is the default card effect and it is eager, " +
          "so every subscriber pays for the leak on every visit",
      ).toBe(0);
    }

    expect(contexts.length, "Aurora did not build a renderer on every round").toBe(3);
    host.remove();
  });

  it("gives a remount into the same host a live context, not the dead one", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const first = mountInto(host);
    runFrames(2);
    unmountRoot(first);

    mountInto(host);
    runFrames(2);

    const canvas = host.querySelector("canvas");
    expect(canvas, "the remount presented no canvas").not.toBeNull();
    const context = contextOf.get(canvas!);
    expect(
      context?.isContextLost(),
      "the remount is backed by a context that was already destroyed. That " +
        "happens when the canvas belongs to REACT rather than to the renderer: " +
        "the element survives the cleanup that lost its context and hands the " +
        "dead one straight to the next setup",
    ).toBe(false);
    expect(context!.draws, "the remount never drew a frame").toBeGreaterThan(0);
    expect(liveContexts().length, "the remount leaked the first mount").toBe(1);
    expect(host.querySelectorAll("canvas").length, "a dead canvas was left stacked").toBe(1);
    host.remove();
  });
});
