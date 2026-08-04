/**
 * landing-kit-context
 * ───────────────────
 * The seam that makes the landing renderer host-agnostic.
 *
 * This folder (schema, sections, renderer, background, CSS — everything except
 * `landing-page.tsx`) is the LANDING KIT: the single source of truth for how a
 * landing looks. It renders in two hosts:
 *
 *   - reiwa `/welcome`  — the real page visitors see;
 *   - rezeis-admin      — the builder preview, which vendors a byte-identical
 *     copy of this folder (see the sync manifest there) so the operator looks
 *     at THE SAME renderer, not a re-implementation.
 *
 * Anything host-specific therefore cannot be imported here — it is injected:
 *
 *   - `LinkComponent` — how an internal CTA (`/register`, `/sign-in`) renders.
 *     reiwa passes a react-router adapter; the admin preview passes a non-
 *     navigating anchor. Default: plain `<a>`, so the kit renders standalone.
 *   - `loadPlans` — the catalog behind `pricing.source === 'catalog'`.
 *     reiwa passes its public plans endpoint; the admin passes its own catalog
 *     API mapped to `LandingCatalogPlan`. Default `null` fails closed: the
 *     pricing section hides, exactly as it does on a catalog error.
 *
 * Keep this surface minimal — every entry here is a divergence point between
 * preview and production, which is precisely what the kit exists to eliminate.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

/** Minimal shape the pricing section renders — hosts map their payloads to it. */
export interface LandingCatalogPlan {
  readonly id: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly priceCents?: number;
  readonly priceMonthlyCents?: number;
  readonly currency?: string;
}

export interface LandingKitLinkProps {
  readonly to: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export interface LandingKitValue {
  /** Renders an internal SPA link. External URLs never go through this. */
  readonly LinkComponent: ComponentType<LandingKitLinkProps>;
  /** Loads catalog plans for pricing; `null` hides catalog pricing (fail-closed). */
  readonly loadPlans: (() => Promise<readonly LandingCatalogPlan[]>) | null;
}

function PlainAnchor({ to, className, children }: LandingKitLinkProps) {
  return (
    <a href={to} className={className}>
      {children}
    </a>
  );
}

const DEFAULT_KIT: LandingKitValue = {
  LinkComponent: PlainAnchor,
  loadPlans: null,
};

const LandingKitContext = createContext<LandingKitValue>(DEFAULT_KIT);

export function LandingKitProvider({
  value,
  children,
}: {
  readonly value: Partial<LandingKitValue>;
  readonly children: ReactNode;
}) {
  return (
    <LandingKitContext.Provider value={{ ...DEFAULT_KIT, ...value }}>
      {children}
    </LandingKitContext.Provider>
  );
}

export function useLandingKit(): LandingKitValue {
  return useContext(LandingKitContext);
}
