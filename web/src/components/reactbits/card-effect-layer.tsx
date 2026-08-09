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
 * timer runs and a live context proves nothing. The layer no longer tries; it
 * keeps a residual of the operator's backdrop instead, so the card degrades to
 * a dimmed gradient rather than to nothing. Consequences, all real:
 *  - A shader that compiles and draws perfectly still loses that residual of
 *    the backdrop it did not need to lose.
 *  - A context already lost before `observeCardEffectCanvases` attached its
 *    listeners is never noticed, and that card sits at the residual too.
 *  - A `canvas2d` effect whose first painted frame lands after the samples
 *    stop is read as blank and keeps the whole backdrop.
 */

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
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
  observeCardEffectCanvases,
  resolveCardEffectBackdropPolicy,
  resolveCardEffectOverlayOpacity,
  sampleCardEffectPainted,
  sanitizeCardEffectProps,
} from "./card-effect-layer-utils";

/** How often, and how many times, to look for evidence that the effect painted. */
const PAINT_SAMPLE_INTERVAL_MS = 120;
const PAINT_SAMPLE_ATTEMPTS = 5;

/**
 * How long the effect takes to fade in, and the backdrop to fade out.
 *
 * Shared with the frame so the two halves of the crossfade cannot drift apart:
 * a shorter fade-out than fade-in shows the flat foundation through the middle
 * of the transition, a longer one shows both at once.
 */
export const CARD_EFFECT_REVEAL_MS = 420;

interface CardEffectLayerProps {
  readonly effect: string;
  readonly props?: Record<string, unknown>;
  readonly opacity?: number;
  readonly className?: string;
  /**
   * Carousel ownership hint. The parent passes `true` only to the selected
   * slide, guaranteeing that one subscription at most owns a live WebGL/canvas
   * renderer. Left `undefined` for standalone usage, where the
   * IntersectionObserver below drives mounting.
   */
  readonly active?: boolean;
  /**
   * How much of the operator's backdrop the frame should keep, as a multiplier
   * on each backdrop layer's own resting opacity. `1` is untouched.
   *
   * Not a boolean, and that is the point. The frame steps the gradient back
   * once a real renderer is up, because a concept's diagonal artwork showing
   * through a transparent shader looks like a rendering fault rather than like
   * design — but how far it may step back depends on whether anything can prove
   * the effect drew, and for a shader nothing can. See
   * `resolveCardEffectBackdropPolicy`, which owns that decision and states why.
   *
   * `css-fallback` never reports anything but `1`: that mode is a translucent
   * radial built precisely so the gradient stays visible, and dimming it would
   * leave a low-capability device with almost nothing on the card.
   */
  readonly onBackdropOpacityChange?: (opacity: number) => void;
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
  onBackdropOpacityChange,
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
  // drives mounting EXCLUSIVELY (ignore the IntersectionObserver) so that at
  // most ONE card holds a live WebGL context at a time.
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
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
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
   * the same commit that remounted the renderer, and the crossfade and paint
   * sampling both ran against a canvas that was not in the DOM yet.
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

  useEffect(() => {
    if (!shouldAnimate || !isValid || !requiresWebGL(effect)) {
      return;
    }
    const capabilities = detectCardEffectCapabilities();
    // `WEBGL_lose_context` releases the short-lived probe asynchronously in
    // WebKit. Wait one frame before mounting the real renderer so the probe
    // cannot momentarily consume the iOS context budget.
    const frame = window.requestAnimationFrame(() => {
      setCapabilitySnapshot({ effect, capabilities });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [effect, isValid, shouldAnimate]);

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
  const presentationKey =
    runtime === null
      ? null
      : `${failureScope}:${runtime.effect}:${runtime.mode}:failure-${failureCount}`;
  const presentationReady =
    shouldMount &&
    presentationKey !== null &&
    (runtime?.mode === "css-fallback" ||
      readyPresentationKey === presentationKey);

  /**
   * Reveal is a SEPARATE state from readiness, and deliberately so. Readiness
   * flips inside the same commit that mounts the canvas, so binding opacity to
   * it directly means the browser paints the final value with no previous one
   * to animate from — the transition never runs and the effect snaps in, which
   * is exactly what it used to do. Setting it from an effect puts the change
   * one paint later, which is what gives the transition something to move.
   */
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!presentationReady) {
      setRevealed(false);
      return;
    }
    const frame = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(frame);
  }, [presentationReady, presentationKey]);

  /**
   * Evidence that the effect drew. Not merely that it mounted.
   *
   * Readiness cannot carry this weight: it flips when the lazy component
   * mounts, which says nothing about what reached the screen. Only a `canvas2d`
   * effect can be asked, and `resolveCardEffectBackdropPolicy` is what says so —
   * for a shader nothing is sampled, no timer is scheduled, and its canvas is
   * not touched. Read the policy for why, and for what the backdrop does
   * instead; do not reintroduce a probe here on the assumption that some
   * cheaper question would work.
   *
   * A handful of samples over roughly half a second, because the first frame
   * after mount is often still empty: several renderers clear on frame one and
   * draw on frame two. Sampling stops at the first positive, so the common case
   * costs one downscale of sixty-four pixels.
   *
   * `runtimeId` rather than `effect`, because it is the effect actually being
   * drawn after the runtime policy has had its say.
   */
  const backdropPolicy =
    runtimeId === undefined ? null : resolveCardEffectBackdropPolicy(runtimeId);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    setPainted(false);
    if (!presentationReady || runtime?.mode !== "native") return;
    if (runtimeId === undefined) return;
    if (resolveCardEffectBackdropPolicy(runtimeId).evidence !== "pixels") return;
    const root = ref.current;
    if (root === null) return;

    let attempt = 0;
    let timer = 0;
    const check = () => {
      const result = sampleCardEffectPainted(root, runtimeId);
      // `null` is "no canvas to inspect" — a DOM- or SVG-drawn effect, which
      // cannot fail this way, so it is taken at its word.
      if (result !== false) {
        setPainted(true);
        return;
      }
      attempt += 1;
      if (attempt >= PAINT_SAMPLE_ATTEMPTS) return;
      timer = window.setTimeout(check, PAINT_SAMPLE_INTERVAL_MS);
    };
    timer = window.setTimeout(check, PAINT_SAMPLE_INTERVAL_MS);

    return () => window.clearTimeout(timer);
  }, [presentationKey, presentationReady, runtime?.mode, runtimeId]);

  /**
   * What the frame should do with the operator's backdrop.
   *
   * A real renderer that is up covers it; `css-fallback` never does. How far it
   * covers is the policy's call, and for a shader that is deliberately not all
   * the way — see `onBackdropOpacityChange`. Where evidence exists it is also
   * required: a `canvas2d` effect that sampled blank leaves the backdrop alone.
   */
  const coversBackdrop =
    revealed &&
    runtime?.mode === "native" &&
    backdropPolicy !== null &&
    (backdropPolicy.evidence !== "pixels" || painted);
  const backdropOpacity =
    coversBackdrop && backdropPolicy !== null ? backdropPolicy.coveredOpacity : 1;
  useEffect(() => {
    onBackdropOpacityChange?.(backdropOpacity);
  }, [backdropOpacity, onBackdropOpacityChange]);
  useEffect(
    () => () => onBackdropOpacityChange?.(1),
    [onBackdropOpacityChange],
  );

  useEffect(() => {
    if (
      !isValid ||
      !shouldMount ||
      !presentationReady ||
      runtimeId === undefined
    ) {
      return;
    }
    const root = ref.current;
    if (root === null) return;

    return observeCardEffectCanvases(
      root,
      markRuntimeFailed,
      1_200,
      runtimeId === "waves" ? "2d" : undefined,
    );
  }, [
    isValid,
    markRuntimeFailed,
    presentationReady,
    runtimeId,
    shouldMount,
  ]);

  if (!isValid) return null;

  return (
    <div
      ref={ref}
      aria-hidden
      className={className}
      data-card-effect-source={effect}
      data-card-effect-runtime={runtime?.mode ?? "probing"}
      data-card-effect-ready={presentationReady ? "true" : "false"}
      style={{
        // The effect is composited with normal source-over alpha. A previous
        // unconditional `screen` blend mathematically recoloured every
        // operator gradient and made black/transparent shader regions expose
        // the old concept artwork. Opacity is the only blending decision here
        // and is configured explicitly by the operator.
        // Fades in once the renderer has actually painted. Before this the
        // layer jumped from absent to fully opaque in a single frame — the
        // whole card changed appearance between two paints, 50 ms apart.
        opacity: revealed ? 1 : 0,
        transition: `opacity ${CARD_EFFECT_REVEAL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
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
                <Effect key={runtimeId} {...mergedProps} />
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
