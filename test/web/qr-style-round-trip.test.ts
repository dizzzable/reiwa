import { describe, expect, it } from "vitest";

import { describePublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port";
import {
  QR_STYLE_PLAIN,
  isPlainStyle,
  isUsableDark,
  resolveQrStyle,
  type QrStyle,
} from "@/lib/qr-style";
import {
  hasPanel,
  hasPanelRepo,
  loadPanelBundle,
  missingPanelModules,
  PANEL_REPO_PATH,
  type PanelBundle,
} from "./panel-modules";

/**
 * The operator's QR style, from the control that sets it to the code a
 * subscriber scans.
 *
 * WHY, GIVEN THE MODULE TESTS. The branding save path has five places where a
 * new field vanishes without an error: a changed-field list that does not name
 * it, a tab router that does not know it, a cabinet guard that throws the whole
 * brand away, a form draft that lacks it, and a zod object that strips it. In
 * each of them the operator is told "Saved" and watches the value revert. Every
 * module can be covered on its own while the seam between them is not — so this
 * drives the real modules of BOTH repositories, end to end.
 *
 * CI checks out the cabinet alone, so there every panel-driven case SKIPS and
 * only "the cabinet reader on its own" runs. Run this locally, with the panel
 * checked out next to the cabinet, before releasing either side of this field.
 */

let panel: PanelBundle;
if (hasPanel) panel = await loadPanelBundle();

const VALIDATION_MESSAGES = {
  hexInvalid: "hex-invalid",
  imageUrlInvalid: "image-url-invalid",
  gradientInvalid: "gradient-invalid",
  qrDarkTooLight: "qr-dark-too-light",
} as const;

/** The API's own settings: the global ValidationPipe in `main.ts` runs exactly like this. */
const STRICT = { whitelist: true, forbidNonWhitelisted: true } as const;

interface RoundTripResult {
  readonly rejectedBy: string | null;
  readonly reason: string | null;
  /** What the cabinet resolves — i.e. what the subscriber's code is drawn with. */
  readonly resolved: QrStyle | null;
}

const refused = (by: string, reason: string): RoundTripResult => ({
  rejectedBy: by,
  reason,
  resolved: null,
});

/** Push one style through panel form → API → storage → cabinet, as production does. */
function roundTrip(
  block: Record<string, unknown>,
  saved: Record<string, unknown> = { ...QR_STYLE_PLAIN },
): RoundTripResult {
  const schema = panel.schema.createBrandingFormSchema(VALIDATION_MESSAGES);
  const baseline = panel.schema.createInitialBrandingDraft({ qrStyle: saved });
  const values = { ...baseline, qrStyle: block };

  const dirtyFields = panel.schema.getBrandingChangedFields(values, baseline);
  const patch = panel.schema.createBrandingDirtyPatch({ values, dirtyFields, schema });
  if (!patch.success) {
    return refused(
      "panel Zod schema",
      patch.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" | "),
    );
  }
  // The HTTP boundary, where an `undefined` disappears.
  const body = JSON.parse(JSON.stringify(patch.data)) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(body, "qrStyle")) {
    // Gates four and five: a draft without the field finds nothing changed, and
    // a schema that does not know it strips it. Either way nothing is sent.
    return refused("panel form", "the request body carries no qrStyle — nothing would be saved");
  }

  const instance = panel.plainToInstance(panel.dto.UpdateBrandingSettingsDto, body);
  const errors = panel.validateSync(instance, STRICT);
  if (errors.length > 0) {
    return refused(
      "backend DTO",
      errors
        .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(", ")}`)
        .join(" | "),
    );
  }
  if (!Object.prototype.hasOwnProperty.call(instance, "qrStyle")) {
    return refused("backend DTO", "qrStyle is not an own property of the DTO instance");
  }

  const stored = panel.persistence.mergeBrandingSettings({
    existing: { qrStyle: saved },
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
    return refused(
      "cabinet snapshot guard",
      `${rejection.key}: ${rejection.reason} (found ${rejection.found}) — the ENTIRE branding snapshot is discarded`,
    );
  }

  return { rejectedBy: null, reason: null, resolved: resolveQrStyle(wire.qrStyle) };
}

function survive(block: Record<string, unknown>, saved?: Record<string, unknown>): QrStyle {
  const result = roundTrip(block, saved);
  expect(
    result.rejectedBy,
    `${JSON.stringify(block)} was refused by the ${result.rejectedBy}: ${result.reason}`,
  ).toBeNull();
  return result.resolved as QrStyle;
}

const BRAND_NAVY: QrStyle = { modules: "dots", eyes: "rounded", dark: "#1e3a8a" };

describe("QR style round trip, panel → API → cabinet", () => {
  it("reaches both checkouts", () => {
    console.info(
      hasPanel
        ? `qr-style round trip: driving the panel at ${PANEL_REPO_PATH}`
        : `qr-style round trip: no sibling checkout at ${PANEL_REPO_PATH} — cases skip`,
    );
    if (hasPanelRepo) {
      expect(
        missingPanelModules,
        `the rezeis-admin checkout is at ${PANEL_REPO_PATH} but these are missing — every case below is skipping instead of guarding`,
      ).toEqual([]);
    }
    expect(typeof resolveQrStyle).toBe("function");
  });

  describe.skipIf(!hasPanel)("the owner's rule: plain unless the operator chose otherwise", () => {
    it("opens the form on the plain code", () => {
      expect(panel.schema.createInitialBrandingDraft({}).qrStyle).toEqual(QR_STYLE_PLAIN);
    });

    it("delivers the plain code from a panel that never stored a style", () => {
      const wire = JSON.parse(JSON.stringify(panel.persistence.readBrandingSettings({}))) as {
        qrStyle?: unknown;
      };
      expect(resolveQrStyle(wire.qrStyle)).toEqual(QR_STYLE_PLAIN);
    });
  });

  describe.skipIf(!hasPanel)("what the operator set", () => {
    const STYLES: ReadonlyArray<readonly [string, QrStyle]> = [
      ["rounded modules", { modules: "rounded", eyes: "square", dark: "#000000" }],
      ["dots, rounded eyes, brand navy", BRAND_NAVY],
      // The palest grey the contrast floor lets through: 7.00:1 against white.
      ["rounded eyes at the contrast floor", { modules: "square", eyes: "rounded", dark: "#595959" }],
    ];

    it.each(STYLES)("delivers %s", (_name, style) => {
      expect(survive({ ...style })).toEqual(style);
    });

    it("delivers a colour however the operator typed it", () => {
      // The panel stores what was typed; the cabinet reads `#1E3A8A` and
      // `#123` like their canonical forms. Nothing between them may refuse the
      // spelling on the way.
      expect(survive({ modules: "rounded", eyes: "square", dark: "#1E3A8A" }).dark).toBe("#1e3a8a");
      expect(survive({ modules: "rounded", eyes: "square", dark: "#123" }).dark).toBe("#112233");
    });

    it("goes back to the plain code", () => {
      // The reset the section offers. From a styled saved row, so it is a real edit.
      const resolved = survive({ ...QR_STYLE_PLAIN }, { ...BRAND_NAVY });
      expect(isPlainStyle(resolved)).toBe(true);
    });
  });

  describe.skipIf(!hasPanel)("what is refused, and where", () => {
    it("refuses a colour too light to scan in the form, where the operator can see why", () => {
      // WCAG's 4.5:1 grey — the one that failed to decode through the camera model.
      const result = roundTrip({ modules: "square", eyes: "square", dark: "#767676" });
      expect(result.rejectedBy, "a too-light colour got past the panel form").toBe("panel Zod schema");
    });

    /** The DTO alone, with no panel form in front of it — the API has other callers. */
    const dtoRejects = (block: unknown): boolean => {
      const instance = panel.plainToInstance(panel.dto.UpdateBrandingSettingsDto, {
        qrStyle: block,
      });
      return panel.validateSync(instance, STRICT).length > 0;
    };

    it("the API refuses on its own what the form would have refused", () => {
      expect(dtoRejects({ ...QR_STYLE_PLAIN })).toBe(false);
      expect(dtoRejects({ ...BRAND_NAVY })).toBe(false);
      expect(dtoRejects({ modules: "square", eyes: "square", dark: "#595959" })).toBe(false);

      expect(dtoRejects({ modules: "square", eyes: "square", dark: "#767676" })).toBe(true);
      expect(dtoRejects({ modules: "hearts", eyes: "square", dark: "#000000" })).toBe(true);
      // Half a block would replace the stored one whole and wipe the other two.
      expect(dtoRejects({ modules: "dots" })).toBe(true);
      expect(dtoRejects({ ...QR_STYLE_PLAIN, extra: 1 })).toBe(true);
    });

    it("answers a key named after the prototype with no crash, even without the HTTP pipe", () => {
      // In production Nest's ValidationPipe deletes such keys before
      // class-transformer runs; here there is no pipe, and a nested DTO class
      // still must not throw — `serversGlobe`'s bare record does.
      expect(() => dtoRejects({ ...QR_STYLE_PLAIN, constructor: 1 })).not.toThrow();
    });
  });

  describe("the cabinet reader on its own", () => {
    // Runs without the panel too — in CI this is all that runs. An old panel
    // sends no `qrStyle` at all; a hand-edited row can send anything.
    it.each([undefined, null, 0, "dots", [], true, { modules: "hearts" }, { dark: "#ffffff" }])(
      "answers a scannable style for %p",
      (garbage) => {
        const style = resolveQrStyle(garbage);
        expect(["square", "rounded", "dots"]).toContain(style.modules);
        expect(["square", "rounded"]).toContain(style.eyes);
        expect(isUsableDark(style.dark)).toBe(true);
      },
    );

    it("answers the plain code when the key is missing — an older panel", () => {
      expect(resolveQrStyle(undefined)).toEqual(QR_STYLE_PLAIN);
    });
  });
});
