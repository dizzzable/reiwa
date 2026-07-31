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

function vividArtworkOverlay(
  contrast: ResolvedSubscriptionCardVisual["contrast"],
): string {
  const veil = Math.min(0.75, Math.max(0, contrast.veilOpacity));
  const edge = Math.min(0.84, veil + 0.12);
  const artworkWindow = Math.max(0.035, veil * 0.28);
  const channels = contrast.veilRgb;

  // The WCAG-calculated veil stays intact behind the top, profile and bottom
  // copy. A narrow copy-free window exposes the shader without weakening the
  // contrast calculation in a text-bearing band.
  return `linear-gradient(180deg, rgb(${channels} / ${edge}) 0%, rgb(${channels} / ${veil}) 24%, rgb(${channels} / ${artworkWindow}) 30%, rgb(${channels} / ${artworkWindow}) 35%, rgb(${channels} / ${veil}) 41%, rgb(${channels} / ${veil}) 82%, rgb(${channels} / ${edge}) 100%)`;
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
  const creationPresentation = layerOpacity !== undefined;
  const frameStyle = {
    "--card-foreground": contrast.foreground,
    "--card-foreground-rgb": contrast.foregroundRgb,
    "--card-veil-rgb": contrast.veilRgb,
    "--card-veil-opacity": contrast.veilOpacity,
    "--card-support-background": contrast.supportBackground,
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
      {visual.cardPattern && creationPresentation && (
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
      {visual.cardPattern && !creationPresentation && (
        <div
          data-subscription-card-layer="pattern"
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage: visual.cardPattern,
            backgroundSize: visual.cardPattern.includes("gradient(")
              ? "24px 24px"
              : undefined,
            opacity: 0.4,
          }}
        />
      )}
      <div
        data-subscription-card-layer="vignette"
        data-subscription-card-readability={
          creationPresentation ? "creation-overlay" : "wcag-copy-zones"
        }
        data-subscription-card-veil-opacity={contrast.veilOpacity}
        className="absolute inset-0 z-0"
        style={{
          background: creationPresentation
            ? contrast.overlayBackground
            : vividArtworkOverlay(contrast),
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
