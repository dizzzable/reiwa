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
  /** Active dashboard ownership; only this frame may opt into live card art. */
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

function staticArtworkVeil(
  contrast: ResolvedSubscriptionCardVisual["contrast"],
): string {
  const channels = contrast.veilRgb;

  // Static artwork has no motion to protect, so the calculated minimum veil
  // may cover the complete dynamic flex layout. One uniform, theme-derived
  // layer avoids fragile copy coordinates and per-field capsules.
  const veil = Math.min(0.75, Math.max(0, contrast.veilOpacity));
  return `linear-gradient(180deg, rgb(${channels} / ${veil}) 0%, rgb(${channels} / ${veil}) 100%)`;
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
    layerOpacity,
    className,
    style,
    ...props
  },
  ref,
) {
  const { contrast } = visual;
  const creationPresentation = layerOpacity !== undefined;
  const animatedArtwork = visual.cardEffect !== "NONE";
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
      data-subscription-card-artwork={animatedArtwork ? "animated" : "static"}
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
            ...(creationPresentation
              ? opacityStyle(layerOpacity.gradient, 560)
              : undefined),
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
      {/* Live artwork is the card. Painting a veil over it flattens the shader
          into one dull colour, so animated cards stay uncovered and rely on
          the tone `resolveCardContrast` already picked from the shader output
          palette. Only static artwork and the creation reveal get a film. */}
      {(creationPresentation || !animatedArtwork) && (
        <div
          data-subscription-card-layer="vignette"
          data-subscription-card-readability={
            creationPresentation ? "creation-overlay" : "wcag-full-card-veil"
          }
          data-subscription-card-veil-opacity={contrast.veilOpacity}
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background: creationPresentation
              ? contrast.overlayBackground
              : staticArtworkVeil(contrast),
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
