import { describe, expect, it } from "vitest";

import { describePublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port";
import {
  GLOBE_CATALOG,
  GLOBE_VARIANTS,
  resolveGlobePreferences,
} from "@/components/reactbits/originkit/globe-preferences";
import {
  hasPanel,
  hasPanelRepo,
  loadPanelBundle,
  missingPanelModules,
  PANEL_REPO_PATH,
  type PanelBundle,
} from "./panel-modules";

/**
 * The operator's globe choice, from the control that sets it to the planet a
 * subscriber sees.
 *
 * WHY, GIVEN THE OTHERS EXIST. Because "the panel saves and the cabinet does not
 * change" has now been reported twice about two different branding payloads, and
 * both times every module was individually covered while the SEAM between them
 * was not. This is a new payload crossing the same six stages; it gets the same
 * treatment on the way in rather than after somebody notices.
 *
 * The globe carries one thing the earlier payloads did not: a `props` record
 * whose meaning depends on a sibling field. `globe` has a graticule colour,
 * `dither-globe` has a pixel size, and neither means anything to the other — so
 * the interesting cases here are not "does the value survive" but "does it stay
 * attached to the planet it belongs to".
 */

let panel: PanelBundle;
if (hasPanel) panel = await loadPanelBundle();

const VALIDATION_MESSAGES = {
  hexInvalid: "hex-invalid",
  imageUrlInvalid: "image-url-invalid",
  gradientInvalid: "gradient-invalid",
} as const;

interface RoundTripResult {
  readonly rejectedBy: string | null;
  readonly reason: string | null;
  /** What the cabinet resolves, after clamping — i.e. what actually renders. */
  readonly resolved: ReturnType<typeof resolveGlobePreferences> | null;
}

/** Push one globe block through panel → API → cabinet, exactly as production does. */
function roundTrip(
  block: Record<string, unknown>,
  saved: Record<string, unknown> = { enabled: true, variant: "globe", props: {} },
): RoundTripResult {
  const schema = panel.schema.createBrandingFormSchema(VALIDATION_MESSAGES);
  const baseline = panel.schema.createInitialBrandingDraft({ serversGlobe: saved });
  const values = { ...baseline, serversGlobe: block };

  const dirtyFields = panel.schema.getBrandingChangedFields(values, baseline);
  const patch = panel.schema.createBrandingDirtyPatch({ values, dirtyFields, schema });
  if (!patch.success) {
    return {
      rejectedBy: "panel Zod schema",
      reason: patch.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" | "),
      resolved: null,
    };
  }
  // The HTTP boundary, where an `undefined` disappears.
  const body = JSON.parse(JSON.stringify(patch.data)) as Record<string, unknown>;

  const instance = panel.plainToInstance(panel.dto.UpdateBrandingSettingsDto, body);
  const errors = panel.validateSync(instance as object, { whitelist: false });
  if (errors.length > 0) {
    return {
      rejectedBy: "backend DTO",
      reason: errors
        .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(", ")}`)
        .join(" | "),
      resolved: null,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(instance, "serversGlobe")) {
    return {
      rejectedBy: "changed-field gate",
      reason: "serversGlobe is not an own property of the DTO instance, so the update is a no-op",
      resolved: null,
    };
  }

  const stored = panel.persistence.mergeBrandingSettings({
    existing: { serversGlobe: saved },
    patch: body,
  });
  const branding = panel.persistence.readBrandingSettings(stored);
  const wire = JSON.parse(JSON.stringify(branding)) as Record<string, unknown>;

  const rejection = describePublicConfigSnapshot({
    branding: wire,
    locales: ["en"],
    defaultLocale: "en",
    defaultCurrency: "USD",
    customIcons: [],
    botUsername: null,
    supportUsername: null,
    platformBranding: { projectName: null, webTitle: null },
    emailEnabled: false,
  });
  if (rejection !== null) {
    return {
      rejectedBy: "cabinet snapshot guard",
      reason: `${rejection.key}: ${rejection.reason} (found ${rejection.found}) — the ENTIRE branding snapshot is discarded`,
      resolved: null,
    };
  }

  return {
    rejectedBy: null,
    reason: null,
    resolved: resolveGlobePreferences(wire.serversGlobe),
  };
}

function survive(
  block: Record<string, unknown>,
  saved?: Record<string, unknown>,
): NonNullable<RoundTripResult["resolved"]> {
  const result = roundTrip(block, saved);
  expect(
    result.rejectedBy,
    `${JSON.stringify(block)} was refused by the ${result.rejectedBy}: ${result.reason}`,
  ).toBeNull();
  expect(result.resolved).not.toBeNull();
  return result.resolved as NonNullable<RoundTripResult["resolved"]>;
}

describe("servers globe round trip, panel → API → cabinet", () => {
  it("reaches both checkouts", () => {
    console.info(
      hasPanel
        ? `servers-globe round trip: driving the panel at ${PANEL_REPO_PATH}`
        : `servers-globe round trip: no sibling checkout at ${PANEL_REPO_PATH} — cases skip`,
    );
    if (hasPanelRepo) {
      expect(
        missingPanelModules,
        `the rezeis-admin checkout is at ${PANEL_REPO_PATH} but these are missing — every case below is skipping instead of guarding`,
      ).toEqual([]);
    }
    expect(typeof resolveGlobePreferences).toBe("function");
  });

  describe.skipIf(!hasPanel)("what the operator set", () => {
    it.each(GLOBE_VARIANTS)("delivers the '%s' planet", (variant) => {
      // The saved baseline differs in `enabled`, so every variant is a real
      // edit. Submitting a block identical to what is stored produces no dirty
      // field at all — correctly, since the panel sends only what changed —
      // and the case would then be testing an empty patch.
      const resolved = survive(
        { enabled: true, variant, props: {} },
        { enabled: false, variant, props: {} },
      );
      expect(resolved.variant).toBe(variant);
      expect(resolved.enabled).toBe(true);
    });

    it("delivers a changed setting, and leaves the rest at their defaults", () => {
      const resolved = survive({
        enabled: true,
        variant: "globe",
        props: { speed: 6, oceanColor: "#101018" },
      });
      expect(resolved.props["speed"]).toBe(6);
      expect(resolved.props["oceanColor"]).toBe("#101018");
      // Everything the operator did not touch still arrives, at the shipped
      // value — the cabinet never renders with a prop missing.
      expect(Object.keys(resolved.props).sort()).toEqual(
        Object.keys(GLOBE_CATALOG.globe.props).sort(),
      );
    });

    it("turns the gesture off", () => {
      const resolved = survive({ enabled: false, variant: "globe", props: {} });
      expect(resolved.enabled).toBe(false);
    });

    it("does not carry one planet's tuning onto another", () => {
      // The props belong to the variant. `graticuleColor` means nothing to the
      // dithered sphere, and delivering it would configure a planet with a
      // setting it has no control for.
      const resolved = survive(
        { enabled: true, variant: "dither-globe", props: { pixel: 8 } },
        { enabled: true, variant: "globe", props: { graticuleColor: "#FF0000" } },
      );
      expect(resolved.variant).toBe("dither-globe");
      expect(resolved.props["pixel"]).toBe(8);
      expect(resolved.props["graticuleColor"]).toBeUndefined();
    });
  });

  describe.skipIf(!hasPanel)("what a newer panel can send", () => {
    it("stores a planet this cabinet has never heard of, and falls back to draw", () => {
      // The panel ships first. A variant it introduces has to survive storage
      // and reach the cabinet, which shows the default until it catches up —
      // refusing it anywhere upstream would stop the operator saving at all.
      const resolved = survive({ enabled: true, variant: "hologlobe", props: {} });
      expect(resolved.variant).toBe("globe");
      expect(resolved.enabled).toBe(true);
    });

    it("clamps a value outside this cabinet's range instead of dropping it", () => {
      const resolved = survive({ enabled: true, variant: "globe", props: { speed: 999 } });
      expect(resolved.props["speed"]).toBe(GLOBE_CATALOG.globe.props.speed.max);
    });

    it("drops a setting this cabinet has no control for, without throwing", () => {
      // The panel ships first, so a prop it introduces arrives here named but
      // unknown. Reading `specs[name]` for it yields `undefined`, and the very
      // next line asks for `.kind` — so the difference between dropping it and
      // not is a TypeError inside the render of a screen a customer just
      // opened, for every subscriber of every operator on the newer panel.
      const resolved = survive({
        enabled: true,
        variant: "globe",
        props: { speed: 4, ringGlow: 9 },
      });
      expect(resolved.props["speed"]).toBe(4);
      expect(resolved.props["ringGlow"]).toBeUndefined();
    });

    it("never lets a malformed block discard the whole snapshot", () => {
      // The cabinet's guard is all-or-nothing: anything it refuses freezes the
      // entire cabinet appearance. This field is deliberately not validated
      // there, because its reader is total — and this is the assertion that
      // says so, so adding a validator later fails here rather than in
      // production.
      const result = roundTrip({ enabled: true, variant: "globe", props: { speed: 4 } });
      expect(result.rejectedBy).not.toBe("cabinet snapshot guard");
    });
  });

  describe("the cabinet reader on its own", () => {
    // Reachable without the panel at all: this is the last line of defence, and
    // a customer's screen is what fails if it throws. Nothing upstream can be
    // relied on here — an old stored row, a hand-edited database, a future
    // panel — so it is checked against inputs the panel would never send.
    it.each([null, undefined, 0, "nonsense", [], true])(
      "answers a complete configuration for %p",
      (garbage) => {
        const resolved = resolveGlobePreferences(garbage);
        expect(resolved.variant).toBe("globe");
        expect(resolved.enabled).toBe(true);
        expect(Object.keys(resolved.props).sort()).toEqual(
          Object.keys(GLOBE_CATALOG.globe.props).sort(),
        );
      },
    );

    it("is not fooled by a prop named after something on the prototype", () => {
      // `specs[name]` for `constructor` answers a FUNCTION off the prototype
      // rather than `undefined`, so a plain lookup would treat it as a real
      // control and read `.kind` off `Object`. `Object.hasOwn` is what makes
      // this an ordinary unknown name.
      //
      // It cannot arrive through the API — `class-transformer` throws on that
      // key while building the DTO, before any validator runs — so this is the
      // only place the behaviour can be pinned at all.
      const resolved = resolveGlobePreferences({
        variant: "globe",
        props: { constructor: 1, __proto__: 2, toString: 3 },
      });
      // The catalogue's own names, exactly — nothing from the prototype joined
      // them, and nothing they displaced went missing.
      expect(Object.keys(resolved.props).sort()).toEqual(
        Object.keys(GLOBE_CATALOG.globe.props).sort(),
      );
    });

    it("keeps a prop the operator set and defaults the rest", () => {
      const resolved = resolveGlobePreferences({ variant: "globe", props: { speed: 7 } });
      expect(resolved.props["speed"]).toBe(7);
      expect(resolved.props["scale"]).toBe(GLOBE_CATALOG.globe.props.scale.default);
    });
  });

  describe.skipIf(!hasPanel)("what the API refuses on its own", () => {
    /** The DTO alone, with no panel schema in front of it. */
    const dtoRejects = (block: unknown): boolean => {
      const instance = panel.plainToInstance(panel.dto.UpdateBrandingSettingsDto, {
        serversGlobe: block,
      });
      return panel.validateSync(instance as object, { whitelist: false }).length > 0;
    };

    // These cases exist because the panel's own schema refuses the same values
    // one stage earlier, which means the round trip above passes whether the
    // API validates or not. The API is a public surface with other clients —
    // the bot, a script, a future integration — and it has to refuse on its own
    // rather than trust that the browser already did.
    it("accepts what the panel sends", () => {
      expect(dtoRejects({ enabled: true, variant: "globe", props: { speed: 4 } })).toBe(false);
      expect(dtoRejects({ enabled: false, variant: "dither-globe", props: {} })).toBe(false);
      // A planet from a newer panel: storable on purpose.
      expect(dtoRejects({ enabled: true, variant: "hologlobe", props: {} })).toBe(false);
    });

    it("refuses a variant that is not a slug", () => {
      expect(dtoRejects({ variant: "Globe Mesh!" })).toBe(true);
      expect(dtoRejects({ variant: 7 })).toBe(true);
    });

    it("refuses a prop that no control could produce", () => {
      expect(dtoRejects({ props: { dots: { size: 4 } } })).toBe(true);
      expect(dtoRejects({ props: { colors: [1, 2] } })).toBe(true);
      expect(dtoRejects({ props: { label: "x".repeat(200) } })).toBe(true);
    });

    it("refuses a field that is not part of the block", () => {
      // An unknown key is a caller sending something this API does not
      // implement. Storing it would put arbitrary JSON on the public config.
      expect(dtoRejects({ enabled: true, variant: "globe", props: {}, extra: 1 })).toBe(true);
    });

    it("refuses an enabled flag that is not a boolean", () => {
      expect(dtoRejects({ enabled: "yes" })).toBe(true);
    });
  });

  describe.skipIf(!hasPanel)("what the panel refuses to send", () => {
    it("refuses a variant that is not a slug", () => {
      // The reader would drop it and answer `200 OK`, and the operator would
      // find the planet reverted with nothing to point at.
      expect(roundTrip({ enabled: true, variant: "Globe Mesh!", props: {} }).rejectedBy).not.toBeNull();
    });

    it("refuses a prop that is not a scalar", () => {
      expect(
        roundTrip({ enabled: true, variant: "globe", props: { dots: { size: 4 } } }).rejectedBy,
      ).not.toBeNull();
    });
  });
});
