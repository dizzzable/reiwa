// @vitest-environment jsdom

/**
 * Giving Paper's WebGL context back.
 *
 * `@paper-design/shaders-react` creates its own canvas and its own WebGL2
 * context, and its `dispose()` deletes the program, the textures and the canvas
 * — but never calls `WEBGL_lose_context.loseContext()`. Dropping the reference
 * does not return the slot: WebKit frees one only when the context object is
 * destroyed, and it caps a web-content process at 16 before it starts recycling
 * the oldest and handing out an unrecoverable SyntheticLostContext. Six effects
 * come out of `paper.tsx`, so a carousel reached that cap on its own.
 *
 * The release existed. It just never ran. It read the element out of a
 * `useRef` from a `useEffect` cleanup, and React had already cleared that ref:
 * for a deleted subtree, refs are detached in the MUTATION phase while passive
 * cleanups are deferred and flushed after paint.
 *
 * WHAT WENT WRONG WITH THIS FILE. The hook is two changes — a LAYOUT cleanup,
 * and the element captured into a local at mount — and either one alone is
 * enough to make the release run. So a file that only checked "the release
 * runs" pinned the pair and neither half: reverting `useLayoutEffect` to
 * `useEffect` kept every test green, and so did deleting the capture. The one
 * test that looked like it addressed this exercised a local probe component,
 * so it went on passing whatever `paper.tsx` said. It is kept below, relabelled
 * as what it is — the premise — and the two halves are now pinned separately,
 * each through the real hook:
 *
 *  - the LAYOUT half, by when the release runs: inside the mutation phase, so
 *    the element is still in the document. A passive cleanup runs after the
 *    commit, with the element already detached.
 *  - the CAPTURE half, by making the release survive a ref that is empty when
 *    the cleanup runs. With a layout cleanup React no longer produces that
 *    state on its own, so the test produces it directly — it is exactly the
 *    state the shipped bug ran in.
 *
 * WHAT THIS FILE DOES NOT COVER. `@paper-design/shaders-react` is mocked, by a
 * stand-in that forwards the ref it is given straight to its own <div>. Whether
 * the REAL component chain forwards a ref to a `PaperShaderElement` at all, and
 * whether that element carries `paperShaderMount` with a live `canvasElement`,
 * is assumed here and asserted nowhere. A package upgrade that stopped
 * forwarding refs would leave every test below green and the release dead.
 */

import {
  act,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Everything the release does, in the order it does it. */
const events = vi.hoisted(() => ({
  log: [] as string[],
  /**
   * Was the shader's element still in the document when the release reached it?
   * Recorded rather than folded into `log` so the ordering assertions stay
   * about ordering.
   */
  connectedAtRelease: [] as boolean[],
  /** Every object ref the stand-in was handed, so a test can empty them. */
  refs: [] as Array<{ current: HTMLDivElement | null }>,
  /**
   * The `maxPixelCount` each stand-in received, per shader. Paper renders at
   * NATIVE device-pixel ratio (`minPixelRatio` 2 means "at least 2", not "at
   * most") and its stock ceiling of 8,294,400 only binds beyond 4K, so the
   * wrapper must hand every shader an explicit ~1080p cap — see
   * `PAPER_MAX_PIXEL_COUNT` in `paper.tsx`.
   */
  caps: [] as Array<{ name: string; maxPixelCount: unknown }>,
}));

type MockRef =
  | ((node: HTMLDivElement | null) => void)
  | { current: HTMLDivElement | null }
  | null;

/**
 * Stands in for a Paper shader component: a <div> that carries a
 * `paperShaderMount` with a canvas, exactly like `ShaderMount` leaves it, and
 * forwards the ref it was given to that same <div>.
 */
vi.mock("@paper-design/shaders-react", () => {
  const shader = (name: string) =>
    function Shader({
      ref,
      style,
      maxPixelCount,
    }: {
      readonly ref?: MockRef;
      readonly style?: CSSProperties;
      readonly maxPixelCount?: number;
    }) {
      events.caps.push({ name, maxPixelCount });
      const attach = (node: HTMLDivElement | null) => {
        if (node !== null) {
          const canvas = document.createElement("canvas");
          node.append(canvas);
          Object.assign(node, {
            paperShaderMount: {
              canvasElement: canvas,
              dispose: () => {
                events.log.push(`dispose:${name}`);
                events.connectedAtRelease.push(node.isConnected);
              },
            },
          });
        }
        if (typeof ref === "function") ref(node);
        else if (ref !== null && ref !== undefined) {
          ref.current = node;
          if (node !== null && !events.refs.includes(ref)) events.refs.push(ref);
        }
      };
      return <div ref={attach} style={style} data-paper={name} />;
    };

  return {
    MeshGradient: shader("mesh"),
    Warp: shader("warp"),
    GrainGradient: shader("grain"),
    Dithering: shader("dither"),
    Swirl: shader("swirl"),
    Metaballs: shader("metaballs"),
  };
});

import {
  PaperDither,
  PaperGrain,
  PaperMesh,
  PaperMetaballs,
  PaperSwirl,
  PaperWarp,
} from "../src/components/reactbits/paper";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function unmount(): void {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
}

beforeEach(() => {
  events.log = [];
  events.connectedAtRelease = [];
  events.refs = [];
  events.caps = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "webgl2"
        ? {
            getExtension: (extension: string) =>
              extension === "WEBGL_lose_context"
                ? { loseContext: () => events.log.push("loseContext") }
                : null,
          }
        : null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
});

afterEach(() => {
  if (root !== null) unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what React leaves a cleanup to work with", () => {
  it("has already cleared the ref by the time a passive cleanup runs", () => {
    // THE PREMISE, AND ONLY THE PREMISE. This is a local component; it says
    // nothing about `paper.tsx` and will keep passing however that file is
    // written. Its job is to fail if React ever changes the deletion order,
    // which would make the hook's reasoning — and the two tests that pin the
    // hook below — stale rather than wrong.
    const seen: string[] = [];
    function Probe() {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => () => {
        seen.push(`passive:${ref.current !== null}`);
      }, []);
      useLayoutEffect(() => () => {
        seen.push(`layout:${ref.current !== null}`);
      }, []);
      return <div ref={ref} />;
    }

    mount(<Probe />);
    unmount();

    expect(seen).toEqual(["layout:true", "passive:false"]);
  });
});

describe("releasing the context a Paper shader owns", () => {
  it("runs at all", () => {
    mount(<PaperMesh />);
    unmount();

    expect(events.log).toContain("dispose:mesh");
    expect(events.log).toContain("loseContext");
  });

  it("disposes the GPU objects before it loses the context under them", () => {
    mount(<PaperMesh />);
    unmount();

    expect(events.log).toEqual(["dispose:mesh", "loseContext"]);
  });

  it("holds nothing back while the shader is still mounted", () => {
    // The release is an unmount concern only; a mounted card must keep its
    // context.
    mount(<PaperMesh />);

    expect(events.log).toEqual([]);
  });

  it.each([
    ["PaperWarp", PaperWarp, "warp"],
    ["PaperGrain", PaperGrain, "grain"],
    ["PaperDither", PaperDither, "dither"],
    ["PaperSwirl", PaperSwirl, "swirl"],
    ["PaperMetaballs", PaperMetaballs, "metaballs"],
  ])("covers %s too, since they share the hook", (_name, Component, id) => {
    mount(<Component />);
    unmount();

    expect(events.log).toEqual([`dispose:${id}`, "loseContext"]);
  });
});

describe("capping the render buffer", () => {
  // Why a cap at all: `ShaderMount` renders at `max(devicePixelRatio,
  // minPixelRatio = 2)` — native DPR, uncapped, on every phone — and the
  // package default `maxPixelCount` (8,294,400) binds only beyond 4K. A DPR-3
  // phone therefore shades 3.01M device pixels a frame, and the full-screen
  // app background multiplies that by the whole viewport. The literal
  // 2,073,600 (1920×1080) is asserted rather than imported so a drive-by
  // change to the constant in `paper.tsx` fails here instead of shipping.
  it.each([
    ["PaperMesh", PaperMesh, "mesh"],
    ["PaperWarp", PaperWarp, "warp"],
    ["PaperGrain", PaperGrain, "grain"],
    ["PaperDither", PaperDither, "dither"],
    ["PaperSwirl", PaperSwirl, "swirl"],
    ["PaperMetaballs", PaperMetaballs, "metaballs"],
  ])("hands %s a ~1080p maxPixelCount ceiling", (_name, Component, id) => {
    mount(<Component />);

    expect(events.caps).toContainEqual({
      name: id,
      maxPixelCount: 2_073_600,
    });
  });

  it("does not let operator-authored props raise the ceiling", () => {
    // The registry spreads operator JSON straight into these wrappers, so the
    // cap must be written AFTER the spread. This pins that ordering: moved
    // before the spread, the saved value below would win and the test fails.
    mount(
      <PaperMesh {...({ maxPixelCount: 99_999_999 } as Record<string, unknown>)} />,
    );

    expect(events.caps).toContainEqual({ name: "mesh", maxPixelCount: 2_073_600 });
    expect(events.caps).not.toContainEqual({
      name: "mesh",
      maxPixelCount: 99_999_999,
    });
  });
});

describe("the layout half of the hook, on its own", () => {
  it("releases from inside the mutation phase, while the element is still in the document", () => {
    // What a LAYOUT cleanup buys, independently of the element capture. For a
    // deletion React runs layout destroys parent-first, before it reaches the
    // host node and removes it — so the shader's <div> is still connected here.
    // A passive cleanup is deferred past the whole commit and would find it
    // already detached. That difference is the only thing separating the two,
    // and every other test in this file is blind to it: the release still runs
    // either way, just later, against a subtree React has finished tearing down.
    mount(<PaperMesh />);
    unmount();

    expect(events.connectedAtRelease).toEqual([true]);
  });
});

describe("the element-capture half of the hook, on its own", () => {
  it("releases the element it captured at mount, even after the ref has been emptied", () => {
    // The state the shipped bug ran in: `elementRef.current` is null by the
    // time the cleanup reads it, so a cleanup that consults the ref finds
    // nothing and silently releases nothing.
    //
    // React itself no longer produces that state here — with a layout cleanup
    // the ref is still attached (see the premise test) — so the test produces
    // it directly, by emptying the very ref the component was handed. That is
    // what makes this half independently observable: without the capture this
    // fails, and with it the release proceeds from the element the hook took at
    // mount and never has to consult a ref at all.
    mount(<PaperMesh />);
    expect(events.refs).toHaveLength(1);

    act(() => {
      for (const ref of events.refs) ref.current = null;
    });
    unmount();

    expect(events.log).toEqual(["dispose:mesh", "loseContext"]);
  });
});
