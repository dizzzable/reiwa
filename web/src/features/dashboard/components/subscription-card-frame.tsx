import {
  forwardRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import {
  CARD_EFFECT_REVEAL_MS,
  CardEffectLayer,
} from "@/components/reactbits/card-effect-layer";
import { CardWatermark } from "@/components/ui/card-watermark";
import { useCardEffectWarmSlot } from "@/lib/card-effect-budget";
import { cn } from "@/lib/utils";

import type { ResolvedSubscriptionCardVisual } from "./subscription-card-visual";

export interface SubscriptionCardLayerOpacity {
  readonly foundation?: number;
  readonly gradient?: number;
  readonly vignette?: number;
  readonly watermark?: number;
}

export interface SubscriptionCardFrameProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly visual: ResolvedSubscriptionCardVisual;
  readonly children?: ReactNode;
  readonly overlay?: ReactNode;
  /** Active dashboard ownership; only this frame may opt into live card art. */
  readonly effectActive?: boolean;
  /**
   * This card is one swipe away from being active.
   *
   * A hint, not an instruction: it asks the shared context budget for a slot
   * and keeps the renderer alive only if one is free, so warming can never
   * raise the number of live GPU contexts above what the budget already allows.
   * The point is that a swipe finds the renderer running and revealed instead
   * of paying for a rebuild and a crossfade in front of the user.
   *
   * Ignored unless `effectActive` is a boolean — an `undefined` `effectActive`
   * means the layer is driving itself from its own IntersectionObserver, and
   * there is no "next" card to warm.
   */
  readonly effectWarm?: boolean;
  /**
   * Omitted for normal cards so the production DOM receives no animation
   * styles. Creation motion may reveal the real layers progressively.
   */
  readonly layerOpacity?: SubscriptionCardLayerOpacity;
}

/** What the pattern layer sits at when nothing is covering it. */
const BACKDROP_PATTERN_RESTING_OPACITY = 0.4;

function opacityStyle(
  opacity: number | undefined,
  durationMs: number,
): CSSProperties | undefined {
  if (opacity === undefined) return undefined;
  return {
    opacity,
    transition: `opacity ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
  };
}

function glassColor(tint: string, opacity: number): string {
  const compact = tint.trim().replace(/^#/, "");
  const hex = compact.length === 3
    ? compact.split("").map((channel) => `${channel}${channel}`).join("")
    : compact;
  const channels = /^[\da-f]{6}$/i.test(hex)
    ? [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ]
    : [255, 255, 255];
  const alpha = Math.min(Math.max(opacity, 0), 1);
  return `rgb(${channels.join(" ")} / ${alpha})`;
}

/**
 * The single production card frame. It owns the exact established dimensions,
 * stacking order, watermark and (at most) one CardEffectLayer.
 */
export const SubscriptionCardFrame = forwardRef<
  HTMLDivElement,
  SubscriptionCardFrameProps
>(function SubscriptionCardFrame(
  {
    visual,
    children,
    overlay,
    effectActive,
    effectWarm,
    layerOpacity,
    className,
    style,
    ...props
  },
  ref,
) {
  const { contrast } = visual;
  const creationPresentation = layerOpacity !== undefined;

  // Only a card the carousel is rationing can be warmed, and only while it is
  // not the selected one — the selected slide already mounts unconditionally
  // and must never be made to wait on a budget it could be refused by.
  const rationedByOwner = effectActive !== undefined;
  const warmGranted = useCardEffectWarmSlot(
    visual.cardEffect,
    rationedByOwner && effectWarm === true && effectActive !== true,
  );
  const layerActive = rationedByOwner
    ? effectActive === true || warmGranted
    : undefined;

  /**
   * How much of the operator's backdrop survives under the effect, set by the
   * layer. Held here rather than derived, because the backdrop must fade on the
   * SAME schedule as the effect fades in — a single shared duration, two halves
   * of one crossfade.
   *
   * A fraction and not a flag: how far the backdrop may step back depends on
   * whether the renderer can be proved to have drawn, and only the layer knows
   * that. See `resolveCardEffectBackdropPolicy`. Applied as a MULTIPLIER so
   * each layer keeps its own resting value — the pattern rests at 0.4, and
   * fading it from 1 would brighten it on the way out.
   */
  const [backdropOpacity, setBackdropOpacity] = useState(1);
  const backdropStyle = {
    opacity: backdropOpacity,
    transition: `opacity ${CARD_EFFECT_REVEAL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
  };
  const backdropPatternStyle = {
    opacity: BACKDROP_PATTERN_RESTING_OPACITY * backdropOpacity,
    transition: `opacity ${CARD_EFFECT_REVEAL_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
  };
  const frameStyle = {
    "--card-foreground": contrast.foreground,
    "--card-foreground-rgb": contrast.foregroundRgb,
    "--card-veil-rgb": contrast.veilRgb,
    "--card-veil-opacity": contrast.veilOpacity,
    "--card-danger":
      contrast.foregroundTone === "dark" ? "#b91c1c" : "#f87171",
    "--card-warning":
      contrast.foregroundTone === "dark" ? "#92400e" : "#fbbf24",
    boxShadow:
      contrast.foregroundTone === "dark"
        ? "0 18px 38px -26px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(10 10 10 / 0.12)"
        : "0 18px 38px -26px rgb(0 0 0 / 0.46), 0 0 0 1px rgb(255 255 255 / 0.12)",
    ...style,
  } as CSSProperties;
  const watermark = (
    <CardWatermark
      preset={visual.cardLogo}
      customUrl={visual.cardLogoUrl}
      className="absolute -right-6 -bottom-8 h-40 w-40 text-[color:var(--card-foreground)] opacity-10 @sm:h-44 @sm:w-44"
    />
  );

  return (
    <div
      ref={ref}
      className={cn(
        // Background layers below use z-0 (NOT negative z-index): iOS Safari
        // fails to paint negative-z children inside this `@container`
        // (layout-containment stacking context) + overflow-hidden + rounded box,
        // so the card renders with no background on iPhone. z-0 + DOM order keeps
        // the same visual layering on every platform without the WebKit bug.
        "@container/card relative isolate flex h-[190px] w-full flex-col justify-between overflow-hidden rounded-card p-4 text-[color:var(--card-foreground)] select-none [contain:paint]",
        "@sm:h-[210px] @sm:p-5",
        className,
      )}
      style={frameStyle}
      data-subscription-card-artwork={visual.cardEffect !== "NONE" ? "animated" : "static"}
      {...props}
    >
      <div
        data-subscription-card-layer="foundation"
        className="absolute inset-0 z-0"
        style={{
          backgroundColor: contrast.foundation,
          ...opacityStyle(layerOpacity?.foundation, 420),
        }}
      />
      {/* The backdrop shown until the effect paints, and the thing that used to
          keep showing afterwards. A concept's diagonal artwork read through a
          transparent shader looks like a rendering fault, not like design, so
          once a REAL renderer is up the gradient steps back rather than
          competing with it — all the way out where the effect can be proved to
          have painted, to a residual where it cannot. The creation reveal owns
          opacity while it runs and is left alone. */}
      <div
        data-subscription-card-layer="gradient"
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: visual.cardGradient,
          ...(creationPresentation
            ? opacityStyle(layerOpacity?.gradient, 560)
            : backdropStyle),
        }}
      />
      {visual.cardPattern && (
        <div
          data-subscription-card-layer="pattern"
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage: visual.cardPattern,
            backgroundSize: visual.cardPattern.includes("gradient(")
              ? "24px 24px"
              : undefined,
            opacity: BACKDROP_PATTERN_RESTING_OPACITY,
            ...(creationPresentation
              ? opacityStyle(layerOpacity.gradient, 560)
              : backdropPatternStyle),
          }}
        />
      )}
      {visual.cardEffect !== "NONE" && (
        <CardEffectLayer
          effect={visual.cardEffect}
          props={visual.cardEffectProps}
          opacity={visual.cardEffectOpacity}
          active={layerActive}
          onBackdropOpacityChange={setBackdropOpacity}
          className="absolute inset-0 z-0"
        />
      )}
      {/* Text mode selects text only. Never paint an automatic WCAG film above
          operator artwork: it changes the perceived gradient when the
          operator switches light/dark/custom text. The creation reveal is a
          short-lived motion layer and remains the sole intentional film. */}
      {creationPresentation && (
        <div
          data-subscription-card-layer="vignette"
          data-subscription-card-readability="creation-overlay"
          data-subscription-card-veil-opacity={contrast.veilOpacity}
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background: contrast.overlayBackground,
            ...opacityStyle(layerOpacity?.vignette, 480),
          }}
        />
      )}
      {visual.subscriptionCardGlass.enabled && (
        <div
          data-subscription-card-layer="glass"
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundColor: glassColor(
              visual.subscriptionCardGlass.tint,
              visual.subscriptionCardGlass.opacity,
            ),
            border: `1px solid ${glassColor(
              visual.subscriptionCardGlass.tint,
              visual.subscriptionCardGlass.borderOpacity,
            )}`,
            backdropFilter:
              visual.subscriptionCardGlass.blurPx > 0
                ? `blur(${visual.subscriptionCardGlass.blurPx}px)`
                : undefined,
            WebkitBackdropFilter:
              visual.subscriptionCardGlass.blurPx > 0
                ? `blur(${visual.subscriptionCardGlass.blurPx}px)`
                : undefined,
          }}
        />
      )}

      {layerOpacity?.watermark === undefined ? (
        watermark
      ) : (
        <div
          data-subscription-card-layer="watermark"
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={opacityStyle(layerOpacity.watermark, 460)}
        >
          {watermark}
        </div>
      )}

      {children}
      {overlay}
    </div>
  );
});
