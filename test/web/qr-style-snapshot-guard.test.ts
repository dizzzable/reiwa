import { describe, expect, it } from "vitest";

import { describePublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port";
import { QR_STYLE_PLAIN, isUsableDark, resolveQrStyle } from "@/lib/qr-style";
import {
  DEFAULT_BRANDING,
  DEFAULT_PUBLIC_CONFIG,
  resolveBrandingThemeMode,
  type Branding,
  type BrandingThemeVariant,
} from "@/types/branding";

/**
 * The operator's QR style on the cabinet side of the wire: what the snapshot
 * guard does with it, and what reaches a component.
 *
 * ONLY THE READER HALF. The precedent is `servers-globe-round-trip.test.ts`,
 * which drives the panel's form, DTO and persistence before the guard. The
 * panel's half of `qrStyle` is being written separately, and the round trip
 * through it belongs after both sides have landed — so nothing here loads the
 * sibling checkout, and every case runs in CI.
 *
 * THE CASE THAT MATTERS is the first `describe`. `describePublicConfigSnapshot`
 * is all-or-nothing: the first key it refuses discards the ENTIRE branding
 * snapshot, and the cabinet then serves the previous one indefinitely — every
 * colour, logo and text — while the panel goes on reporting successful saves.
 * `qrStyle` is deliberately NOT validated there, because its only reader,
 * `resolveQrStyle`, is total: any input at all comes back as a style that is
 * safe to draw. A refusal would protect nothing and cost the operator their
 * whole identity. These cases are what fails if somebody "completes" the guard.
 */

/** The cabinet's own default public config, as it crosses the wire: JSON drops every `undefined`. */
const WIRE = JSON.parse(JSON.stringify(DEFAULT_PUBLIC_CONFIG)) as Record<string, unknown> & {
  readonly branding: Record<string, unknown>;
};

function withBranding(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...WIRE, branding: { ...WIRE.branding, ...overrides } };
}

/**
 * Values a reader must survive, none of which the guard may refuse. Parsed from
 * JSON where it matters: `constructor` and `__proto__` are OWN keys when they
 * arrive off the wire, which an object literal in this file cannot express.
 */
const MALFORMED: ReadonlyArray<readonly [string, unknown]> = [
  ["a bare word instead of a block", "dots"],
  ["shapes this build has never heard of", { modules: "hearts", eyes: "teardrop" }],
  [
    "keys named after the prototype",
    JSON.parse('{"constructor":{"modules":"dots"},"__proto__":{"dark":"#1e3a8a"},"modules":"hearts"}'),
  ],
  ["a light module colour, which would be white on the white plate", { dark: "#ffffff" }],
  ["a colour name rather than a hex colour", { modules: "rounded", dark: "navy" }],
  [
    "a field only a newer panel knows",
    { modules: "dots", eyes: "rounded", dark: "#1e3a8a", logo: { url: "https://example.com/l.png" } },
  ],
  ["null", null],
  ["a number", 7],
  ["an array", ["dots", "rounded"]],
];

describe("the snapshot guard never refuses a QR style", () => {
  it("starts from a snapshot it accepts, with no qrStyle — an old panel's shape", () => {
    // Anti-vacuous anchor: if the fixture were refused for some other reason,
    // every "accepted" below would be comparing against a rejection it never
    // got to. And the absent key is itself the old-panel case.
    expect(describePublicConfigSnapshot(WIRE)).toBeNull();
    expect(Object.hasOwn(WIRE.branding, "qrStyle")).toBe(false);
    expect(resolveQrStyle(WIRE.branding["qrStyle"])).toEqual(QR_STYLE_PLAIN);
  });

  it("is a guard that still refuses things, so its acceptance below means something", () => {
    // A guard that accepted everything would pass every case in this file.
    expect(describePublicConfigSnapshot(withBranding({ borderRadius: "rounded-md" }))).not.toBeNull();
  });

  it("lets the operator's style through untouched", () => {
    const raw = { modules: "dots", eyes: "rounded", dark: "#1E3A8A" };
    expect(describePublicConfigSnapshot(withBranding({ qrStyle: raw }))).toBeNull();
    expect(resolveQrStyle(raw)).toEqual({ modules: "dots", eyes: "rounded", dark: "#1e3a8a" });
  });

  it.each(MALFORMED)("lets %s through, and the reader answers with a safe style", (_label, raw) => {
    const rejection = describePublicConfigSnapshot(withBranding({ qrStyle: raw }));
    expect(
      rejection,
      `refused as ${rejection?.key}: ${rejection?.reason} (found ${rejection?.found}) — ` +
        "that discards the ENTIRE branding snapshot and freezes the cabinet on the previous one, " +
        "over the shape of a QR code whose reader cannot be fooled",
    ).toBeNull();

    // The other half of the bargain: accepting is only safe because this
    // answers everything with something drawable.
    const style = resolveQrStyle(raw);
    expect(["square", "rounded", "dots"]).toContain(style.modules);
    expect(["square", "rounded"]).toContain(style.eyes);
    expect(isUsableDark(style.dark), `${JSON.stringify(raw)} resolved to ${style.dark}`).toBe(true);
  });
});

describe("the brightness resolver carries the style to the components", () => {
  // `resolveBrandingThemeMode` REBUILDS the branding object whenever a concept
  // has light/dark variants — it is the object `useBranding()` hands out. It
  // spreads the root today; a field it stopped carrying would be absent for
  // exactly the operators who use variants, and present for everyone else.
  const variant: BrandingThemeVariant = {
    primary: DEFAULT_BRANDING.primary,
    primaryFg: DEFAULT_BRANDING.primaryFg,
    bgPrimary: DEFAULT_BRANDING.bgPrimary,
    bgSecondary: DEFAULT_BRANDING.bgSecondary,
    cardGradient: DEFAULT_BRANDING.cardGradient,
    cardPattern: DEFAULT_BRANDING.cardPattern,
    cardEffect: DEFAULT_BRANDING.cardEffect,
    cardEffectProps: {},
    cardEffectOpacity: 1,
    cardEffectsByIndex: [],
    bgEffect: DEFAULT_BRANDING.bgEffect,
    appBackground: DEFAULT_BRANDING.appBackground!,
    borderRadius: DEFAULT_BRANDING.borderRadius,
    cornerRadii: DEFAULT_BRANDING.cornerRadii!,
    fontFamily: DEFAULT_BRANDING.fontFamily,
    surfaceTheme: DEFAULT_BRANDING.surfaceTheme!,
  };

  it.each(["light", "dark"] as const)("keeps it in the %s rendering", (mode) => {
    const raw = { modules: "rounded", eyes: "rounded", dark: "#1e3a8a" };
    const branding: Branding = {
      ...DEFAULT_BRANDING,
      qrStyle: raw,
      themeVariants: { light: variant, dark: variant },
    };
    // Positive control that the variant path is the one being run: the
    // resolver answered with a DIFFERENT object, rebuilt, not the input.
    const effective = resolveBrandingThemeMode(branding, mode);
    expect(effective).not.toBe(branding);
    expect(effective.qrStyle).toEqual(raw);
  });
});
