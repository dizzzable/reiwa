import {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { CardEffectLayer } from "@/components/reactbits/card-effect-layer";
import { CardWatermark } from "@/components/ui/card-watermark";
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
  readonly effectActive?: boolean;
  /**
   * Omitted for normal cards so the production DOM receives no animation
   * styles. Creation motion may reveal the real layers progressively.
   */
  readonly layerOpacity?: SubscriptionCardLayerOpacity;
}

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
    layerOpacity,
    className,
    style,
    ...props
  },
  ref,
) {
  const { contrast } = visual;
  const frameStyle = {
    "--card-foreground": contrast.foreground,
    "--card-foreground-rgb": contrast.foregroundRgb,
    "--card-veil-rgb": contrast.veilRgb,
    "--card-support-background": contrast.supportBackground,
    "--card-danger":
      contrast.foregroundTone === "dark" ? "#b91c1c" : "#f87171",
    "--card-warning":
      contrast.foregroundTone === "dark" ? "#92400e" : "#fbbf24",
    boxShadow:
      contrast.foregroundTone === "dark"
        ? "0 25px 50px -12px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(10 10 10 / 0.12)"
        : "0 25px 50px -12px rgb(0 0 0 / 0.40), 0 0 0 1px rgb(255 255 255 / 0.12)",
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
        "@container/card relative flex h-[190px] w-full flex-col justify-between overflow-hidden rounded-card p-4 text-[color:var(--card-foreground)] select-none",
        "@sm:h-[210px] @sm:p-5",
        className,
      )}
      style={frameStyle}
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
      <div
        data-subscription-card-layer="gradient"
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: visual.cardGradient,
          ...opacityStyle(layerOpacity?.gradient, 560),
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
            opacity: 0.4,
            ...opacityStyle(layerOpacity?.gradient, 560),
          }}
        />
      )}
      {visual.cardEffect !== "NONE" && (
        <CardEffectLayer
          effect={visual.cardEffect}
          props={visual.cardEffectProps}
          opacity={visual.cardEffectOpacity}
          active={effectActive}
          className="absolute inset-0 z-0"
        />
      )}
      <div
        data-subscription-card-layer="vignette"
        className="absolute inset-0 z-0"
        style={{
          background: contrast.overlayBackground,
          ...opacityStyle(layerOpacity?.vignette, 480),
        }}
      />

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
