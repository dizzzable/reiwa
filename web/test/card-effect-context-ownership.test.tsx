// @vitest-environment jsdom

/**
 * A second setup must get a LIVE WebGL context.
 *
 * WHAT WENT WRONG. Six effect components rendered their own
 * `<canvas ref={canvasRef}>`, handed that element to a renderer, and ended the
 * cleanup of a `[]`-dependency effect by destroying the context on it —
 * `WEBGL_lose_context.loseContext()`, or `THREE.WebGLRenderer.forceContextLoss()`
 * which is the same call under another name. React owns an element it rendered,
 * so the element SURVIVES that cleanup, and a canvas hands the same context
 * object back to every later `getContext` call. So the SECOND setup on that
 * element received the already-lost context and could never draw again:
 *
 *  - OGL (`ChromaticWaves`, `DotMatrix`): every shader fails to compile with a
 *    null info log, `Program`'s constructor early-returns leaving
 *    `uniformLocations` undefined, and the first `render()` throws
 *    `Cannot read properties of undefined (reading 'forEach')`. The card layer's
 *    error boundary catches it and drops to `css-fallback` — permanently, for
 *    the rest of the session.
 *  - Raw WebGL (`Thunderstrike`, `CosmicOrb`) and three.js (`Particlesphere`,
 *    `Tornado`): no throw at all. `createShader` returns null on a lost context,
 *    the component bails out of its own init, and the card is a blank canvas
 *    with nothing for the error boundary to catch and nothing for the canvas
 *    observer to report.
 *
 * React StrictMode's double-invoke — mount, cleanup, mount again, on the SAME
 * DOM — reproduces it on every dev mount, which is why the panel's dev server
 * showed it 100% of the time. In production it needs any path that tears the
 * effect down and sets it up again over preserved DOM.
 *
 * THE FIX IS OWNERSHIP, NOT THE RELEASE. Deleting `loseContext()` would also
 * stop the poisoning and would be wrong: WebKit frees a context slot only when
 * the context object is destroyed, and this project is under a
 * 16-per-web-content-process ceiling — the explicit release is what keeps it
 * there. So the canvas moved instead: every setup allocates its own element and
 * removes it again, exactly as `Plasma` and `Grainient` already did. That makes
 * BOTH halves load-bearing, and the cases below fail if either one is undone:
 *  - re-introduce the React-owned canvas → a lost context is handed out;
 *  - delete the release → two live contexts survive one mount.
 *
 * HOW THE BROWSER IS MODELLED. `getContext` is stubbed, because jsdom has no
 * WebGL, and it is stubbed to the semantics that produce the bug rather than to
 * something convenient: one context object per canvas, handed back for every
 * later call, and once `loseContext()` has been called on it, it stays lost —
 * `isContextLost()` is true, every `create*` returns null, every `get*Parameter`
 * answers false, and `drawArrays` is a no-op. That is what the spec requires and
 * what the reported failures are made of.
 *
 * WHAT IS NOT COVERED HERE. Only the two raw-WebGL components are driven, and
 * they are driven for real, with nothing between the component and the stubbed
 * `getContext`. The OGL and three.js pair cannot be driven in jsdom without
 * stubbing the library that the ownership question is about, which would make
 * the case circular. They are covered by the static audit at the bottom of this
 * file instead — a weaker guard, and named as one.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { StrictMode, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CosmicOrb from "../src/components/reactbits/originkit/CosmicOrb";
import Thunderstrike from "../src/components/reactbits/originkit/Thunderstrike";

/* ─────────────────────────────── the browser ────────────────────────────── */

interface FakeContext {
  readonly canvas: HTMLCanvasElement;
  isContextLost(): boolean;
  /**
   * How many draw calls this context has RECEIVED — counted unconditionally,
   * lost or not. Do not gate this on `!lost`. Every assertion in this file
   * reads it against a live context, so nothing here is unfailable today, but
   * the gated form makes "stopped drawing after the loss" true by construction
   * for any implementation, and the identical shape in the panel's harness hid
   * a render loop that outlived unmount and drew into a released context for a
   * whole session. Real WebGL no-ops such a draw; it does not un-receive it.
   */
  drawCount(): number;
  /** The subset of `drawCount()` received while `isContextLost()` was true. */
  drawsWhileLost(): number;
  [key: string]: unknown;
}

interface Handout {
  readonly canvas: HTMLCanvasElement;
  readonly context: FakeContext;
  /** Was the context ALREADY lost at the moment it was handed to the caller? */
  readonly lostAtHandout: boolean;
}

const handouts: Handout[] = [];
const contexts: FakeContext[] = [];

function createFakeContext(canvas: HTMLCanvasElement): FakeContext {
  let lost = false;
  let draws = 0;
  let drawsWhileLost = 0;
  const alive = <T,>(value: T): T | null => (lost ? null : value);

  const gl: FakeContext = {
    canvas,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    TRIANGLE_STRIP: 0x0005,
    BLEND: 0x0be2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    COLOR_BUFFER_BIT: 0x4000,

    isContextLost: () => lost,
    drawCount: () => draws,
    drawsWhileLost: () => drawsWhileLost,

    // A lost context creates nothing and validates nothing. This is the whole
    // model of the failure: not an exception, just null handles and `false`
    // answers, which is why five of the six components failed silently.
    createShader: () => alive({}),
    createProgram: () => alive({}),
    createBuffer: () => alive({}),
    getUniformLocation: () => alive({}),
    getShaderParameter: () => !lost,
    getProgramParameter: () => !lost,
    getShaderInfoLog: () => alive(""),
    getProgramInfoLog: () => alive(""),
    getAttribLocation: () => (lost ? -1 : 0),

    shaderSource: () => undefined,
    compileShader: () => undefined,
    deleteShader: () => undefined,
    attachShader: () => undefined,
    bindAttribLocation: () => undefined,
    linkProgram: () => undefined,
    useProgram: () => undefined,
    deleteProgram: () => undefined,
    deleteBuffer: () => undefined,
    bindBuffer: () => undefined,
    bufferData: () => undefined,
    enableVertexAttribArray: () => undefined,
    vertexAttribPointer: () => undefined,
    enable: () => undefined,
    blendFunc: () => undefined,
    viewport: () => undefined,
    clearColor: () => undefined,
    clear: () => undefined,
    uniform1f: () => undefined,
    uniform2f: () => undefined,
    uniform3f: () => undefined,
    drawArrays: () => {
      draws += 1;
      if (lost) drawsWhileLost += 1;
    },

    getExtension: (name: string) =>
      name === "WEBGL_lose_context"
        ? {
            loseContext: () => {
              lost = true;
            },
          }
        : null,
  };

  return gl;
}

/**
 * `getContext`, with the two properties the defect is made of: a canvas keeps
 * ONE context object and hands it back to every later call, and a context that
 * has been lost is never silently replaced with a fresh one.
 */
function stubGetContext(): void {
  const perCanvas = new WeakMap<HTMLCanvasElement, { kind: string; context: FakeContext }>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind !== "webgl" && kind !== "webgl2" && kind !== "experimental-webgl") {
      return null;
    }
    const existing = perCanvas.get(this);
    // A canvas that already carries a context of another kind refuses a second
    // one, per spec. Neither component under test asks twice, so this only ever
    // guards the stub from lying in a direction that would flatter the fix.
    if (existing !== undefined && existing.kind !== kind) return null;

    const context = existing?.context ?? createFakeContext(this);
    if (existing === undefined) {
      perCanvas.set(this, { kind, context });
      contexts.push(context);
    }
    handouts.push({ canvas: this, context, lostAtHandout: context.isContextLost() });
    return context as unknown as RenderingContext;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
}

/* ─────────────────────────────── the harness ────────────────────────────── */

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * A hand-driven frame clock. Both components re-schedule from inside their own
 * frame callback, so a stub that ran the callback synchronously would recurse
 * without end.
 */
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function runOneFrame(): void {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(0);
}

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];

function render(element: ReactElement): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(element));
  return host;
}

function liveContexts(): FakeContext[] {
  return contexts.filter((context) => !context.isContextLost());
}

beforeEach(() => {
  handouts.length = 0;
  contexts.length = 0;
  frames.clear();
  nextFrameId = 1;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  stubGetContext();
});

afterEach(() => {
  act(() => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { host } of mounted) host.remove();
  mounted.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ──────────────────────────────── the cases ─────────────────────────────── */

const RAW_WEBGL_EFFECTS = [
  { name: "Thunderstrike", Component: Thunderstrike },
  { name: "CosmicOrb", Component: CosmicOrb },
] as const;

describe.each(RAW_WEBGL_EFFECTS)("$name: setup twice over one mount", ({ Component }) => {
  it("never receives a context that was already lost", () => {
    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    );
    act(() => runOneFrame());

    // The premise. StrictMode's double-invoke is what puts a second setup on
    // preserved DOM; without it every assertion below would pass vacuously on
    // the broken code too.
    expect(handouts.length).toBe(2);

    const poisoned = handouts.filter((handout) => handout.lostAtHandout);
    expect(
      poisoned.length,
      "a setup was handed a context that had already been lost — the component " +
        "is destroying a context on a canvas it does not own, so the element " +
        "outlives the context and hands the dead one to the next setup",
    ).toBe(0);
  });

  it("draws with the context the second setup was given", () => {
    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    );
    act(() => runOneFrame());

    const current = handouts.at(-1);
    expect(current).toBeDefined();
    expect(current?.context.isContextLost()).toBe(false);
    expect(
      current?.context.drawCount() ?? 0,
      "the surviving setup never drew — a lost context accepts every call and " +
        "executes none, which is the blank card the report describes",
    ).toBeGreaterThan(0);
  });

  it("still hands the first setup's context back to the browser", () => {
    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    );
    act(() => runOneFrame());

    // The other half of the fix, and the reason "just stop calling
    // loseContext()" is not an acceptable answer: WebKit frees a slot only when
    // the context object is destroyed, and it caps a web-content process at 16.
    // Two setups over one mount must leave exactly one context alive.
    expect(
      liveContexts().length,
      "a discarded setup left its context alive — the explicit release is what " +
        "keeps this page under WebKit's 16-context ceiling",
    ).toBe(1);
  });

  it("leaves no context alive after unmount", () => {
    render(
      <StrictMode>
        <Component />
      </StrictMode>,
    );
    act(() => runOneFrame());
    act(() => {
      for (const { root } of mounted) root.unmount();
    });
    mounted.length = 0;

    expect(liveContexts().length).toBe(0);
  });
});

/* ─────────────────────────── the standing audit ─────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const REACTBITS_DIR = join(HERE, "..", "src", "components", "reactbits");

function reactbitsSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
    });
  return walk(REACTBITS_DIR).sort();
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function some(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  if (predicate(node)) return true;
  return node.getChildren().some((child) => some(child, predicate));
}

/**
 * `loseContext()` and three.js' `forceContextLoss()` are the same call: both end
 * in `WEBGL_lose_context.loseContext`, and both destroy the context object.
 */
function destroysContext(source: ts.SourceFile): boolean {
  return some(source, (node) => {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : null;
    return name === "loseContext" || name === "forceContextLoss";
  });
}

/**
 * A `<canvas>` React renders and therefore OWNS: the element outlives an
 * effect's cleanup, so a context destroyed in that cleanup outlives it too.
 *
 * Read off the syntax tree rather than the text, so that a prose description of
 * the defect — which every fixed component now carries — is not mistaken for
 * the defect.
 */
function rendersOwnCanvas(source: ts.SourceFile): boolean {
  return some(source, (node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) {
      return false;
    }
    if (node.tagName.getText() !== "canvas") return false;
    return node.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText() === "ref",
    );
  });
}

describe("no effect destroys a context on a canvas React owns", () => {
  it("holds for every component in the card catalog", () => {
    const offenders = reactbitsSources()
      .filter((path) => {
        const source = parse(path);
        return destroysContext(source) && rendersOwnCanvas(source);
      })
      .map((path) => relative(REACTBITS_DIR, path).replaceAll("\\", "/"));

    expect(
      offenders,
      "these components render their own <canvas ref> and then destroy the " +
        "context on it. React keeps the element, the element keeps the dead " +
        "context, and the next setup is handed it: let the renderer allocate " +
        "the canvas instead (see Plasma/Grainient), and keep the release",
    ).toEqual([]);
  });

  /**
   * The audit is text over source, so it can only see the shape it was told to
   * look for. It does NOT know that `originkit/**` is vendored byte-for-byte
   * into rezeis — `originkit-manifest.test.ts` is what carries that — and it
   * cannot see a canvas passed down through a helper, a `createElement('canvas')`
   * stored on a ref that React later adopts, or a context destroyed through an
   * aliased extension object. It is a tripwire for the shape that was actually
   * shipped six times, not a proof of ownership.
   */
  it("is looking at a real set of files", () => {
    const sources = reactbitsSources();
    expect(sources.length).toBeGreaterThan(30);
    expect(
      sources.filter((path) => destroysContext(parse(path))).length,
      "no component destroys a context at all — the audit would pass on an " +
        "empty premise",
    ).toBeGreaterThan(0);
    expect(
      sources.filter((path) => rendersOwnCanvas(parse(path))).length,
      "no component renders a <canvas ref> at all — the audit would pass on an " +
        "empty premise (Waves draws on a React-owned 2D canvas and is allowed " +
        "to: a 2D context costs no WebGL slot and is never destroyed)",
    ).toBeGreaterThan(0);
  });
});
