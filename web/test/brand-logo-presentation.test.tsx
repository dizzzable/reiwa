// @vitest-environment jsdom

/**
 * The operator's logo settings have to reach pixels.
 *
 * The reported complaint was that an uploaded 1024×1024 mark "looks small", and
 * the two causes stacked: the tile drew it at a fixed 44 px inside an 80 px
 * plate, and `object-fit: contain` fits the FILE, padding included, so an
 * export with its own safe-area margin shrinks further still. Neither had a
 * control anywhere in the product.
 *
 * These cases assert the seam that fix depends on — payload → geometry → the
 * `style` of a real rendered element — rather than either half of it. Both
 * halves were correct before this change and would stay green while the tile
 * ignored the payload entirely, which is the failure this project keeps
 * shipping.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BRANDING,
  DEFAULT_BRAND_LOGO,
  resolveBrandLogo,
  resolveCardLogoStyle,
  type Branding,
  type BrandLogo,
} from "../src/types/branding";

const state = vi.hoisted(() => ({ branding: null as unknown as Branding }));

vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: state.branding }),
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      className,
    }: {
      readonly children?: React.ReactNode;
      readonly className?: string;
    }) => <div className={className}>{children}</div>,
  },
}));

import { EntryBrandTile } from "../src/components/ui/entry-brand-tile";
import {
  BRAND_LOGO_TILE_BASE_PX,
  resolveBrandLogoGeometry,
} from "../src/components/ui/brand-logo-geometry";
import { CardWatermark } from "../src/components/ui/card-watermark";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  state.branding = { ...DEFAULT_BRANDING };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderTile(size: "md" | "lg" = "md"): HTMLElement {
  act(() => root.render(<EntryBrandTile size={size} />));
  const tile = host.querySelector<HTMLElement>("[data-entry-brand-tile]");
  expect(tile).not.toBeNull();
  return tile as HTMLElement;
}

describe("brand-mark geometry", () => {
  /**
   * The mirror pin. `rezeis-admin/web/src/features/branding/brand-logo-geometry.ts`
   * carries the same arithmetic and the same table, and NO test in either
   * repository can see the other side — so if you change these numbers, change
   * them there in the same change-set. The panel's preview promises exactly
   * these pixels to the operator.
   */
  it("computes the pixel table both repositories are pinned to", () => {
    const table: ReadonlyArray<{
      readonly variant: "md" | "lg";
      readonly logo: Pick<BrandLogo, "size" | "fill" | "radius" | "frame">;
      readonly itemRadiusPx: number;
      readonly expected: readonly [number, number, number, number];
    }> = [
      // Defaults on each surface, at the stock theme radius of 14 px: tile,
      // mark, tile radius, mark radius. `rounded-3xl` was 14 × 2.2 = 30.8 and
      // `rounded-xl` was 14 × 1.4 = 19.6, which is what the tile drew before
      // the setting existed.
      { variant: "md", logo: { size: 1, fill: 0.58, radius: null, frame: "glass" }, itemRadiusPx: 14, expected: [80, 46.4, 30.8, 19.6] },
      { variant: "lg", logo: { size: 1, fill: 0.58, radius: null, frame: "glass" }, itemRadiusPx: 14, expected: [96, 55.68, 28, 19.6] },
      // A theme with square corners keeps them; a fixed default percentage
      // would have rounded this deployment's tile off on upgrade.
      { variant: "md", logo: { size: 1, fill: 0.58, radius: null, frame: "glass" }, itemRadiusPx: 0, expected: [80, 46.4, 0, 0] },
      // …and a theme at the maximum keeps its near-circle.
      { variant: "md", logo: { size: 1, fill: 0.58, radius: null, frame: "glass" }, itemRadiusPx: 32, expected: [80, 46.4, 70.4, 44.8] },
      // An explicit radius ignores the theme entirely.
      { variant: "md", logo: { size: 1, fill: 1, radius: 30, frame: "glass" }, itemRadiusPx: 14, expected: [80, 80, 24, 24] },
      { variant: "md", logo: { size: 1.5, fill: 0.6, radius: 20, frame: "glass" }, itemRadiusPx: 14, expected: [120, 72, 24, 0] },
      { variant: "md", logo: { size: 1, fill: 0.5, radius: 0, frame: "glass" }, itemRadiusPx: 14, expected: [80, 40, 0, 0] },
      // A circle: 50 % of the width.
      { variant: "md", logo: { size: 1, fill: 0.8, radius: 50, frame: "glass" }, itemRadiusPx: 14, expected: [80, 64, 40, 32] },
      // With no plate the mark takes the tile's own rounding — no inset.
      { variant: "md", logo: { size: 1, fill: 0.5, radius: 30, frame: "none" }, itemRadiusPx: 14, expected: [80, 40, 24, 24] },
    ];

    for (const { variant, logo, itemRadiusPx, expected } of table) {
      const geometry = resolveBrandLogoGeometry({ variant, logo, itemRadiusPx });
      const actual = [
        geometry.tilePx,
        geometry.markPx,
        geometry.tileRadiusPx,
        geometry.markRadiusPx,
      ];
      // Exact, because `resolveBrandLogoGeometry` rounds to a hundredth of a
      // pixel on both sides of the mirror precisely so this table can be a
      // table of numbers rather than of floating-point residue.
      expect(actual).toEqual(expected);
    }
  });

  it("never returns a negative mark radius when the inset exceeds the corner", () => {
    // A small mark inside a barely-rounded tile: `r_outer − inset` goes
    // negative, and a negative `border-radius` is invalid CSS the browser
    // discards, taking the whole declaration with it.
    const geometry = resolveBrandLogoGeometry({
      variant: "md",
      logo: { size: 1, fill: 0.4, radius: 5, frame: "glass" },
      itemRadiusPx: 14,
    });
    expect(geometry.markRadiusPx).toBe(0);
  });
});

describe("resolveBrandLogo", () => {
  it("returns the pre-setting rendering when the panel sent nothing", () => {
    // A panel older than this setting writes no `brandLogo` at all. That is a
    // normal state for a split upgrade, not corruption.
    expect(resolveBrandLogo(undefined)).toEqual(DEFAULT_BRAND_LOGO);
    expect(resolveBrandLogo(null)).toEqual(DEFAULT_BRAND_LOGO);
    expect(resolveBrandLogo("glass")).toEqual(DEFAULT_BRAND_LOGO);
  });

  it("clamps every number to its bound instead of rejecting the object", () => {
    expect(
      resolveBrandLogo({ size: 99, fill: -4, frame: "solid", radius: 500, glow: 7 }),
    ).toEqual({ size: 1.75, fill: 0.4, frame: "solid", radius: 50, glow: 1 });
  });

  it("falls back to the familiar plate for a frame this build does not know", () => {
    // The panel owns the vocabulary and ships on its own cadence.
    expect(resolveBrandLogo({ frame: "neon-etched" }).frame).toBe("glass");
  });

  it("keeps the fields it understands when a sibling is unusable", () => {
    const resolved = resolveBrandLogo({ fill: 0.9, size: "big" });
    expect(resolved.fill).toBe(0.9);
    expect(resolved.size).toBe(DEFAULT_BRAND_LOGO.size);
  });
});

describe("EntryBrandTile", () => {
  it("sizes the tile and the mark from the operator's settings", () => {
    state.branding = {
      ...DEFAULT_BRANDING,
      logoUrl: "/uploads/branding/mark.svg",
      brandLogo: { size: 1.5, fill: 0.9, frame: "solid", radius: 10, glow: 0.5 },
    };

    const tile = renderTile("md");
    // 80 × 1.5 = 120; 120 × 0.9 = 108; 120 × 10 % = 12.
    expect(tile.style.width).toBe("120px");
    expect(tile.style.height).toBe("120px");
    expect(tile.style.borderRadius).toBe("12px");

    const mark = host.querySelector<HTMLElement>('[data-brand-logo="image"]');
    expect(mark).not.toBeNull();
    expect(mark?.style.width).toBe("108px");
    expect(mark?.style.height).toBe("108px");
  });

  it("draws the pre-setting geometry for a payload that carries no settings", () => {
    // The upgrade case, and the one that decides whether every existing
    // deployment keeps the look it had.
    const { brandLogo: _dropped, ...withoutSettings } = DEFAULT_BRANDING;
    state.branding = withoutSettings as Branding;

    state.branding = { ...state.branding, logoUrl: "/uploads/branding/mark.svg" };

    const md = renderTile("md");
    expect(md.style.width).toBe("80px");
    // `rounded-3xl` = `calc(var(--radius) * 2.2)` at the stock 14 px item
    // radius. Pinning 24px here — a fixed 30 % of the tile — is what an earlier
    // draft of this change did, and it silently restyled the first screen of
    // every deployment whose theme was not at the default.
    expect(md.style.borderRadius).toBe("30.8px");
    // The mark's own size is asserted alongside the tile's, and it is the
    // assertion that matters: the tile was already 80 px, so a drifted default
    // `fill` would leave everything above green while every existing
    // deployment's logo silently changed size on upgrade. 80 × 0.58 = 46.4.
    expect(host.querySelector<HTMLElement>('[data-brand-logo="image"]')?.style.width).toBe(
      "46.4px",
    );

    act(() => root.render(<EntryBrandTile size="lg" />));
    const lg = host.querySelector<HTMLElement>("[data-entry-brand-tile]");
    expect(lg?.style.width).toBe("96px");
    // The splash tile was the literal `rounded-[28px]` and followed nothing.
    expect(lg?.style.borderRadius).toBe("28px");
    // 96 × 0.58 = 55.68, and the splash tile drew exactly 56 px before the
    // setting existed — the reason 0.58 was chosen over 0.55.
    expect(host.querySelector<HTMLElement>('[data-brand-logo="image"]')?.style.width).toBe(
      "55.68px",
    );
  });

  it("follows the operator's theme radius until they set one of their own", () => {
    // The regression this pins: a deployment with square corners must not wake
    // up rounded, and one at the maximum must not wake up squared off.
    for (const [itemPx, expected] of [
      [0, "0px"],
      [14, "30.8px"],
      [32, "70.4px"],
    ] as const) {
      state.branding = {
        ...DEFAULT_BRANDING,
        cornerRadii: { cardPx: 24, itemPx, pillPx: 9999 },
        brandLogo: { ...DEFAULT_BRAND_LOGO, radius: null },
      };
      expect(renderTile("md").style.borderRadius).toBe(expected);
    }
  });

  it("ignores the theme once the operator sets an explicit radius", () => {
    state.branding = {
      ...DEFAULT_BRANDING,
      cornerRadii: { cardPx: 24, itemPx: 0, pillPx: 9999 },
      brandLogo: { ...DEFAULT_BRAND_LOGO, radius: 50 },
    };
    expect(renderTile("md").style.borderRadius).toBe("40px");
  });

  it("uses the base size of the screen it is on", () => {
    expect(BRAND_LOGO_TILE_BASE_PX.md).toBe(80);
    expect(BRAND_LOGO_TILE_BASE_PX.lg).toBe(96);
    expect(renderTile("lg").style.width).toBe("96px");
  });

  describe("frame", () => {
    it("paints surface and hairline for the glass plate, and blurs behind it", () => {
      state.branding = { ...DEFAULT_BRANDING, brandLogo: { ...DEFAULT_BRAND_LOGO, frame: "glass" } };
      const tile = renderTile();
      expect(tile.style.backgroundColor).toBe("var(--color-surface)");
      expect(tile.style.boxShadow).toContain("inset 0 0 0 1px");
      expect(tile.style.backdropFilter).toBe("blur(24px)");
    });

    it("drops the backdrop filter for the solid plate but keeps the surface", () => {
      // The reason `solid` exists: a backdrop-filtered layer is re-sampled per
      // frame on iOS, and an operator who does not want that cost should not
      // have to give up the plate to avoid it.
      state.branding = { ...DEFAULT_BRANDING, brandLogo: { ...DEFAULT_BRAND_LOGO, frame: "solid" } };
      const tile = renderTile();
      expect(tile.style.backgroundColor).toBe("var(--color-surface)");
      expect(tile.style.backdropFilter).toBe("");
    });

    it("keeps only the hairline for the outline plate", () => {
      state.branding = {
        ...DEFAULT_BRANDING,
        brandLogo: { ...DEFAULT_BRAND_LOGO, frame: "outline" },
      };
      const tile = renderTile();
      expect(tile.style.backgroundColor).toBe("transparent");
      expect(tile.style.boxShadow).toContain("inset 0 0 0 1px");
    });

    it("paints nothing but keeps the box when the plate is turned off", () => {
      // The operator asked for the plate to be removable. Removing the ELEMENT
      // would move the heading and the form up by 80 px on every entry screen;
      // removing only its paint is what "убрать окантовку" has to mean.
      state.branding = { ...DEFAULT_BRANDING, brandLogo: { ...DEFAULT_BRAND_LOGO, frame: "none" } };
      const tile = renderTile();
      expect(tile.style.width).toBe("80px");
      expect(tile.style.backgroundColor).toBe("transparent");
      expect(tile.style.boxShadow).not.toContain("inset");
      expect(tile.style.backdropFilter).toBe("");
    });

    it("gives the mark the tile's own rounding once there is no plate to sit inside", () => {
      state.branding = {
        ...DEFAULT_BRANDING,
        logoUrl: "/uploads/branding/mark.png",
        brandLogo: { ...DEFAULT_BRAND_LOGO, frame: "none", fill: 0.5, radius: 30 },
      };
      renderTile();
      const mark = host.querySelector<HTMLElement>('[data-brand-logo="image"]');
      // Concentric inset would give 24 − 20 = 4 px; with no plate the mark IS
      // the shape, so it takes the full 24.
      expect(mark?.style.borderRadius).toBe("24px");
    });
  });

  describe("glow", () => {
    it("scales the brand glow with the setting", () => {
      state.branding = { ...DEFAULT_BRANDING, brandLogo: { ...DEFAULT_BRAND_LOGO, glow: 0.5 } };
      expect(renderTile().style.boxShadow).toContain("0 0 30px var(--color-brand-glow)");
    });

    it("emits no glow layer at all at zero", () => {
      state.branding = { ...DEFAULT_BRANDING, brandLogo: { ...DEFAULT_BRAND_LOGO, glow: 0 } };
      expect(renderTile().style.boxShadow).not.toContain("brand-glow");
    });
  });

  it("falls back to the built-in mark, sized the same, when no logo is uploaded", () => {
    state.branding = {
      ...DEFAULT_BRANDING,
      logoUrl: null,
      brandLogo: { ...DEFAULT_BRAND_LOGO, size: 1, fill: 0.5 },
    };
    renderTile();
    expect(host.querySelector('[data-brand-logo="image"]')).toBeNull();
    const svg = host.querySelector<SVGElement>("svg");
    expect(svg?.style.width).toBe("40px");
  });
});

describe("CardWatermark", () => {
  const surfaces = [
    { name: "dashboard card", basePx: 160 },
    { name: "tariff card", basePx: 128 },
    { name: "subscription picker", basePx: 96 },
  ] as const;

  it("draws every surface at one opacity for one branding", () => {
    // The defect this replaces: the custom-image branch carried 0.12 while two
    // of its three callers overrode it back to 0.10 and the third did not, so
    // the same uploaded mark was fainter on the dashboard than in the picker.
    const style = { scale: 1, opacity: 0.25 };
    const seen = surfaces.map(({ basePx }) => {
      act(() =>
        root.render(
          <CardWatermark preset="DEFAULT" customUrl="/uploads/branding/wm.png" style={style} basePx={basePx} />,
        ),
      );
      return host.querySelector<HTMLElement>("[data-card-watermark]")?.style.opacity;
    });
    expect(new Set(seen)).toEqual(new Set(["0.25"]));
  });

  it("applies one opacity to the glyph branch and the image branch alike", () => {
    const style = { scale: 1, opacity: 0.3 };
    act(() => root.render(<CardWatermark preset="SHIELD" style={style} basePx={160} />));
    const glyph = host.querySelector<HTMLElement>('[data-card-watermark="glyph"]')?.style.opacity;
    act(() =>
      root.render(<CardWatermark preset="SHIELD" customUrl="/u.png" style={style} basePx={160} />),
    );
    const image = host.querySelector<HTMLElement>('[data-card-watermark="image"]')?.style.opacity;
    expect(glyph).toBe("0.3");
    expect(image).toBe(glyph);
  });

  it("multiplies each surface's own base rather than flattening them to one size", () => {
    for (const { basePx } of surfaces) {
      act(() =>
        root.render(
          <CardWatermark preset="BOLT" style={{ scale: 1.5, opacity: 0.1 }} basePx={basePx} />,
        ),
      );
      const mark = host.querySelector<HTMLElement>("[data-card-watermark]");
      expect(mark?.style.width).toBe(`calc(var(--card-watermark-base, ${basePx}px) * 1.5)`);
    }
  });

  it("draws the pre-setting weight when the panel sent no style", () => {
    act(() => root.render(<CardWatermark preset="DEFAULT" basePx={160} />));
    expect(host.querySelector<HTMLElement>("svg")?.style.opacity).toBe("0.1");
  });

  it("still renders nothing for the operator's explicit NONE", () => {
    // `opacity` has a floor of 0.02 precisely so that "invisible" stays one
    // decision made in one place; this is that place.
    act(() => root.render(<CardWatermark preset="NONE" style={{ scale: 2, opacity: 0.4 }} basePx={160} />));
    expect(host.querySelector("[data-card-watermark]")).toBeNull();
    expect(host.querySelector("svg")).toBeNull();
  });

  it("clamps a malformed style instead of dropping the mark", () => {
    expect(resolveCardLogoStyle({ scale: 40, opacity: 9 })).toEqual({ scale: 2, opacity: 0.4 });
    expect(resolveCardLogoStyle(undefined)).toEqual({ scale: 1, opacity: 0.1 });
    // The FLOORS, which the ceilings above cannot speak for. The opacity floor
    // is the one that matters: it is what keeps "invisible" a decision made in
    // the glyph picker, where the operator can see they made it, instead of a
    // state reachable by dragging a slider that still claims a mark is on.
    expect(resolveCardLogoStyle({ scale: 0.01, opacity: 0 })).toEqual({
      scale: 0.5,
      opacity: 0.02,
    });
    expect(resolveCardLogoStyle({ scale: -3, opacity: -1 })).toEqual({
      scale: 0.5,
      opacity: 0.02,
    });
  });

  it("clamps at the component, not only in the resolver", () => {
    // The seam. `resolveCardLogoStyle` is tested directly above and the
    // component is tested with well-formed input everywhere else, so a
    // component that stopped calling the resolver — or inlined
    // `style?.opacity ?? 0.1` — kept every one of those cases green while a
    // stored `opacity: 0` reached a real card.
    act(() =>
      root.render(
        <CardWatermark
          preset="SHIELD"
          style={{ scale: 99, opacity: 0 } as never}
          basePx={160}
        />,
      ),
    );
    const mark = host.querySelector<HTMLElement>("[data-card-watermark]");
    expect(mark?.style.opacity).toBe("0.02");
    expect(mark?.style.width).toBe("calc(var(--card-watermark-base, 160px) * 2)");
  });

  it("honours size and presence on the branch the shipped default takes", () => {
    // `DEFAULT_BRANDING.cardLogo` is `"DEFAULT"`, which reaches neither the
    // image branch nor the Lucide map — it reaches the Reiwa mark. That is the
    // commonest configuration in production and it was the one branch with no
    // case of its own, so the operator's two controls could have done nothing
    // at all there while the suite stayed green.
    act(() =>
      root.render(
        <CardWatermark preset="DEFAULT" style={{ scale: 1.5, opacity: 0.3 }} basePx={160} />,
      ),
    );
    const mark = host.querySelector<HTMLElement>('[data-card-watermark="mark"]');
    expect(mark, "the default watermark branch carries no data hook").not.toBeNull();
    expect(mark?.style.opacity).toBe("0.3");
    expect(mark?.style.width).toBe("calc(var(--card-watermark-base, 160px) * 1.5)");
  });
});
