/** Runtime helpers shared by the subscription-card effect layer and tests. */

import { cardEffectRenderer } from "./card-effect-catalog";

export function resolveCardEffectOverlayOpacity(opacity: number): number {
  return Math.min(Math.max(opacity, 0.05), 1);
}

/**
 * Prop names an effect component must never receive from saved settings.
 *
 * `cardEffectProps` is operator-authored JSON. The backend constrains its
 * SHAPE — depth, key count, string length — but not its key NAMES, and the
 * layer spreads the record straight onto the chosen component, most of which
 * forward their unrecognised props to a real `<div>`. That is a path from a
 * branding form to `dangerouslySetInnerHTML`, to an inline `style` (including
 * `cssText`, which replaces the whole declaration), and to event handlers.
 *
 * An operator is trusted to run the service, not to execute code in a
 * subscriber's browser: the cabinet is served from the operator's own domain to
 * their paying users. The deployment's Content-Security-Policy blocks inline
 * script, so this is not currently a route to arbitrary JS — but it is a route
 * to arbitrary markup and a full-page overlay, the CSP is not the only way this
 * app is served, and a defence that depends entirely on a header set elsewhere
 * is not a defence of this code.
 *
 * A deny-list rather than an allow-list, deliberately: the cabinet's catalog
 * does not carry per-effect prop names (the components declare their own
 * defaults, which is what keeps the two repositories from drifting), and the
 * dangerous surface is exactly React's reserved names. An unrecognised prop
 * that is NOT on this list reaches a `<div>` as an inert attribute.
 */
const FORBIDDEN_EFFECT_PROPS = new Set([
  "dangerouslySetInnerHTML",
  "style",
  "className",
  "class",
  "children",
  "ref",
  "key",
  "suppressHydrationWarning",
  "suppressContentEditableWarning",
]);

/**
 * Strip prop names that would escape the component and reach the DOM.
 *
 * Returns the same object when there is nothing to remove, so the common case
 * costs one pass and no allocation, and referential equality is preserved for
 * anything memoising on it.
 */
export function sanitizeCardEffectProps(
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const unsafe = Object.keys(props).filter(
    (key) =>
      FORBIDDEN_EFFECT_PROPS.has(key) ||
      // `onClick`, `onError`, … — React binds anything shaped like this as a
      // handler on the underlying element.
      /^on[A-Z]/.test(key),
  );
  if (unsafe.length === 0) return props;

  const safe: Record<string, unknown> = { ...props };
  for (const key of unsafe) delete safe[key];
  return safe;
}

/** Alpha above which a sampled pixel counts as painted. Above dithering noise,
 *  far below anything an operator would call visible. */
const PAINTED_ALPHA_THRESHOLD = 8;
const SAMPLE_EDGE = 8;

/**
 * What the operator's backdrop keeps while a shader is on top of it.
 *
 * Both ends of this number are constraints rather than taste, and it is the
 * only number that reconciles them:
 *
 *  - Low enough that a WORKING shader no longer shows the backdrop as a
 *    competing image, which is the whole reason the fade exists. A concept
 *    gradient spans roughly a third of the lightness range end to end; at 0.12
 *    over the flat foundation that is about four percent of lightness across
 *    the entire card — a tone, not an edge. The diagonal pattern layer, which
 *    rests at 0.4, lands at 0.048, below the alpha at which a hairline over a
 *    mid tone reads as a line rather than as grain. That is the artefact the
 *    original report described.
 *  - High enough that a shader which silently drew NOTHING still leaves the
 *    operator's artwork faintly on the card instead of an empty rectangle.
 *    Nothing below can tell those two cases apart, so this value is paid in
 *    both of them.
 *
 * One number for `webgl1` and `webgl2` alike: what makes it necessary is the
 * compositing model, which both share.
 */
export const WEBGL_BACKDROP_RESIDUAL_OPACITY = 0.12;

export interface CardEffectBackdropPolicy {
  /**
   * The backdrop's opacity while this effect is up, as a multiplier on each
   * backdrop layer's own resting value. `1` leaves the backdrop untouched.
   */
  readonly coveredOpacity: number;
  /**
   * `"pixels"` — `sampleCardEffectPainted` can answer for this effect and the
   * caller must wait for it. `"none"` — nothing can answer, so there is nothing
   * to wait for and nothing to ask the canvas.
   */
  readonly evidence: "pixels" | "none";
}

/**
 * How far the backdrop steps back for `effect`, and whether anything can prove
 * it should.
 *
 * The backdrop is the operator's gradient and its pattern. It steps back once
 * an effect paints, because a concept theme's diagonal artwork read through a
 * transparent shader looks like a rendering fault rather than like design.
 * Stepping back needs a reason, and the reason available depends entirely on
 * what draws.
 *
 *  - `canvas2d` retains its bitmap after compositing, so reading pixels back is
 *    a real answer about a real frame. Proof, so the backdrop goes all the way
 *    out.
 *  - `webgl1`/`webgl2`: THERE IS NO ANSWER. Whether a shader drew anything is
 *    not observable from JavaScript once the frame has been composited, and two
 *    attempts to observe it anyway both reported the opposite of the truth.
 *    Sampling pixels: the drawing buffer is cleared at composite time unless the
 *    context asked for `preserveDrawingBuffer`, so a read scheduled from a timer
 *    returned transparent for every WORKING shader in the catalog — the feature
 *    was dead, at the price of five forced GPU→CPU readbacks per mount. Asking
 *    `isContextLost()`: it answers `false` for a live context, which is exactly
 *    what the failure this was written for leaves behind — `getContext('webgl2')`
 *    returns null under GPU pressure, OGL drops to WebGL1, a GLSL ES 3.00 shader
 *    fails to compile with nothing but a `console.warn`, and a live context sits
 *    over a blank canvas. Context alive, evidence says "painted", card empty.
 *
 * So a shader's backdrop is not faded out, it is faded DOWN, to
 * `WEBGL_BACKDROP_RESIDUAL_OPACITY`. That is not a compromise between two
 * guesses; it is what is left when the question cannot be asked at all.
 *
 * `css-fallback` is not decided here: the layer never asks for a policy in that
 * mode. It is a translucent radial built so the operator's gradient stays
 * visible, and it must not fade by any amount.
 *
 * An unknown id has no renderer, never mounts, and draws nothing; it takes the
 * `canvas2d` branch, where the sampler will find no canvas and say so.
 */
export function resolveCardEffectBackdropPolicy(
  effect: string,
): CardEffectBackdropPolicy {
  const renderer = cardEffectRenderer(effect);
  return renderer === "webgl1" || renderer === "webgl2"
    ? { coveredOpacity: WEBGL_BACKDROP_RESIDUAL_OPACITY, evidence: "none" }
    : { coveredOpacity: 0, evidence: "pixels" };
}

/**
 * Did this effect actually draw?
 *
 * Answerable only for renderers that keep what they drew — see
 * `resolveCardEffectBackdropPolicy`, which is also what decides whether it is
 * worth asking.
 *
 * The asymmetry the caller depends on: only an explicit `false` means "blank".
 * `null` — no canvas, a refused read, an unsized canvas, a renderer this cannot
 * interrogate — means "cannot tell", which the layer reads as "carry on". So
 * this function must be certain before it answers `false`.
 */
export function sampleCardEffectPainted(
  root: HTMLElement,
  effect: string,
): boolean | null {
  // A shader's canvas is asked nothing at all, and this returns before it is
  // even located. Not only because the answer would be meaningless: `getContext`
  // CREATES a context on a canvas that has none and never hands it back, which
  // lands precisely on the renderer that failed to start — the low-GPU device
  // where WebKit's sixteen-context ceiling is already the problem. Per spec a
  // later `getContext` on the same canvas ignores the attributes it asks for
  // and hands back the context that already exists, so one created here would
  // also quietly overrule the renderer's own: `Dither` declines `antialias`,
  // and would be handed the multisampled backbuffer it declined.
  if (resolveCardEffectBackdropPolicy(effect).evidence !== "pixels") return null;

  const canvases = [...root.querySelectorAll("canvas")];
  // No canvas is the honest `null` for a DOM- or SVG-drawn effect: it cannot
  // fail this way, because if React rendered it the pixels are already there.
  if (canvases.length === 0) return null;

  return sampleCanvasPixels(canvases);
}

/** Evidence for a 2D canvas, which still holds its bitmap after compositing. */
function sampleCanvasPixels(
  canvases: readonly HTMLCanvasElement[],
): boolean | null {
  let sampled = false;
  for (const canvas of canvases) {
    if (canvas.width === 0 || canvas.height === 0) continue;
    try {
      // Downscale the whole canvas into a few dozen pixels rather than reading
      // it at size: one `drawImage` and 64 pixels of `getImageData` is cheap
      // enough to repeat, and a full-frame read on a retina card is not.
      const probe = document.createElement("canvas");
      probe.width = SAMPLE_EDGE;
      probe.height = SAMPLE_EDGE;
      const context = probe.getContext("2d", { willReadFrequently: true });
      if (context === null) continue;
      context.drawImage(canvas, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
      const { data } = context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
      sampled = true;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > PAINTED_ALPHA_THRESHOLD) return true;
      }
    } catch {
      // A browser that will not hand back the drawing buffer tells us nothing
      // either way, and "nothing" must not be read as "blank".
      return null;
    }
  }

  return sampled ? false : null;
}

/**
 * How long a lost context has to come back before it counts as a failure.
 *
 * WHY THE FAILURE IS DELAYED AT ALL. It cannot be reported first and withdrawn
 * later: a reported failure resolves the runtime to `css-fallback`, which
 * unmounts the effect — taking the canvas, and therefore the only thing that
 * could ever hear `webglcontextrestored`, out of the document. So the choice is
 * to wait or to be permanently deaf, and this is the wait.
 *
 * Long enough for a browser that means to restore: Blink schedules the first
 * restore attempt immediately and retries about a second apart, so this covers
 * one retry. Short enough that the case which never comes back — WebKit's
 * `SyntheticLostContext`, handed to whichever context the seventeenth evicts,
 * which its own source marks unrecoverable — reaches the CSS fallback while the
 * user is still looking at the same screen. The cost of waiting is a dead
 * canvas over the residual backdrop for this long, and it is only ever paid
 * after a real GPU event; the cost of not waiting was a permanently static card.
 */
export const CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS = 2_000;

/**
 * Observe canvases created by a lazy effect and report both explicit WebGL
 * failures and silent renderer initialisation failures. Several GPU libraries
 * only log when context creation fails, which otherwise leaves a blank layer.
 * Canvas 2D renderers also need a real 2D context: a bare canvas is not a
 * usable presentation and must reach the same CSS fallback.
 *
 * Since `sampleCardEffectPainted` stopped interrogating shader contexts, this
 * is the ONLY thing that notices a WebGL context going away — by listening for
 * the event rather than by polling for the state. It therefore covers a context
 * that dies while the card is up, which is the case WebKit produces when it
 * recycles the oldest of its sixteen. It cannot cover one that was already lost
 * before these listeners attached; see the failure notes in the layer.
 *
 * WHAT WENT WRONG. Every `webglcontextlost` was a permanent failure. The handler
 * did not call `preventDefault()` — and per the WebGL spec that is the ONLY
 * thing that asks the user agent to restore a context, so without it
 * `webglcontextrestored` can never fire — and nothing listened for the restore
 * either. One transient GPU event (sleep/wake, a driver reset, a tab coming back
 * from the background) therefore stranded the card as a static gradient until
 * the page was reloaded. That is the permanent half of the "animations disappear
 * to a static card" report.
 *
 * `onContextRestored` is how a restorable loss actually gets restored. It
 * returns whether the caller took the rebuild: a caller that has spent its
 * rebuild budget answers `false`, and the loss becomes an ordinary failure
 * immediately, which is what stops a GPU that keeps losing and restoring from
 * driving an unbounded rebuild loop. With no callback at all every loss is still
 * a failure, only later.
 *
 * The three roles do not fight each other. Several effects (`Plasma`,
 * `Grainient`, `CosmicOrb`, and the three fiber ones through three.js) carry
 * their own loss/restore handling; `preventDefault()` is idempotent, so a second
 * caller changes nothing, and a rebuild here REPLACES that component rather than
 * racing it — it costs those effects one redundant rebuild, which is bounded by
 * the caller's budget and is the price of the ~40 catalog components that have
 * no recovery of their own and would otherwise come back to a blank canvas.
 */
export function observeCardEffectCanvases(
  root: HTMLElement,
  onFailure: () => void,
  timeoutMs = 1_200,
  requiredContext?: "2d",
  onContextRestored?: () => boolean,
  restoreGraceMs = CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS,
): () => void {
  const listeners = new Map<HTMLCanvasElement, () => void>();
  const awaitingRestore = new Map<HTMLCanvasElement, number>();
  let sawCanvas = false;
  let reportedFailure = false;

  const reportFailureOnce = () => {
    if (reportedFailure) return;
    reportedFailure = true;
    onFailure();
  };

  const stopWaiting = (canvas: HTMLCanvasElement) => {
    const timer = awaitingRestore.get(canvas);
    if (timer === undefined) return false;
    window.clearTimeout(timer);
    awaitingRestore.delete(canvas);
    return true;
  };

  const observeCanvas = () => {
    root.querySelectorAll("canvas").forEach((canvas) => {
      if (listeners.has(canvas)) return;
      if (requiredContext === "2d") {
        try {
          if (canvas.getContext("2d") === null) {
            reportFailureOnce();
            return;
          }
        } catch {
          reportFailureOnce();
          return;
        }
      }
      sawCanvas = true;

      const handleContextLost = (event: Event) => {
        // A canvas that has left the document is being torn down, and the loss
        // is this app's own `loseContext()` handing the slot back. Do not
        // `preventDefault()` it — that would ask the browser to restore a
        // context we are deliberately giving up, under a ceiling of sixteen —
        // and do not report it: nothing is on screen to have failed.
        if (!canvas.isConnected) return;
        // Not a gesture event: this blocks nothing. It is the whole difference
        // between a context that can come back and one that cannot.
        event.preventDefault();
        if (awaitingRestore.has(canvas)) return;
        awaitingRestore.set(
          canvas,
          window.setTimeout(() => {
            awaitingRestore.delete(canvas);
            reportFailureOnce();
          }, restoreGraceMs),
        );
      };

      const handleContextRestored = () => {
        // Only a loss this observer deferred can be answered by a restore. A
        // restore with nothing pending belongs to a teardown, or to a component
        // that healed a loss we never saw.
        if (!stopWaiting(canvas)) return;
        if (onContextRestored?.() === true) return;
        reportFailureOnce();
      };

      canvas.addEventListener("webglcontextlost", handleContextLost);
      canvas.addEventListener("webglcontextrestored", handleContextRestored);
      canvas.addEventListener("webglcontextcreationerror", reportFailureOnce);
      listeners.set(canvas, () => {
        stopWaiting(canvas);
        canvas.removeEventListener("webglcontextlost", handleContextLost);
        canvas.removeEventListener(
          "webglcontextrestored",
          handleContextRestored,
        );
        canvas.removeEventListener(
          "webglcontextcreationerror",
          reportFailureOnce,
        );
      });
    });
  };

  const observer = new MutationObserver(observeCanvas);
  observer.observe(root, { childList: true, subtree: true });
  observeCanvas();
  const readinessTimer = window.setTimeout(() => {
    if (!sawCanvas) reportFailureOnce();
  }, timeoutMs);

  return () => {
    window.clearTimeout(readinessTimer);
    observer.disconnect();
    listeners.forEach((remove) => remove());
  };
}
