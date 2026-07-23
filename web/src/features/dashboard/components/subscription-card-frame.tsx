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
    ...props
  },
  ref,
) {
  const watermark = (
    <CardWatermark
      preset={visual.cardLogo}
      customUrl={visual.cardLogoUrl}
      className="absolute -right-6 -bottom-8 h-40 w-40 @sm:h-44 @sm:w-44"
    />
  );

  return (
    <div
      ref={ref}
      className={cn(
        "@container/card relative flex h-[190px] w-full flex-col justify-between overflow-hidden rounded-card p-4 text-white select-none",
        "@sm:h-[210px] @sm:p-5",
        "shadow-2xl shadow-black/40 ring-1 ring-white/10",
        className,
      )}
      {...props}
    >
      <div
        data-subscription-card-layer="foundation"
        className="absolute inset-0 -z-30 bg-zinc-950"
        style={opacityStyle(layerOpacity?.foundation, 420)}
      />
      <div
        data-subscription-card-layer="gradient"
        className="absolute inset-0 -z-25"
        style={{
          backgroundImage: visual.cardGradient,
          ...opacityStyle(layerOpacity?.gradient, 560),
        }}
      />
      {visual.cardEffect !== "NONE" && (
        <CardEffectLayer
          effect={visual.cardEffect}
          props={visual.cardEffectProps}
          opacity={visual.cardEffectOpacity}
          active={effectActive}
          className="absolute inset-0 -z-20"
        />
      )}
      <div
        data-subscription-card-layer="vignette"
        className="absolute inset-0 -z-10 bg-linear-to-b from-black/55 via-black/15 to-black/65"
        style={opacityStyle(layerOpacity?.vignette, 480)}
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
