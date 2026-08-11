/** Runtime helpers shared by the subscription-card effect layer and tests. */

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

/*
 * NOTHING HERE DIMS THE OPERATOR'S BACKDROP, AND THAT IS THE DECISION.
 *
 * This module used to carry a backdrop policy (`resolveCardEffectBackdropPolicy`,
 * `WEBGL_BACKDROP_RESIDUAL_OPACITY`) and a pixel sampler
 * (`sampleCardEffectPainted`) whose only purpose was to fade the operator's
 * gradient down — to 0.12 under a shader, to 0 under a `canvas2d` effect —
 * once the layer believed the effect had drawn. The whole chain is removed:
 * the effect draws OVER the gradient, which keeps its own resting opacity for
 * as long as the card is up.
 *
 * The product owner made that call, and it reverses the earlier one
 * deliberately. The admin panel's preview never dimmed the gradient; the live
 * cabinet disagreeing with the preview was the defect, not the gradient showing
 * through. Card artwork is one composition the operator authors from both
 * layers, and neither half is a rendering fault.
 *
 * Do not reintroduce it "properly". The sampler cost five forced GPU→CPU
 * readbacks per mount on exactly the low-end devices this layer is careful
 * with, and for a shader it could never answer at all — see the removed notes
 * in git history before repeating either experiment. No caller asks whether an
 * effect painted, and none should need to.
 */

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
 * canvas over the operator's gradient for this long, and it is only ever paid
 * after a real GPU event; the cost of not waiting was a permanently static card.
 */
export const CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS = 2_000;

/**
 * How long a COMMITTED renderer has to put a canvas in the document before its
 * silence counts as a failure.
 *
 * Measured from the commit, never from the request. The observer now attaches
 * before the renderer mounts (see below), and the wait in front of it is a lazy
 * chunk download on whatever connection the phone has — timing that as a GPU
 * fault would fall back on a slow network. The caller passes `null` while the
 * renderer has not committed, and this number once it has.
 */
export const CARD_EFFECT_RENDERER_READY_TIMEOUT_MS = 1_200;

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function pageIsHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * A deferred context loss, and how much of its grace window is left.
 *
 * `remainingMs` rather than a deadline because the window does not run while
 * the page is hidden — see `handleVisibility`.
 */
interface PendingContextRestore {
  timer: number | null;
  remainingMs: number;
  armedAt: number;
}

/**
 * Observe canvases created by a lazy effect and report both explicit WebGL
 * failures and silent renderer initialisation failures. Several GPU libraries
 * only log when context creation fails, which otherwise leaves a blank layer.
 * Canvas 2D renderers also need a real 2D context: a bare canvas is not a
 * usable presentation and must reach the same CSS fallback.
 *
 * This is the ONLY thing that notices a WebGL context going away — and it
 * notices by listening for the event, never by polling for the state or by
 * interrogating a canvas. It therefore covers a context that dies while the
 * card is up, which is the case WebKit produces when it recycles the oldest of
 * its sixteen.
 *
 * WHERE THE LISTENERS LIVE, AND WHY IT IS THE CONTAINER. They are attached to
 * `root` in the CAPTURE phase, not to each canvas, and the caller attaches this
 * observer BEFORE the renderer is mounted. Both halves are the fix for the same
 * defect: `webglcontextcreationerror` is dispatched from inside `getContext()`,
 * so a listener that waits for the canvas to exist — which is what per-canvas
 * listeners discovered through the MutationObserver below necessarily do — can
 * never hear it. A capture listener on an ancestor is in the propagation path
 * of a non-bubbling event too, so one container listener hears every canvas the
 * renderer puts inside it, including one it appends and immediately draws on.
 *
 * WHAT IS STILL UNHEARABLE, stated so it is not rediscovered. A renderer that
 * creates a DETACHED canvas, calls `getContext()` on it and only then appends it
 * — ogl and three.js both do exactly this — dispatches its creation error at a
 * node with no ancestors, so no listener anywhere in the document can receive
 * it. That case surfaces as "no canvas ever appeared" (the readiness timeout),
 * as a throw caught by the layer's error boundary, or not at all.
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
 *
 * THE GRACE WINDOW DOES NOT RUN WHILE THE PAGE IS HIDDEN, and that is load-
 * bearing rather than tidy. A hidden tab's timers are throttled or frozen
 * outright, so the window above used to be spent in a tab nobody was looking at
 * and fire the instant the user came back — reporting a permanent failure at the
 * exact moment the browser was about to restore the context. The app background
 * is the layer that showed it: it stays mounted while hidden by design, so a
 * loss during an app-switch left it in the CSS fallback for the rest of the
 * session. The window is therefore paused on `visibilitychange` and resumed with
 * whatever is left of it, so the browser is always measured against real time in
 * front of the user.
 */
export function observeCardEffectCanvases(
  root: HTMLElement,
  onFailure: () => void,
  timeoutMs: number | null = CARD_EFFECT_RENDERER_READY_TIMEOUT_MS,
  requiredContext?: "2d",
  onContextRestored?: () => boolean,
  restoreGraceMs = CARD_EFFECT_CONTEXT_RESTORE_GRACE_MS,
): () => void {
  const seen = new Set<HTMLCanvasElement>();
  const awaitingRestore = new Map<HTMLCanvasElement, PendingContextRestore>();
  let sawCanvas = false;
  let reportedFailure = false;

  const reportFailureOnce = () => {
    if (reportedFailure) return;
    reportedFailure = true;
    onFailure();
  };

  const arm = (canvas: HTMLCanvasElement, pending: PendingContextRestore) => {
    if (pending.timer !== null || pageIsHidden()) return;
    pending.armedAt = monotonicNow();
    pending.timer = window.setTimeout(() => {
      awaitingRestore.delete(canvas);
      reportFailureOnce();
    }, pending.remainingMs);
  };

  const disarm = (pending: PendingContextRestore) => {
    if (pending.timer === null) return;
    window.clearTimeout(pending.timer);
    pending.timer = null;
    pending.remainingMs = Math.max(
      0,
      pending.remainingMs - (monotonicNow() - pending.armedAt),
    );
  };

  const stopWaiting = (canvas: HTMLCanvasElement) => {
    const pending = awaitingRestore.get(canvas);
    if (pending === undefined) return false;
    disarm(pending);
    awaitingRestore.delete(canvas);
    return true;
  };

  const canvasOf = (event: Event): HTMLCanvasElement | null =>
    event.target instanceof HTMLCanvasElement ? event.target : null;

  const handleContextLost = (event: Event) => {
    const canvas = canvasOf(event);
    // A canvas that has left the document is being torn down, and the loss is
    // this app's own `loseContext()` handing the slot back. Do not
    // `preventDefault()` it — that would ask the browser to restore a context
    // we are deliberately giving up, under a ceiling of sixteen — and do not
    // report it: nothing is on screen to have failed.
    if (canvas === null || !canvas.isConnected) return;
    // Not a gesture event: this blocks nothing. It is the whole difference
    // between a context that can come back and one that cannot.
    event.preventDefault();
    if (awaitingRestore.has(canvas)) return;
    const pending: PendingContextRestore = {
      timer: null,
      remainingMs: restoreGraceMs,
      armedAt: monotonicNow(),
    };
    awaitingRestore.set(canvas, pending);
    // Nothing is armed while the page is hidden; `handleVisibility` starts the
    // window when the user is back and can actually see the result.
    arm(canvas, pending);
  };

  const handleContextRestored = (event: Event) => {
    const canvas = canvasOf(event);
    // Only a loss this observer deferred can be answered by a restore. A
    // restore with nothing pending belongs to a teardown, or to a component
    // that healed a loss we never saw.
    if (canvas === null || !stopWaiting(canvas)) return;
    if (onContextRestored?.() === true) return;
    reportFailureOnce();
  };

  const handleVisibility = () => {
    if (pageIsHidden()) {
      awaitingRestore.forEach((pending) => disarm(pending));
      return;
    }
    awaitingRestore.forEach((pending, canvas) => arm(canvas, pending));
  };

  const observeCanvas = () => {
    root.querySelectorAll("canvas").forEach((canvas) => {
      if (seen.has(canvas)) return;
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
      seen.add(canvas);
      sawCanvas = true;
    });
  };

  // Capture phase, on the container: see the note above. The MutationObserver
  // below is no longer what makes the events audible — it only answers "did a
  // usable canvas ever appear".
  root.addEventListener("webglcontextlost", handleContextLost, true);
  root.addEventListener("webglcontextrestored", handleContextRestored, true);
  root.addEventListener("webglcontextcreationerror", reportFailureOnce, true);
  document.addEventListener("visibilitychange", handleVisibility);

  const observer = new MutationObserver(observeCanvas);
  observer.observe(root, { childList: true, subtree: true });
  observeCanvas();
  const readinessTimer =
    timeoutMs === null
      ? null
      : window.setTimeout(() => {
          if (!sawCanvas) reportFailureOnce();
        }, timeoutMs);

  return () => {
    if (readinessTimer !== null) window.clearTimeout(readinessTimer);
    observer.disconnect();
    root.removeEventListener("webglcontextlost", handleContextLost, true);
    root.removeEventListener(
      "webglcontextrestored",
      handleContextRestored,
      true,
    );
    root.removeEventListener(
      "webglcontextcreationerror",
      reportFailureOnce,
      true,
    );
    document.removeEventListener("visibilitychange", handleVisibility);
    awaitingRestore.forEach((pending) => disarm(pending));
    awaitingRestore.clear();
  };
}
