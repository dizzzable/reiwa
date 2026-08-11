/**
 * CardEffectLayer
 * ───────────────
 * Renders an animated ReactBits effect behind a subscription card. Driven by
 * the operator's branding (`cardEffect` + `cardEffectProps` + opacity) or a
 * per-subscription override.
 *
 * Safety:
 *  - Lazy-loads the effect so the WebGL/canvas code only downloads when used.
 *  - Degrades GPU failures to a same-palette CSS layer.
 *  - Only renders while on-screen (IntersectionObserver) so off-screen carousel
 *    slides and scrolled-away cards pause their GPU work.
 *
 * Card artwork is an operator-selected part of the brand and must render the
 * same way in the live cabinet as it does in the Rezeis preview. It is
 * therefore not disabled by the browser's decorative reduced-motion hint.
 * CSS fallback is reserved for genuine canvas/WebGL capability failures.
 *
 * What this layer does NOT detect, stated so it is not rediscovered a fourth
 * time. For a WebGL effect, "the renderer started but nothing reached the
 * screen" is invisible from here — the drawing buffer is gone by the time any
 * timer runs and a live context proves nothing. The layer does not try, and it
 * no longer needs to: it does not touch the operator's gradient, so a renderer
 * that draws nothing leaves the card showing the operator's artwork rather
 * than an empty rectangle. Consequences, all real:
 *  - A context that dies silently — no `webglcontextlost`, a frozen picture —
 *    is not noticed while the user stays on the page. It is answered only on the
 *    way back in: a return from the back/forward cache rebuilds the renderer
 *    without evidence, because after a bfcache thaw the context is dead more
 *    often than not.
 *  - A context that dies more than `MAX_CONTEXT_RESTORES` times WITHIN one
 *    recovery window stops being rebuilt and becomes the CSS fallback, even if
 *    the browser was willing to restore it again. That is deliberate, and it is
 *    a window rather than a lifetime: see the constant and
 *    `CARD_EFFECT_RECOVERY_CREDIT_MS`.
 *  - Neither the failure state nor the capability probe survives a return that
 *    finds the layer in the CSS fallback: coming back to a card that is not
 *    running is worth one bounded attempt, and used to be worth a page reload.
 *
 * WHAT THIS LAYER NO LONGER DOES, AND MUST NOT DO AGAIN. It used to report a
 * backdrop opacity to the frame, so the operator's gradient faded down (0.12
 * under a shader) or out (0 under a `canvas2d` effect) once the effect was
 * believed to have painted — which is what the periodic pixel sampling existed
 * to establish. The product owner reversed that: the effect draws OVER the
 * gradient and nothing dims it. The admin preview never dimmed, and the live
 * cabinet disagreeing with the preview was the actual defect. See the note in
 * `card-effect-layer-utils.ts` before reaching for a "cheaper" version of it.
 */

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  CARD_EFFECT_COMPONENTS,
  cardEffectDefaults,
  isKnownCardEffect,
} from "./card-effect-manifest";
import { clampCardEffectProps } from "./card-effect-bounds";
import {
  detectCardEffectCapabilities,
  requiresWebGL,
  resolveCardEffectColors,
  resolveCardEffectRuntime,
} from "./card-effect-runtime";
import {
  CARD_EFFECT_RENDERER_READY_TIMEOUT_MS,
  observeCardEffectCanvases,
  resolveCardEffectOverlayOpacity,
  sanitizeCardEffectProps,
} from "./card-effect-layer-utils";

/**
 * How many times one presentation may be rebuilt after a restorable context
 * loss before the loss is treated as the permanent kind.
 *
 * A restored context is a real recovery, so the honest response is to rebuild:
 * only a handful of catalog components can heal themselves, and the rest come
 * back to a canvas whose GL handles the loss detached. But "the browser
 * restored it" is not a promise that it will stay, and a GPU that keeps losing
 * and restoring would otherwise drive an unbounded rebuild loop — each turn of
 * it allocating another context under WebKit's sixteen. Two is enough for a
 * sleep/wake or a driver reset and short enough that a thrashing device reaches
 * the CSS fallback quickly. Budget is per `failureScope`, so anything the
 * operator changes starts again — and, since the defect below, per RECOVERY
 * too: see `CARD_EFFECT_RECOVERY_CREDIT_MS`.
 */
const MAX_CONTEXT_RESTORES = 2;

/**
 * How many times coming back to this layer may restart a renderer that is not
 * running.
 *
 * WHAT WENT WRONG: nothing ever retried. A context that failed to be created, a
 * shader that did not compile, a loss whose grace window expired — each of them
 * resolved the layer to the CSS fallback and left it there for the lifetime of
 * the page, so the only cure a user had was a reload. On a phone that is the
 * common case rather than the exotic one: the GPU is busiest exactly while the
 * app is being switched to, which is exactly when this layer is (re)building.
 *
 * Bounded, and the bound is not timidity. A rebuild allocates another context
 * under WebKit's sixteen and recompiles a shader; a layer that retried on every
 * return would, on a device that cannot run the effect at all, spend the whole
 * session doing that instead of showing the operator's gradient — worse than no
 * animation. Two is a sleep/wake and a second chance. Spent budget is returned
 * by a cycle that actually worked, so a user who returns tomorrow is not paying
 * for a GPU hiccup today.
 */
export const MAX_RETURN_RESTARTS = 2;

/**
 * How long a presentation has to keep running before the restart and rebuild
 * budgets above are handed back.
 *
 * The budgets exist to stop a thrashing device from rebuilding for ever, and a
 * refund on "the renderer committed" would defeat exactly that: lose → rebuild →
 * ready → refund → lose is an unbounded loop with extra steps. Time in front of
 * the user is what distinguishes a recovery from a thrash, so the refund is
 * delayed by enough of it that a genuinely broken device can only spend its
 * budget once per this interval, while a card that ran for ten seconds and then
 * hit a transient loss starts from a full budget.
 *
 * This is the other half of "после третьего возврата перестало совсем": the
 * budget was never returned, so three transient losses over an hour were spent
 * as if they had been three in a row.
 */
export const CARD_EFFECT_RECOVERY_CREDIT_MS = 10_000;

/**
 * How long the effect takes to fade in over the operator's gradient.
 *
 * It used to be shared with the frame, which faded the gradient out on the same
 * schedule. The gradient no longer moves at all — see the note at the top of
 * this file — so this is one fade, not two halves of a crossfade.
 */
export const CARD_EFFECT_REVEAL_MS = 420;

/**
 * How long a torn-down presentation may be away before coming back counts as a
 * first appearance again.
 *
 * WHAT WENT WRONG: the fade above was built for the FIRST time a card shows its
 * artwork — the complaint was that the effect arrived abruptly, between two
 * frames 50 ms apart. But a carousel tears the renderer down the moment its
 * slide stops being the selected one and rebuilds it when the user swipes back,
 * and the fade was re-paid every time: measured at one frame plus the whole
 * 420 ms, during which the card is the operator's flat gradient and watermark.
 * Swiping between two subscriptions therefore showed a static card on every
 * swipe, in both directions.
 *
 * So a reveal is remembered. Coming back to artwork the user was looking at
 * moments ago is not an appearance and does not fade; coming back after a real
 * absence is, and does. The window is measured from the moment the presentation
 * was RELEASED, not from when it was first shown — a card watched for a minute
 * and then swiped away for one second must still count as returning promptly.
 *
 * Thirty seconds covers a swipe, a pagination jump, and the app-switch a
 * Telegram mini-app takes constantly; it does not cover leaving the cabinet
 * open in a background tab, where the artwork genuinely is new again.
 */
export const CARD_EFFECT_REVEAL_MEMORY_MS = 30_000;

/**
 * How the layer is showing its presentation.
 *  - `hidden`  — nothing committed, or torn down. Transparent.
 *  - `fade`    — first appearance of this presentation: crossfade in.
 *  - `instant` — the same presentation returning promptly: no transition at
 *                all, so the browser has nothing to animate from.
 */
type CardEffectRevealPhase = "hidden" | "fade" | "instant";

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

interface CardEffectLayerProps {
  readonly effect: string;
  readonly props?: Record<string, unknown>;
  readonly opacity?: number;
  readonly className?: string;
  /**
   * Ownership decided by the parent, replacing this layer's own
   * IntersectionObserver. Left `undefined` for standalone usage, where that
   * observer drives mounting.
   *
   * NOT "exactly one card at a time" — it was, and the number moved. The
   * carousel now passes `true` to the selected slide AND to a neighbour the
   * shared context budget has granted, so a swipe finds the renderer already
   * running instead of rebuilding it in front of the user. What bounds the
   * total is `card-effect-budget.ts`, which every card except the selected
   * slide asks; read `useCardEffectWarmSlot` before assuming a count here.
   */
  readonly active?: boolean;
  /**
   * Keep the renderer mounted while the page is hidden.
   *
   * WHAT WENT WRONG: hiding the page unmounted EVERY layer, including the app
   * background. That layer is one always-mounted full-screen shader, so a
   * Telegram app-switch — which a mini-app takes constantly — tore its context
   * down and recompiled the shader on return, flashing the flat base gradient
   * each time.
   *
   * A card is the opposite case and the default stays with it: cards are many,
   * their live contexts are rationed against WebKit's 16-per-process cap, and
   * each of them integrates its own motion from a `requestAnimationFrame`
   * timestamp that jumps by the whole absence. One background layer costs one
   * context that was never contended, and it is behind everything, so its clock
   * lurching is not something a user can see. Cards pay to unmount; the
   * background only pays.
   */
  readonly keepMountedWhileHidden?: boolean;
}

/**
 * The effect-opacity control is part of the operator's published card design.
 * Do not impose a second, hidden ceiling here: a saved 100% must remain 100%
 * in both the live cabinet and Rezeis preview. The card gradient is a separate
 * foundation layer, so this clamp only protects the valid input range.
 */
class EffectErrorBoundary extends Component<{
  children: ReactNode;
  resetKey: string;
  onError: () => void;
}, { hasError: boolean; resetKey: string }> {
  state = { hasError: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { hasError: boolean; resetKey: string },
  ) {
    return props.resetKey === state.resetKey
      ? null
      : { hasError: false, resetKey: props.resetKey };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

function CssEffectFallback({
  colors,
  opacity,
}: {
  readonly colors: readonly string[];
  readonly opacity: number;
}) {
  const first = colors[0] ?? "#5227FF";
  const middle = colors[Math.floor((colors.length - 1) / 2)] ?? first;
  const last = colors.at(-1) ?? middle;

  return (
    <div
      aria-hidden
      data-card-effect-artwork
      className="card-effect-layer__css-fallback absolute inset-0"
      style={{ opacity }}
    >
      {/* The fallback remains alpha artwork. A full-frame opaque gradient
          here would replace a custom card gradient as soon as an unavailable
          WebGL effect falls back. Alpha source-over composition keeps the card
          gradient and pattern visible beneath the palette fields.

          One blob per colour field, drifted by transform instead of the old
          multi-background `background-position` animation (paint every frame
          on exactly the WebGL-less iOS devices this path serves — see
          index.css). DOM order c → b → a mirrors the old background list,
          where the `first` layer painted on top. */}
      <div
        className="card-effect-layer__css-fallback-blob card-effect-layer__css-fallback-blob--c"
        style={{
          backgroundImage: `radial-gradient(54% 66% at 52% 50%, ${middle} 0%, transparent 82%)`,
        }}
      />
      <div
        className="card-effect-layer__css-fallback-blob card-effect-layer__css-fallback-blob--b"
        style={{
          backgroundImage: `radial-gradient(66% 100% at 100% 2%, ${last} 0%, transparent 72%)`,
        }}
      />
      <div
        className="card-effect-layer__css-fallback-blob card-effect-layer__css-fallback-blob--a"
        style={{
          backgroundImage: `radial-gradient(70% 110% at 4% 100%, ${first} 0%, transparent 72%)`,
        }}
      />
    </div>
  );
}

function EffectReadySignal({
  presentationKey,
  onReady,
}: {
  readonly presentationKey: string;
  readonly onReady: (key: string) => void;
}) {
  useEffect(() => {
    onReady(presentationKey);
  }, [onReady, presentationKey]);

  return null;
}

export function CardEffectLayer({
  effect,
  props,
  opacity = 1,
  className,
  active,
  keepMountedWhileHidden = false,
}: CardEffectLayerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [readyPresentationKey, setReadyPresentationKey] = useState<
    string | null
  >(null);
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<{
    readonly effect: string;
    readonly capabilities: ReturnType<typeof detectCardEffectCapabilities>;
  } | null>(null);
  const [failureState, setFailureState] = useState<{
    readonly scope: string;
    readonly count: number;
  } | null>(null);

  // Mount the effect while the card is on screen (standalone usage). In the
  // carousel the parent passes an explicit `active` boolean: in that mode it
  // drives mounting EXCLUSIVELY (ignore the IntersectionObserver), and the
  // number of cards it says yes to is rationed by `card-effect-budget.ts`
  // rather than pinned at one — see the `active` prop.
  //
  // WebKit allows 16 live contexts per web-content process, and the 17th does
  // not merely evict the oldest — it hands that one a SyntheticLostContext,
  // which WebKit's own source marks unrecoverable, so `preventDefault()` cannot
  // bring it back. Worse, a context leaves the pool only when its object is
  // destroyed, so dropping a reference frees nothing until GC gets round to it.
  // That combination is exactly the "cards go black one by one" report, and it
  // is why mounting is rationed here rather than left to the browser.
  // Visibility is an external IntersectionObserver signal, not state derived
  // from `active`; the dependency only enables/disables standalone tracking.
  useEffect(() => {
    if (active !== undefined) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.01 },
    );
    // eslint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  /**
   * Nothing runs while the page is hidden.
   *
   * WebKit does not throttle `requestAnimationFrame` for a backgrounded page,
   * it suspends it outright. The first callback after the user comes back
   * therefore arrives with a timestamp that jumped by the entire time they were
   * away, and every effect that integrates its own motion from that delta
   * lurches — minutes of animation in one frame. Which effects lurch and which
   * clamp is a per-component accident, and this layer cannot police it.
   *
   * Unmounting is the answer to both halves of the problem: the clock restarts
   * from nothing on return, and the GPU context is handed back for as long as
   * the user is elsewhere. That second half matters more than it sounds on a
   * phone, where a Telegram mini-app is backgrounded constantly and iOS reclaims
   * memory from whatever is not in front of the user.
   *
   * `keepMountedWhileHidden` opts a caller out; see the prop for why the app
   * background is the one layer that wants that.
   */
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  /**
   * A return the layer has not answered yet, and whether it came out of the
   * back/forward cache.
   *
   * A counter rather than a boolean because the answer is given in an effect and
   * must be given exactly once per return: dependency churn re-runs that effect,
   * and a boolean would let one return spend the restart budget several times.
   */
  const [returnTicket, setReturnTicket] = useState(0);
  const awayRef = useRef(false);
  const bfcacheReturnRef = useRef(false);

  /**
   * `visibilitychange` alone was not enough, and the missing half is bfcache.
   *
   * Going "back" to this app does not re-run the page: the browser freezes the
   * document into the back/forward cache and thaws it, and on iOS and Android
   * Chromium alike that thaw can arrive WITHOUT a `visibilitychange` — the
   * document never became hidden as far as that event is concerned, it stopped
   * existing and started again. `pagehide`/`pageshow` are the events that do
   * fire, and until this there was not one handler for either anywhere in the
   * front end, so a card that came back from bfcache came back to a dead GPU
   * context and no one asked.
   *
   * `pageshow.persisted` is the difference that matters: a normal load fires
   * `pageshow` too, and that one must not be treated as a return.
   */
  useEffect(() => {
    const leave = () => {
      awayRef.current = true;
      setPageVisible(false);
    };
    const arrive = (fromBfcache: boolean) => {
      const returning = awayRef.current || fromBfcache;
      awayRef.current = false;
      if (fromBfcache) bfcacheReturnRef.current = true;
      setPageVisible(true);
      if (returning) setReturnTicket((ticket) => ticket + 1);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
      else arrive(false);
    };
    const onPageHide = () => leave();
    const onPageShow = (event: PageTransitionEvent) => {
      if (document.visibilityState === "hidden") return;
      arrive(event.persisted);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const shouldMount =
    (active === undefined ? visible : active) &&
    (pageVisible || keepMountedWhileHidden);
  const shouldAnimate = shouldMount;

  /**
   * WHAT WENT WRONG: `readyPresentationKey` was set and never cleared, and
   * `shouldMount` turning false unmounts only the CHILD — this component stays
   * put, keeping its state. So a hide/show cycle came back with the key of the
   * presentation that had just been torn down, `presentationReady` was true in
   * the same commit that remounted the renderer, and the reveal ran against a
   * canvas that was not in the DOM yet.
   */
  useEffect(() => {
    if (shouldMount) return;
    setReadyPresentationKey(null);
  }, [shouldMount]);

  // An id this build has no component for is not an error state: rezeis-admin
  // may legitimately be a release ahead. It renders as no effect at all, so the
  // operator's gradient stays in view until the cabinet catches up.
  const isValid = effect !== "NONE" && isKnownCardEffect(effect);
  const propsKey = useMemo(() => JSON.stringify(props ?? {}), [props]);
  const failureScope = `${effect}:${propsKey}`;
  const failureCount =
    failureState?.scope === failureScope ? failureState.count : 0;
  const markRuntimeFailed = useCallback(() => {
    setFailureState((current) => {
      const count = current?.scope === failureScope ? current.count : 0;
      const nextCount = Math.min(count + 1, 2);
      return count === nextCount
        ? current
        : { scope: failureScope, count: nextCount };
    });
  }, [failureScope]);

  /**
   * Rebuild the renderer after a context came back.
   *
   * A restored context is not the one the effect was drawing with: every GL
   * handle it holds was detached by the loss, and almost no component in the
   * catalog rebuilds itself. Bumping the generation changes the renderer's
   * `key`, so React unmounts the effect and mounts a fresh one on a fresh
   * context — the same answer `Plasma` reaches for itself, applied uniformly.
   *
   * Returns whether the rebuild was taken. `false` hands the loss back to the
   * observer as an ordinary failure, which is what keeps the budget above from
   * being a suggestion. The budget lives in a ref rather than in state because
   * the observer needs the answer synchronously, inside the DOM event.
   */
  const restoreBudgetRef = useRef<{ scope: string; used: number } | null>(null);
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const requestRuntimeRebuild = useCallback(() => {
    const budget = restoreBudgetRef.current;
    const used = budget?.scope === failureScope ? budget.used : 0;
    if (used >= MAX_CONTEXT_RESTORES) return false;
    restoreBudgetRef.current = { scope: failureScope, used: used + 1 };
    setRendererGeneration((generation) => generation + 1);
    return true;
  }, [failureScope]);

  useEffect(() => {
    if (!shouldAnimate || !isValid || !requiresWebGL(effect)) {
      return;
    }
    // Asked once per effect, not once per activation. The probe opens a real
    // `webgl2` context and WebKit frees it ASYNCHRONOUSLY, so a carousel that
    // re-probed on every swipe would spend a live context out of sixteen on a
    // question it had already answered — and the answer cannot change while
    // this layer goes on drawing the same effect. A context that genuinely
    // dies is caught by `observeCardEffectCanvases` and becomes a failure, not
    // a re-probe.
    //
    // Gated on the SNAPSHOT rather than on a "already probed" flag: the frame
    // below is cancellable, and a flag set before it fired would leave a card
    // that was swiped past within one frame permanently without capabilities,
    // hence permanently without a renderer.
    if (capabilitySnapshot?.effect === effect) return;
    const capabilities = detectCardEffectCapabilities();
    // `WEBGL_lose_context` releases the short-lived probe asynchronously in
    // WebKit. Wait one frame before mounting the real renderer so the probe
    // cannot momentarily consume the iOS context budget.
    const frame = window.requestAnimationFrame(() => {
      setCapabilitySnapshot({ effect, capabilities });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [capabilitySnapshot, effect, isValid, shouldAnimate]);

  const sourceProps = props ?? {};
  const staticProps = isValid
    ? {
        ...cardEffectDefaults(effect),
        ...sourceProps,
      }
    : sourceProps;
  const capabilities =
    capabilitySnapshot?.effect === effect
      ? capabilitySnapshot.capabilities
      : null;
  const runtime =
    !isValid || (requiresWebGL(effect) && capabilities === null)
      ? null
      : resolveCardEffectRuntime({
          effect,
          props: sourceProps,
          capabilities: capabilities ?? { webgl: false, webgl2: false },
          failureCount,
        });
  const rawRuntimeId = runtime?.effect;
  const runtimeId =
    rawRuntimeId !== undefined && isKnownCardEffect(rawRuntimeId)
      ? rawRuntimeId
      : undefined;
  const Effect = runtimeId === undefined ? null : CARD_EFFECT_COMPONENTS[runtimeId];
  // Two separate defences over the same operator-authored JSON, and they are
  // separate because they answer different questions.
  //
  // Sanitised because this record is spread onto the effect below, most of
  // which forward unrecognised props to a real element — a path from a settings
  // field to markup and to event handlers. See `sanitizeCardEffectProps`.
  //
  // Clamped because a number that left the panel's slider range is a resource
  // bound, not a name: `beamNumber: 300` is three hundred full-screen planes on
  // a phone. See `clampCardEffectProps`, and note the ORDER — the clamp takes
  // the operator's record and the defaults merge UNDER its result, so a value
  // it had to drop as non-finite lands on a real default instead of a hole.
  const mergedProps =
    runtimeId === undefined
      ? {}
      : sanitizeCardEffectProps({
          ...cardEffectDefaults(runtimeId),
          ...clampCardEffectProps(runtimeId, runtime?.props ?? {}),
        });
  const effectColors =
    runtimeId === undefined
      ? runtime?.cssColors ?? resolveCardEffectColors(effect, staticProps)
      : resolveCardEffectColors(runtimeId, mergedProps);
  const configuredOpacity = resolveCardEffectOverlayOpacity(opacity);
  // `gen-` is what makes a rebuild after a restored context a NEW presentation:
  // readiness has to be handshaken again, the canvas observer is rebuilt around
  // the new canvas, and the reveal fades rather than snapping in — a context
  // loss is not a swipe, and the artwork really was gone.
  const presentationKey =
    runtime === null
      ? null
      : `${failureScope}:${runtime.effect}:${runtime.mode}:failure-${failureCount}:gen-${rendererGeneration}`;
  const presentationReady =
    shouldMount &&
    presentationKey !== null &&
    (runtime?.mode === "css-fallback" ||
      readyPresentationKey === presentationKey);

  /**
   * Start a renderer that is not running, now that the user is looking again.
   *
   * WHAT IT UNDOES, and each of the three is a state the layer used to be stuck
   * in until a reload:
   *  - a failure — a creation error, a shader that would not compile, a loss
   *    whose grace window ran out. The count is cleared, which is the only thing
   *    that lifts `resolveCardEffectRuntime` back out of `css-fallback`.
   *  - a negative capability probe. `detectCardEffectCapabilities` is asked once
   *    per effect and cached for the life of the layer, and a probe taken while
   *    the GPU was refusing new contexts — which is exactly the moment an app is
   *    being switched back to — cached "this device has no WebGL" for a device
   *    that has it. Clearing the snapshot re-probes. The card shows the
   *    operator's gradient alone for the frame in between, which is the same
   *    thing it shows while probing at first mount.
   *  - a context that died silently. Nothing can detect that from here (see the
   *    header), so a return from the back/forward cache — where the context is
   *    dead far more often than not — rebuilds unconditionally rather than on
   *    evidence. That is `fromBfcache`, and it is the only case that restarts a
   *    presentation which still believes it is running.
   *
   * Returns whether an attempt was made, so a caller can tell "recovered" from
   * "out of budget"; the budget is per `failureScope` and refunded by a cycle
   * that ran (see `CARD_EFFECT_RECOVERY_CREDIT_MS`).
   */
  const restartBudgetRef = useRef<{ scope: string; used: number } | null>(null);
  const inCssFallback = runtime?.mode === "css-fallback";
  const restartAfterReturn = useCallback(
    (fromBfcache: boolean) => {
      if (!inCssFallback && !fromBfcache) return false;
      const budget = restartBudgetRef.current;
      const used = budget?.scope === failureScope ? budget.used : 0;
      if (used >= MAX_RETURN_RESTARTS) return false;
      restartBudgetRef.current = { scope: failureScope, used: used + 1 };
      // A restart is a fresh start for the rebuild budget too: what it was
      // spent on is the presentation being discarded here.
      restoreBudgetRef.current = null;
      if (inCssFallback) {
        if (failureCount > 0) setFailureState(null);
        else setCapabilitySnapshot(null);
      }
      setRendererGeneration((generation) => generation + 1);
      return true;
    },
    [failureCount, failureScope, inCssFallback],
  );

  /**
   * Reveal is a SEPARATE state from readiness, and deliberately so. Readiness
   * flips inside the same commit that mounts the canvas, so binding opacity to
   * it directly means the browser paints the final value with no previous one
   * to animate from — the transition never runs and the effect snaps in, which
   * is exactly what it used to do. Setting it from an effect puts the change
   * one paint later, which is what gives the transition something to move.
   *
   * That one-paint delay is precisely what `instant` gives up, and only for a
   * presentation this layer has already shown: snapping in is the CORRECT
   * behaviour for artwork that was on screen a moment ago, and the fade is
   * reserved for artwork the user has not seen. Note that `instant` still waits
   * for `presentationReady` — it shortens the reveal, never the readiness
   * handshake, so a renderer that has not committed still shows nothing.
   */
  const revealMemoryRef = useRef<{
    readonly key: string;
    readonly releasedAt: number;
  } | null>(null);
  const [reveal, setReveal] = useState<CardEffectRevealPhase>("hidden");
  const revealed = reveal !== "hidden";
  useEffect(() => {
    if (!presentationReady || presentationKey === null) {
      setReveal("hidden");
      return;
    }
    const memory = revealMemoryRef.current;
    if (
      memory !== null &&
      memory.key === presentationKey &&
      monotonicNow() - memory.releasedAt <= CARD_EFFECT_REVEAL_MEMORY_MS
    ) {
      setReveal("instant");
      return;
    }
    const frame = requestAnimationFrame(() => setReveal("fade"));
    return () => cancelAnimationFrame(frame);
  }, [presentationReady, presentationKey]);

  /**
   * The receipt that lets a presentation come back without fading, written by
   * the cleanup so it can only ever record something that was actually on
   * screen. A presentation that was ready for a moment but never revealed —
   * a slide swiped past inside a single frame — leaves nothing behind, so its
   * first real appearance still fades.
   *
   * Keyed by `presentationKey`, which carries the effect, its props, the
   * runtime mode and the failure count. Anything the operator changes produces
   * a different key and therefore a fresh fade.
   */
  useEffect(() => {
    if (reveal === "hidden" || presentationKey === null) return;
    const key = presentationKey;
    return () => {
      revealMemoryRef.current = { key, releasedAt: monotonicNow() };
    };
  }, [presentationKey, reveal]);

  /*
   * NOTHING SAMPLES THE CANVAS, and nothing here reports to the frame.
   *
   * A `painted` state used to live at this point: a timer sampled the canvas
   * five times after mount looking for evidence the effect had drawn, and its
   * ONLY consumer was the backdrop opacity this layer reported upward. Both are
   * gone by the product owner's decision — the effect draws over the operator's
   * gradient and nothing dims it, exactly as the admin preview has always shown
   * it. With the fade gone the question "did it paint?" has no consumer left,
   * and asking it cost five forced GPU→CPU readbacks on every mount.
   */

  /**
   * WHAT WENT WRONG: this ran only once `presentationReady` was true — which is
   * the handshake the renderer performs AFTER it has mounted and asked for its
   * context. `webglcontextcreationerror` is dispatched from inside
   * `getContext()`, so by the time these listeners existed the one event that
   * says "this device would not give me a context" had already been and gone,
   * and a card that never started was indistinguishable from one that was still
   * loading. Nothing ever reported it, so nothing ever retried it.
   *
   * It now attaches as soon as a renderer is going to be mounted, and in a
   * LAYOUT effect: passive effects run child-first, so a `useEffect` here would
   * still lose the race against a non-lazy effect (`aurora`, the product
   * default) that creates its context in its own passive effect. Layout effects
   * for the whole tree run before ANY passive effect, which is the only
   * ordering that puts a container listener in front of a child's `getContext`.
   *
   * `presentationReady` is still a dependency, so the observer is rebuilt when
   * the renderer commits — that second pass is what scans the committed canvas
   * synchronously and starts the readiness timeout. Before the commit the
   * timeout is `null`: what is being waited for at that point is a lazy chunk
   * over the phone's connection, and timing that as a GPU fault would drop a
   * slow network into the CSS fallback.
   */
  useLayoutEffect(() => {
    if (!isValid || !shouldMount || runtimeId === undefined || Effect === null) {
      return;
    }
    const root = ref.current;
    if (root === null) return;

    return observeCardEffectCanvases(
      root,
      markRuntimeFailed,
      presentationReady ? CARD_EFFECT_RENDERER_READY_TIMEOUT_MS : null,
      runtimeId === "waves" ? "2d" : undefined,
      requestRuntimeRebuild,
    );
  }, [
    Effect,
    isValid,
    markRuntimeFailed,
    presentationKey,
    presentationReady,
    requestRuntimeRebuild,
    runtimeId,
    shouldMount,
  ]);

  /**
   * Give the budgets back to a presentation that actually worked.
   *
   * WHAT WENT WRONG: both budgets were spent for the lifetime of a
   * `failureScope` and returned by nothing, so they measured "failures ever"
   * rather than "failures in a row". Two transient context losses hours apart
   * left the third one — the first the user would have minded — with no rebuild
   * left to spend, and the card in the CSS fallback until a reload. That is
   * "после третьего возврата перестало совсем", and it is a ratchet rather than
   * a policy.
   *
   * The refund waits for the presentation to have been up for
   * `CARD_EFFECT_RECOVERY_CREDIT_MS`, which is what keeps it from becoming the
   * unbounded rebuild loop the budgets exist to prevent: a device that loses its
   * context immediately after every rebuild never reaches the credit and still
   * falls back. Only `native` counts — the CSS fallback is what is being
   * recovered FROM, so crediting it would refund the budget for failing.
   */
  useEffect(() => {
    if (!presentationReady || runtime?.mode !== "native") return;
    const scope = failureScope;
    const timer = window.setTimeout(() => {
      if (restoreBudgetRef.current?.scope === scope) {
        restoreBudgetRef.current = null;
      }
      if (restartBudgetRef.current?.scope === scope) {
        restartBudgetRef.current = null;
      }
    }, CARD_EFFECT_RECOVERY_CREDIT_MS);
    return () => window.clearTimeout(timer);
  }, [failureScope, presentationReady, runtime?.mode]);

  /**
   * Try again when the user comes back.
   *
   * The ticket is consumed rather than read, so one return produces exactly one
   * attempt however often this effect is re-run by dependency churn. What the
   * attempt does is in `restartAfterReturn`; whether it is allowed is
   * `MAX_RETURN_RESTARTS`.
   */
  const handledTicketRef = useRef(0);
  useEffect(() => {
    if (returnTicket === handledTicketRef.current) return;
    handledTicketRef.current = returnTicket;
    const fromBfcache = bfcacheReturnRef.current;
    bfcacheReturnRef.current = false;
    restartAfterReturn(fromBfcache);
  }, [restartAfterReturn, returnTicket]);

  if (!isValid) return null;

  return (
    <div
      ref={ref}
      aria-hidden
      className={className}
      data-card-effect-source={effect}
      data-card-effect-runtime={runtime?.mode ?? "probing"}
      data-card-effect-ready={presentationReady ? "true" : "false"}
      data-card-effect-reveal={reveal}
      style={{
        // The effect is composited with normal source-over alpha. A previous
        // unconditional `screen` blend mathematically recoloured every
        // operator gradient and made black/transparent shader regions expose
        // the old concept artwork. Opacity is the only blending decision here
        // and is configured explicitly by the operator.
        // Fades in once the renderer has actually painted. Before this the
        // layer jumped from absent to fully opaque in a single frame — the
        // whole card changed appearance between two paints, 50 ms apart.
        //
        // `transition: none` on the instant path is load-bearing, not tidiness.
        // The layer really did paint at 0 while it was torn down, so that is
        // the browser's before-change style and a transition WOULD run from it;
        // only an after-change style with no transition-property keeps the
        // return snap-free.
        opacity: revealed ? 1 : 0,
        transition:
          reveal === "instant"
            ? "none"
            : `opacity ${CARD_EFFECT_REVEAL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        overflow: "hidden",
      }}
    >
      {runtime?.mode === "css-fallback" && (
        <div
          data-card-effect-palette-surface
          className="absolute inset-0"
        >
          <CssEffectFallback
            colors={effectColors}
            opacity={configuredOpacity}
          />
        </div>
      )}
      {shouldAnimate &&
        Effect !== null &&
        runtimeId !== undefined && (
          <EffectErrorBoundary
            resetKey={`${presentationKey ?? failureScope}:${runtimeId}`}
            onError={markRuntimeFailed}
          >
            <Suspense fallback={null}>
              <div
                data-card-effect-renderer
                className="absolute inset-0"
                style={{
                  opacity: configuredOpacity,
                }}
              >
                {/* The generation is part of the key, not decoration: a
                    restored context needs a NEW component instance on a NEW
                    canvas, and re-rendering the same one would keep the GL
                    handles the loss detached. */}
                <Effect
                  key={`${runtimeId}:${rendererGeneration}`}
                  {...mergedProps}
                />
              </div>
              {presentationKey !== null && (
                <EffectReadySignal
                  presentationKey={presentationKey}
                  onReady={setReadyPresentationKey}
                />
              )}
            </Suspense>
          </EffectErrorBoundary>
        )}
    </div>
  );
}
